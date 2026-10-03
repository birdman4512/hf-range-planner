// app.js — UI bootstrap and orchestration. Imports the pure engine modules and
// wires them to the Leaflet map and the sidebar controls.

import {
  subsolarPoint, destinationPoint, cosZenith, greatCircleKm, bearingDeg,
  maidenheadToLatLon, latLonToMaidenhead,
} from './src/geo.js';
import { fetchSpaceWeather, fetchForecast, fetchIonosondes, flareClass } from './src/solar.js';
import { BANDS, MODES, modeByName } from './src/bands.js';
import { ionoField } from './src/iono.js';
import { parseStations } from './src/assimilate.js';
import { ANTENNAS, antennaById } from './src/antenna.js';
import { NOISE_ENVIRONMENTS, noiseEnvById } from './src/noise.js';
import {
  preparePath, evalPath, analyzePath, coverageGrids, statusFor,
} from './src/propagation.js';
import { SURFACE } from './src/clutter.js';
import {
  makeTerminator, makeKc2gOverlay, makeFootprintRaster, makeBestBandRaster, makePath,
  makeIonosondeMarkers, makeLegend, escapeHtml,
} from './src/overlays.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  mode: 'coverage',
  view: 'bands',           // coverage view: 'bands' (selected bands) | 'best' (best band everywhere)
  tx: null, a: null, b: null,
  picking: null,
  timeUTC: new Date(),
  anchorTime: Date.now(),
  forecast: [],
  liveSolar: null,
  stations: null,          // parsed ionosonde observations (or null)
  activeBands: new Set(),
  bandLayers: {},
  prepCache: { key: '', map: new Map() },
  markers: { tx: null, a: null, b: null },
  layers: { terminator: null, kc2g: null, result: null, bandCoverage: null, iono: null },
  legend: null,
  restoring: false,        // suppress re-renders while applying saved/shared state
  tokens: { coverage: 0, pathCoverage: 0 },
};

const PIN_LABEL = { tx: 'TX', a: 'A', b: 'B' };
const pinIcon = (which) => L.divIcon({
  className: 'pin-wrap',
  html: `<span class="pin pin-${which}">${PIN_LABEL[which]}</span>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
});
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// --- Map -----------------------------------------------------------------

function initMap() {
  // No worldCopyJump: overlays are drawn on world copies ourselves, and the
  // jump-recentre it does caused a visible flicker when panning across ±180°.
  // Zoom control on the right so it doesn't sit under the collapse/expand button.
  state.map = L.map('map', { minZoom: 2, zoomControl: false }).setView([30, 0], 3);
  L.control.zoom({ position: 'topright' }).addTo(state.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, attribution: '© OpenStreetMap contributors',
  }).addTo(state.map);
  state.legend = makeLegend().addTo(state.map);

  state.map.on('click', (e) => {
    const p = { lat: +e.latlng.lat.toFixed(3), lon: +wrapLon(e.latlng.lng).toFixed(3) };
    if (state.picking) {
      setPoint(state.picking, p);
      state.picking = null;
      return;
    }
    if (state.mode === 'coverage' && state.tx) inspectPoint(p, e.latlng);
  });
}

// Pins are mirrored onto adjacent world copies so they stay visible as the map
// wraps (the main pin is draggable; the ghosts just follow).
const GHOST_OFFSETS = [-360, 360];

function showCoords(which) {
  const p = state[which];
  $(`${which}-coords`).textContent = p
    ? `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)} · ${latLonToMaidenhead(p.lat, p.lon)}`
    : 'not set';
  const card = $(`site-${which}`);
  if (card) card.classList.toggle('is-set', !!p);
}

function setPoint(which, p) {
  state[which] = p;
  showCoords(which);

  const entry = state.markers[which];
  if (entry) {
    entry.main.setLatLng([p.lat, p.lon]);
    entry.ghosts.forEach((g, i) => g.setLatLng([p.lat, p.lon + GHOST_OFFSETS[i]]));
  } else {
    const main = L.marker([p.lat, p.lon], { draggable: true, icon: pinIcon(which) }).addTo(state.map);
    const syncGhosts = (lat, lon) =>
      state.markers[which].ghosts.forEach((g, i) => g.setLatLng([lat, lon + GHOST_OFFSETS[i]]));
    main.on('drag', () => { const ll = main.getLatLng(); syncGhosts(ll.lat, ll.lng); });
    main.on('dragend', () => {
      const ll = main.getLatLng();
      state[which] = { lat: +ll.lat.toFixed(3), lon: +wrapLon(ll.lng).toFixed(3) };
      showCoords(which);
      renderTimeInput();
      if (which === 'tx') renderActiveBands();
      persist();
    });
    const ghosts = GHOST_OFFSETS.map((d) =>
      L.marker([p.lat, p.lon + d], { icon: pinIcon(which), interactive: false, keyboard: false }).addTo(state.map));
    state.markers[which] = { main, ghosts };
  }
  renderTimeInput(); // re-show the time in the (possibly new) site's local zone
  if (which === 'tx') renderActiveBands();
  persist();
}

/** Parse "JO01ab", "FN31", "51.5, -0.12" or "51.5 -0.12" → {lat, lon} | null. */
function parseSiteInput(text) {
  const t = String(text || '').trim();
  const grid = maidenheadToLatLon(t);
  if (grid) return { lat: +grid.lat.toFixed(3), lon: +grid.lon.toFixed(3) };
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: +lat.toFixed(3), lon: +lon.toFixed(3) };
}

// --- Conditions / model inputs -------------------------------------------

function getConditions() {
  const r12 = Number($('in-ssn').value);
  const kp = Number($('in-kp').value) || 0;
  return { r12: Number.isFinite(r12) ? r12 : 60, kp };
}

/** The ionospheric field for an instant (cached), with live ionosondes folded in. */
function getField(date = state.timeUTC) {
  const { r12, kp } = getConditions();
  return ionoField({ date, r12, kp, stations: state.stations, nowMs: Date.now() });
}

/** Live flare / proton data only applies near "now". */
function spaceWxFor(date) {
  const { kp } = getConditions();
  const sw = { kp };
  const live = state.liveSolar;
  if (!live) return sw;
  const dtH = Math.abs(date.getTime() - Date.now()) / 3600e3;
  if (live.xray && dtH < 1) sw.xrayWm2 = live.xray.flux;
  if (live.protons && dtH < 24) sw.protonPfu = live.protons.flux * Math.exp(-dtH / 12);
  return sw;
}

function getSys(date = state.timeUTC) {
  const mode = modeByName($('in-mode').value);
  return {
    powerW: Number($('in-power').value) || 100,
    txAnt: { type: $('in-ant').value, heightM: Number($('in-ant-h').value) || 10 },
    rxAnt: { type: $('in-rx-ant').value, heightM: Number($('in-rx-ant-h').value) || 10 },
    reqDbHz: mode.reqDbHz,
    noiseEnv: $('in-noise').value,
    clutter: $('lyr-clutter').checked,
    spaceWx: spaceWxFor(date),
  };
}

const minTakeoff = () => {
  const v = Number($('in-takeoff').value);
  return Number.isFinite(v) ? v : 3;
};

/** SNR (dB-Hz) → SNR in the selected mode's conventional bandwidth. */
function snrInBw(snrDbHz) {
  const m = modeByName($('in-mode').value);
  return snrDbHz - 10 * Math.log10(m.bwHz);
}

// The time field shows LOCAL (solar) time at the active site, derived from its
// longitude (≈ lon/15 hours), while the model works in UTC. This makes the
// day/night state obvious — drop a TX and the clock reads its local time.
function siteForTime() {
  return state.mode === 'coverage' ? state.tx : state.a;
}
function tzOffsetMs() {
  const s = siteForTime();
  return (s ? s.lon / 15 : 0) * 3600000;
}

function getSubsolar() {
  return subsolarPoint(state.timeUTC);
}

function renderTimeInput() {
  const local = new Date(state.timeUTC.getTime() + tzOffsetMs());
  const p = (n) => String(n).padStart(2, '0');
  $('in-time').value =
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
  const u = state.timeUTC;
  const off = tzOffsetMs() / 3600000;
  $('utc-line').textContent =
    `${u.toUTCString().slice(0, 3)} ${p(u.getUTCDate())} ${u.toUTCString().slice(8, 11)} · ` +
    `${p(u.getUTCHours())}:${p(u.getUTCMinutes())} UTC` +
    (siteForTime() ? ` · site solar time is UTC${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(1)} h` : '');
  syncSlider();
}

function readTimeInput() {
  const v = $('in-time').value;
  if (!v) return;
  const localWall = new Date(v + ':00Z').getTime(); // wall-clock value as ms
  state.timeUTC = new Date(localWall - tzOffsetMs());
}

// Re-run whichever mode is active (Path without re-framing; Coverage re-renders).
function refreshActive() {
  if (state.restoring) return;
  renderWx();
  updateStationSummary();
  if (state.mode === 'path') { if (state.a && state.b) runPath(false); }
  else renderActiveBands();
  persist();
}

function syncSlider() {
  const slider = $('time-slider');
  const h = Math.round((state.timeUTC.getTime() - state.anchorTime) / 3600000);
  if (h >= 0 && h <= Number(slider.max)) {
    slider.value = h;
    $('slider-label').textContent = h === 0 ? 'now' : `+${h} h`;
  }
}

// On a future day, apply that day's NOAA 27-day forecast Kp (and show its SFI);
// on today/past, restore the live values. R12 is a 12-month mean — unchanged.
function applyIndicesForTime() {
  const now = new Date();
  const dayStart = Date.UTC(state.timeUTC.getUTCFullYear(), state.timeUTC.getUTCMonth(), state.timeUTC.getUTCDate());
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (dayStart <= todayStart || !state.forecast.length) {
    if (state.liveSolar) {
      $('in-kp').value = state.liveSolar.kp;
      if (state.liveSolar.sfi != null) $('in-sfi').value = state.liveSolar.sfi;
    }
    $('forecast-note').textContent = '';
    return;
  }
  let row = state.forecast.find((r) => r.date === dayStart);
  if (!row) row = state.forecast.reduce((b, r) => (Math.abs(r.date - dayStart) < Math.abs(b.date - dayStart) ? r : b));
  if (row) {
    $('in-kp').value = row.kp;
    $('in-sfi').value = row.sfi;
    $('forecast-note').textContent =
      `NOAA forecast for ${new Date(row.date).toUTCString().slice(5, 11)}: SFI ${row.sfi}, Kp ${row.kp}`;
  }
}

let sliderTimer = null;
function onSlider() {
  const h = Number($('time-slider').value);
  state.timeUTC = new Date(state.anchorTime + h * 3600000);
  $('slider-label').textContent = h === 0 ? 'now' : `+${h} h`;
  renderTimeInput();
  redrawTerminator();
  // Debounce the heavy recompute (coverage/path) until the drag settles.
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => { applyIndicesForTime(); refreshActive(); }, 200);
}

// Snap to local solar noon at the active site, so high-band daytime coverage is
// one click away instead of guessing the hour.
function setNoonAtSite() {
  if (!siteForTime()) { toast('Set a TX/A site first.'); return; }
  const local = new Date(state.timeUTC.getTime() + tzOffsetMs());
  const noonWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12, 0, 0);
  state.timeUTC = new Date(noonWall - tzOffsetMs());
  renderTimeInput();
  redrawTerminator();
  refreshActive();
}

function redrawTerminator() {
  if (state.layers.terminator) state.map.removeLayer(state.layers.terminator);
  if (!$('lyr-terminator').checked) return;
  state.layers.terminator = makeTerminator(getSubsolar()).addTo(state.map);
}

// --- Live data -------------------------------------------------------------

async function loadSolar() {
  $('solar-status').textContent = 'Loading live data…';
  const sw = await fetchSpaceWeather();
  state.liveSolar = sw;
  $('in-ssn').value = sw.r12;
  if (sw.sfi != null) $('in-sfi').value = sw.sfi;
  $('in-kp').value = sw.kp;
  $('solar-status').textContent = sw.ok
    ? `Live: NOAA SWPC${sw.timestamp ? ` (${sw.timestamp} UTC)` : ''}`
    : `Partial live data (missing ${sw.errors.join(', ')}) — edit values to override.`;
  applyIndicesForTime();
  refreshActive();
}

async function loadIonosondes() {
  const raw = await fetchIonosondes();
  state.stations = raw ? parseStations(raw) : null;
  sendStationsToWorker();
  redrawIonosondes();
  refreshActive();
}

/** Space-weather / ionosphere readout under the solar panel. */
function renderWx() {
  const items = [];
  const live = state.liveSolar;
  if (live && live.r12V2 != null) {
    items.push(`R12 <b>${live.r12}</b> (SWPC ${escapeHtml(live.r12Source)}: ${live.r12V2} on the v2 scale)`);
  }
  const f = getField();
  if (f.assimilated) {
    items.push(`Ionosondes: <b>${f.stationsUsed}</b> live · effective R12 <b>${f.r12Used.toFixed(0)}</b>` +
      (f.r12Fit != null ? ` (fit ${f.r12Fit})` : ''));
  } else {
    items.push(state.stations ? 'Ionosondes: too few recent stations — median model only'
      : 'Ionosondes: unavailable — monthly-median model only');
  }
  if (live && live.xray) {
    const cls = flareClass(live.xray.flux);
    const hot = live.xray.flux >= 1e-5;
    items.push(`<span class="${hot ? 'warn' : ''}">X-ray <b>${cls}</b>${hot ? ' — flare absorption on the dayside' : ''}</span>`);
  }
  if (live && live.protons) {
    const hot = live.protons.flux >= 10;
    items.push(`<span class="${hot ? 'warn' : ''}">Protons ≥10 MeV <b>${live.protons.flux.toFixed(1)}</b> pfu${hot ? ' — polar-cap absorption' : ''}</span>`);
  }
  const kp = getConditions().kp;
  if (kp >= 5) items.push(`<span class="warn">Kp ${kp}: geomagnetic storm — F2 depressed, auroral absorption</span>`);
  $('wx-list').innerHTML = items.map((s) => `<li>${s}</li>`).join('');
}

// --- Background computation (Web Worker, with main-thread fallback) ---------

let worker = null;
let workerSeq = 0;
const workerPending = new Map();

function initWorker() {
  try {
    worker = new Worker('src/worker.js', { type: 'module' });
  } catch {
    worker = null;
    return;
  }
  worker.onmessage = (e) => {
    const m = e.data;
    const p = workerPending.get(m.id);
    if (!p) return;
    workerPending.delete(m.id);
    updateBusy();
    if (m.type === 'coverage') p.resolve(m.results);
    else p.reject(new Error(m.message));
  };
  worker.onerror = () => {
    // Module workers unsupported or the script failed: fall back to the main thread.
    worker = null;
    for (const p of workerPending.values()) p.reject(new Error('worker failed'));
    workerPending.clear();
    updateBusy();
  };
}

function sendStationsToWorker() {
  if (!worker) return;
  const s = state.stations;
  worker.postMessage({ type: 'stations', stations: s ? { list: [...s], version: s.version, fetchedMs: s.fetchedMs } : null });
}

let busyTimer = null;
function updateBusy() {
  clearTimeout(busyTimer);
  if (!workerPending.size) { $('busy').hidden = true; return; }
  busyTimer = setTimeout(() => { $('busy').hidden = workerPending.size === 0; }, 150);
}

/** Path preparations depend on TX, time, ionosphere and takeoff only — share them across bands. */
function prepCacheFor(origin, field) {
  const key = [origin.lat, origin.lon, field.date.getTime(), field.r12, field.kp,
    state.stations ? state.stations.version : 0, minTakeoff()].join('|');
  if (state.prepCache.key !== key) state.prepCache = { key, map: new Map() };
  return state.prepCache.map;
}

/**
 * Coverage grids for each origin at each frequency → [[grid per freq] per origin].
 * Runs in the worker when available, otherwise synchronously.
 */
async function computeCoverage(origins, freqsMhz) {
  const sys = getSys();
  const { r12, kp } = getConditions();
  if (worker) {
    const id = ++workerSeq;
    const promise = new Promise((resolve, reject) => {
      workerPending.set(id, { resolve, reject });
      // A worker that never answers (blocked/broken environment): give up and use the main thread.
      setTimeout(() => {
        if (!workerPending.has(id)) return;
        workerPending.delete(id);
        worker.terminate();
        worker = null;
        updateBusy();
        reject(new Error('worker timeout'));
      }, 30000);
    });
    updateBusy();
    worker.postMessage({
      type: 'coverage', id, dateMs: state.timeUTC.getTime(), nowMs: Date.now(), r12, kp,
      minTakeoffDeg: minTakeoff(), sys, origins: origins.map((o) => ({ lat: o.lat, lon: o.lon })), freqsMhz,
    });
    try {
      return await promise;
    } catch {
      if (worker) throw new Error('coverage failed');
      // Worker died — fall through to the main thread.
    }
  }
  const field = getField();
  return origins.map((o) => coverageGrids({
    txLat: o.lat, txLon: o.lon, freqsMhz, field, sys, minTakeoffDeg: minTakeoff(),
    prepCache: origins.length === 1 ? prepCacheFor(o, field) : null,
  }));
}

// --- Mode A: coverage --------------------------------------------------------

function clearResultLayer() {
  if (state.layers.result) { state.map.removeLayer(state.layers.result); state.layers.result = null; }
  clearBandCoverage();
}

function clearBandLayers() {
  for (const k of Object.keys(state.bandLayers)) {
    state.map.removeLayer(state.bandLayers[k]);
    delete state.bandLayers[k];
  }
}

// Why is a band giving no coverage right now? Probe a few representative paths
// and report the limiting factor of the best one.
function bandDiagnosis(band, field, sys) {
  const cz = cosZenith(state.tx.lat, state.tx.lon, field.subsolar);
  let best = null;
  for (const az of [0, 90, 180, 270]) {
    for (const d of [800, 2000, 4000, 8000]) {
      const [la, lo] = destinationPoint(state.tx.lat, state.tx.lon, az, d);
      const r = evalPath(preparePath({ lat1: state.tx.lat, lon1: state.tx.lon, lat2: la, lon2: lo, field, minTakeoffDeg: minTakeoff() }), band.mhz, sys);
      if (!best || r.reliability > best.reliability) best = r;
    }
  }
  if (best && best.limit === 'muf') {
    return cz < 0.02 && band.mhz > 10 ? 'above the MUF — your TX is in darkness; try ☼ Noon or a lower band'
      : 'above the MUF right now — try a lower band';
  }
  if (best && best.mode && best.absorptionDb > 20) return `D-layer absorption (${Math.round(best.absorptionDb)} dB) — try after dark`;
  return `too weak for ${modeByName($('in-mode').value).label} — more power, a better antenna or a digital mode`;
}

async function renderActiveBands() {
  if (state.restoring) return;
  if (!state.tx) {
    clearBandLayers();
    $('coverage-results').innerHTML = '<p class="hint">Set a TX site first.</p>';
    updateLegend();
    return;
  }
  const best = state.view === 'best';
  const bands = best ? BANDS : BANDS.filter((b) => state.activeBands.has(b.name));
  if (!bands.length) {
    clearBandLayers();
    $('coverage-results').innerHTML = '';
    updateLegend();
    return;
  }

  const token = ++state.tokens.coverage;
  let grids;
  try {
    [grids] = await computeCoverage([state.tx], bands.map((b) => b.mhz));
  } catch {
    if (token === state.tokens.coverage) $('coverage-results').innerHTML = '<p class="hint">Coverage calculation failed.</p>';
    return;
  }
  if (token !== state.tokens.coverage) return; // a newer request superseded this one

  clearBandLayers();
  const field = getField();
  const sys = getSys();
  if (best) {
    state.bandLayers.best = makeBestBandRaster(grids, bands.map((b) => b.color), { opacity: 0.6 }).addTo(state.map);
  }
  const openRows = [];
  const closedRows = [];
  bands.forEach((b, i) => {
    const g = grids[i];
    if (g.maxReachKm) {
      if (!best) state.bandLayers[b.name] = makeFootprintRaster(g, { color: b.color, opacity: 0.55 }).addTo(state.map);
      const skip = g.skipKm ? `skip ${Math.round(g.skipKm)} km` : 'local';
      openRows.push(`<tr><td><span class="bdot" data-band="${b.name}"></span>${b.label}</td>` +
        `<td>${Math.round(g.maxReachKm)} km</td><td>${skip}</td></tr>`);
    } else if (!best) {
      // Even a closed band may have weak (<50 %) coverage worth showing.
      if (g.cells.some((v) => v >= 13)) {
        state.bandLayers[b.name] = makeFootprintRaster(g, { color: b.color, opacity: 0.55 }).addTo(state.map);
      }
      closedRows.push(`<tr><td><span class="bdot" data-band="${b.name}"></span>${b.label}</td>` +
        `<td colspan="2"><span class="pill closed">closed</span> ${bandDiagnosis(b, field, sys)}</td></tr>`);
    }
  });
  const modeName = modeByName($('in-mode').value).label;
  $('coverage-results').innerHTML =
    (openRows.length ? `<table><tr><th>Band</th><th>Reach (≥50 %)</th><th></th></tr>${openRows.join('')}</table>` : '') +
    (closedRows.length ? `<table>${closedRows.join('')}</table>` : '') +
    (best && !openRows.length ? '<p class="hint">No band reaches 50 % anywhere right now.</p>' : '') +
    `<p class="hint">${best
      ? `Each region is coloured by its most reliable band for ${modeName}; shading deepens with reliability.`
      : `Shading deepens with reliability (chance the path supports ${modeName} with your station). The gap by the TX is the skip zone.`}
      Click the map for details at any point.</p>`;
  colourBandDots();
  updateLegend();
}

// Colour the legend dots in the results table (JS-set styles are CSP-safe).
function colourBandDots() {
  for (const dot of document.querySelectorAll('.bdot')) {
    const band = BANDS.find((b) => b.name === dot.dataset.band);
    if (band) dot.style.background = band.color;
  }
}

/** Reliability ramp + swatches in the map legend for whatever is drawn. */
function updateLegend() {
  if (!state.legend) return;
  const ramp = `<div>Reliability</div>
    <div class="ramp"><span data-a="0.25"></span><span data-a="0.45"></span><span data-a="0.7"></span><span data-a="1"></span></div>
    <div class="ticks"><span>5 %</span><span>50 %</span><span>90 %+</span></div>`;
  let swatches = [];
  if (state.mode === 'coverage' && state.tx) {
    const bands = state.view === 'best' ? BANDS : BANDS.filter((b) => state.activeBands.has(b.name));
    swatches = bands.map((b) => [b.color, b.label]);
  } else if (state.mode === 'path' && state.layers.bandCoverage) {
    swatches = [['#3fb950', 'from A'], ['#f7a32f', 'from B']];
  }
  if (!swatches.length) { state.legend.set(''); return; }
  state.legend.set(`${ramp}<div class="bands">${swatches.map(([c, l]) =>
    `<span><i class="sw" data-c="${c}"></i>${l}</span>`).join('')}</div>`);
  // Colours set from JS (CSP disallows inline style attributes).
  const el = document.querySelector('.map-legend');
  for (const s of el.querySelectorAll('.ramp span')) s.style.background = `rgba(230, 237, 243, ${s.dataset.a})`;
  for (const s of el.querySelectorAll('.sw')) s.style.background = s.dataset.c;
}

/** Click on the map (coverage mode): per-band prediction from the TX to that point. */
function inspectPoint(p, latlng) {
  const field = getField();
  const sys = getSys();
  const prep = preparePath({ lat1: state.tx.lat, lon1: state.tx.lon, lat2: p.lat, lon2: p.lon, field, minTakeoffDeg: minTakeoff() });
  const rows = BANDS.map((b) => {
    const r = evalPath(prep, b.mhz, sys);
    const st = statusFor(r.reliability);
    const snr = r.mode && snrInBw(r.snrDb) > -60 ? `${Math.round(snrInBw(r.snrDb))} dB` : '—';
    return `<tr><td>${b.label}</td><td class="${st}">${Math.round(r.reliability * 100)} %</td><td>${snr}</td></tr>`;
  }).join('');
  const d = greatCircleKm(state.tx.lat, state.tx.lon, p.lat, p.lon);
  const brg = bearingDeg(state.tx.lat, state.tx.lon, p.lat, p.lon);
  const html = `<div class="inspect">
    <h4>${latLonToMaidenhead(p.lat, p.lon)} · ${Math.round(d)} km at ${Math.round(brg)}°</h4>
    <table><tr><td></td><td>Rel.</td><td>SNR</td></tr>${rows}</table>
    <button type="button" class="primary">Full path analysis →</button></div>`;
  const popup = L.popup({ maxWidth: 260 }).setLatLng(latlng).setContent(html).openOn(state.map);
  popup.getElement().querySelector('button').addEventListener('click', () => {
    state.map.closePopup();
    state.restoring = true;
    setPoint('a', { ...state.tx });
    setPoint('b', p);
    state.restoring = false;
    setMode('path');
    runPath(true);
  });
}

// --- Mode B: point-to-point best band ------------------------------------------

const modeLabel = (r) => (r && r.mode ? `${r.mode.n}${r.mode.layer === 'Es' ? 'Es' : r.mode.layer}` : '');

/** Short reason a band isn't open, from the engine's limiting factor. */
function whyClosed(r) {
  if (!r.mode) return r.limit === 'geometry' ? 'no path' : 'E-layer blocks';
  if (r.limit === 'muf') return 'above MUF';
  if (r.limit === 'snr') return r.absorptionDb > 15 ? 'absorbed' : 'too weak';
  return '';
}

function runPath(fit = true) {
  if (!state.a || !state.b) { $('path-results').innerHTML = '<p class="hint">Set both A and B.</p>'; return; }
  const field = getField();
  const sys = getSys();
  const { short, long } = analyzePath({
    lat1: state.a.lat, lon1: state.a.lon, lat2: state.b.lat, lon2: state.b.lon,
    field, sys, minTakeoffDeg: minTakeoff(),
  });

  clearResultLayer();
  updateLegend();
  state.layers.result = makePath(state.a, state.b, short).addTo(state.map);
  if (fit) {
    // Frame the path without zooming so far out that the world repeats.
    state.map.fitBounds(
      L.latLngBounds([state.a.lat, state.a.lon], [state.b.lat, state.b.lon]),
      { padding: [50, 50], maxZoom: 6 },
    );
  }

  // Each band: the better of short path and long path.
  const results = BANDS.map((b) => {
    const sp = evalPath(short.prep, b.mhz, sys);
    const lp = long ? evalPath(long.prep, b.mhz, sys) : null;
    const useLp = lp && lp.reliability > sp.reliability + 0.05;
    return { band: b, r: useLp ? lp : sp, lp: useLp };
  });
  const bestRes = results.reduce((x, y) => (y.r.reliability > x.r.reliability + 1e-6 ||
    (Math.abs(y.r.reliability - x.r.reliability) <= 1e-6 && y.r.snrDb > x.r.snrDb) ? y : x));
  const best = bestRes.r.reliability >= 0.2 ? bestRes : null;

  const rows = results.map(({ band, r, lp }) => {
    const st = statusFor(r.reliability);
    const rel = r.mode ? `${Math.round(r.reliability * 100)}%` : '—';
    // Far below any decode threshold the number is meaningless (above-MUF loss is unbounded).
    const snr = r.mode && Number.isFinite(r.snrDb) && snrInBw(r.snrDb) > -60 ? `${Math.round(snrInBw(r.snrDb))} dB` : '—';
    const why = st !== 'open' ? whyClosed(r) : '';
    const cls = best && band.name === best.band.name ? 'row-best' : '';
    return `<tr class="band-row ${cls}" data-freq="${band.mhz}"><td>${band.label}</td>` +
      `<td><span class="pill ${st}">${st}</span>${why ? `<span class="why">${why}</span>` : ''}</td><td>${rel}</td>` +
      `<td class="snr">${snr}</td><td class="snr">${lp ? 'LP ' : ''}${modeLabel(r)}</td></tr>`;
  }).join('');

  const lead = short.prep.modes.find((m) => m.layer === 'F2');
  const surfaces = lead && lead.grounds.length
    ? lead.grounds.map((g) => SURFACE[g.surface].label.toLowerCase()).join(', ')
    : 'single hop (no intermediate bounce)';
  const luf = Number.isFinite(short.lufMhz) ? short.lufMhz.toFixed(1) : '—';
  const mode = modeByName($('in-mode').value);
  const br = best ? best.r : null;
  const budget = br && br.mode ? `
    <table class="loss-table">
      <tr><th colspan="2">Link budget, ${best.band.label} (${modeLabel(br)}, ${br.elevDeg.toFixed(0)}° takeoff)</th></tr>
      <tr><td>Total path loss</td><td>${br.lossDb.toFixed(0)} dB</td></tr>
      <tr><td>· of which D-layer absorption</td><td>${br.absorptionDb.toFixed(1)} dB</td></tr>
      <tr><td>· of which ground reflections</td><td>${br.groundDb.toFixed(1)} dB</td></tr>
      <tr><td>Antenna gains (both ends)</td><td>${br.gainDb.toFixed(1)} dBi</td></tr>
      <tr><td>Noise at receiver (Fa)</td><td>${br.noiseFa.toFixed(0)} dB</td></tr>
      <tr><td>Median SNR (${mode.bwHz} Hz)</td><td>${snrInBw(br.snrDb).toFixed(0)} dB</td></tr>
    </table>` : '';

  $('path-results').innerHTML = `
    <div class="big">${best ? `${best.band.label}${best.lp ? ' (long path)' : ''}` : 'No usable band'}</div>
    <table>
      <tr><td>Distance</td><td>${Math.round(short.distanceKm)} km, ${short.hopCount} F2 hop(s)</td></tr>
      <tr><td>Bearing A→B</td><td>${Math.round(short.bearingDeg)}° (long path ${Math.round((short.bearingDeg + 180) % 360)}°)</td></tr>
      <tr><td>MUF / FOT / LUF</td><td>${short.mufMhz.toFixed(1)} / ${short.fotMhz.toFixed(1)} / ${luf} MHz</td></tr>
      <tr><td>Ground reflections</td><td>${surfaces}</td></tr>
    </table>
    <table>
      <tr><th>Band</th><th>Status</th><th>Rel.</th><th>SNR</th><th>Mode</th></tr>
      ${rows}
    </table>
    ${budget}
    <p class="hint">Rel. = probability ${mode.label} works on that band right now (day-to-day MUF and
      signal variation included). SNR is the median in ${mode.bwHz} Hz. Click a band to map its coverage
      from both ends (<span class="dot dot-a"></span>A, <span class="dot dot-b"></span>B).</p>`;

  // Clicking a band row overlays the coverage footprint from A and from B.
  for (const tr of $('path-results').querySelectorAll('.band-row')) {
    tr.addEventListener('click', () => {
      for (const r of $('path-results').querySelectorAll('.band-row')) r.classList.remove('selected');
      tr.classList.add('selected');
      showBandCoverage(Number(tr.dataset.freq));
    });
  }

  $('path-results').insertAdjacentHTML('beforeend', renderBandChart(state.a, state.b));
}

// A 24-hour open/marginal/closed timeline for every band on the A–B path, so you
// can see the best time to call. The ionosphere is recomputed each hour.
function renderBandChart(a, b) {
  const HOURS = 24;
  const preps = [];
  const syss = [];
  for (let h = 0; h < HOURS; h++) {
    const date = new Date(state.anchorTime + h * 3600000);
    preps.push(preparePath({ lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon, field: getField(date), minTakeoffDeg: minTakeoff() }));
    syss.push(getSys(date));
  }
  const nowH = Math.round((state.timeUTC.getTime() - state.anchorTime) / 3600000);
  const anchorH = state.anchorTime / 3600000 + a.lon / 15; // local-at-A hour of column 0
  const anchorUtcH = new Date(state.anchorTime).getUTCHours();

  let head = '<tr><th class="blabel"></th>';
  for (let h = 0; h < HOURS; h++) {
    const lh = ((Math.floor(anchorH + h) % 24) + 24) % 24;
    head += `<th class="hr">${h % 6 === 0 ? String(lh).padStart(2, '0') : ''}</th>`;
  }
  head += '</tr>';

  let body = '';
  for (const band of [...BANDS].reverse()) { // highest band on top
    body += `<tr><td class="blabel">${band.label}</td>`;
    for (let h = 0; h < HOURS; h++) {
      const rel = evalPath(preps[h], band.mhz, syss[h]).reliability;
      const utc = String((anchorUtcH + h) % 24).padStart(2, '0');
      body += `<td class="cell ${statusFor(rel)}${h === nowH ? ' now' : ''}" title="${band.label} ${utc}:00 UTC — ${Math.round(rel * 100)}%"></td>`;
    }
    body += '</tr>';
  }
  return `<div class="bandchart">
    <div class="hint" style="margin:8px 0 4px">Next 24 h on this path — <span style="color:var(--good)">open</span> (≥50 %) /
      <span style="color:var(--warn)">marginal</span> (20–50 %) / closed. Hours = solar time at A; hover a cell for UTC.</div>
    <table>${head}${body}</table></div>`;
}

function clearBandCoverage() {
  if (state.layers.bandCoverage) {
    state.map.removeLayer(state.layers.bandCoverage);
    state.layers.bandCoverage = null;
  }
}

async function showBandCoverage(freqMhz) {
  const pts = [state.a, state.b].filter(Boolean);
  const colours = ['#3fb950', '#f7a32f'];
  const token = ++state.tokens.pathCoverage;
  let results;
  try {
    results = await computeCoverage(pts, [freqMhz]);
  } catch {
    return;
  }
  if (token !== state.tokens.pathCoverage || state.mode !== 'path') return;
  clearBandCoverage();
  const grp = L.layerGroup();
  results.forEach(([g], i) => makeFootprintRaster(g, { color: colours[i], opacity: 0.45 }).addTo(grp));
  grp.addTo(state.map);
  state.layers.bandCoverage = grp;
  updateLegend();
}

// --- Geolocation ---------------------------------------------------------

function geolocate(which) {
  if (!navigator.geolocation) { toast('Geolocation is not supported by this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) };
      setPoint(which, p);
      state.map.setView([p.lat, p.lon], 5);
    },
    (err) => toast('Could not get location: ' + err.message),
    { enableHighAccuracy: false, timeout: 8000 },
  );
}

// --- Layer toggles -------------------------------------------------------

function toggleKc2g() {
  if ($('lyr-kc2g').checked) {
    state.layers.kc2g = makeKc2gOverlay(() => {
      $('lyr-kc2g').checked = false;
      $('solar-status').textContent = 'KC2G overlay unavailable.';
    }).addTo(state.map);
  } else if (state.layers.kc2g) {
    state.map.removeLayer(state.layers.kc2g);
    state.layers.kc2g = null;
  }
}

function redrawIonosondes() {
  if (state.layers.iono) { state.map.removeLayer(state.layers.iono); state.layers.iono = null; }
  if (!$('lyr-iono').checked || !state.stations) return;
  // Compare each station with the plain monthly-median model (no assimilation).
  const { r12, kp } = getConditions();
  const median = ionoField({ date: new Date(), r12, kp, stations: null });
  state.layers.iono = makeIonosondeMarkers(state.stations, (la, lo) => median.at(la, lo).foF2).addTo(state.map);
}

// --- Mode switching ------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  state.picking = null;
  $('tab-coverage').classList.toggle('active', mode === 'coverage');
  $('tab-path').classList.toggle('active', mode === 'path');
  $('mode-coverage').classList.toggle('hidden', mode !== 'coverage');
  $('mode-path').classList.toggle('hidden', mode !== 'path');
  state.map.closePopup();
  renderTimeInput(); // the active site (and thus local-time zone) may have changed
  if (mode === 'path') {
    state.tokens.coverage++; // drop any in-flight coverage result
    clearBandLayers();
    updateLegend();
  } else {
    clearResultLayer();
    renderActiveBands();
  }
  persist();
}

function setView(view) {
  state.view = view;
  $('view-bands').classList.toggle('active', view === 'bands');
  $('view-best').classList.toggle('active', view === 'best');
  $('band-toggles').classList.toggle('disabled', view === 'best');
  renderActiveBands();
  persist();
}

// --- Selects, band chips, station summary -----------------------------------

function fillSelect(id, items, value) {
  $(id).innerHTML = items.map((x) => `<option value="${x.id ?? x.name}">${x.label}</option>`).join('');
  $(id).value = value;
}

function syncHeights() {
  for (const [sel, h] of [['in-ant', 'in-ant-h'], ['in-rx-ant', 'in-rx-ant-h']]) {
    $(h).disabled = !antennaById($(sel).value).height;
  }
}

function initSelects() {
  fillSelect('in-mode', MODES, 'ft8'); // FT8 is the modern baseline most people actually use
  fillSelect('in-ant', ANTENNAS, 'dipole');
  fillSelect('in-rx-ant', ANTENNAS, 'dipole');
  fillSelect('in-noise', NOISE_ENVIRONMENTS, 'residential');
  $('in-ant').addEventListener('change', syncHeights);
  $('in-rx-ant').addEventListener('change', syncHeights);
  syncHeights();
}

/** One-line summary shown in the collapsed "Your station" header. */
function updateStationSummary() {
  const ant = antennaById($('in-ant').value);
  const short = { dipole: 'Dipole', vertical: 'Vertical', yagi3: 'Yagi', iso: 'Isotropic' }[ant.id] || ant.label;
  $('station-summary').textContent = [
    `${$('in-power').value} W`,
    modeByName($('in-mode').value).label,
    ant.height ? `${short} ${$('in-ant-h').value} m` : short,
    noiseEnvById($('in-noise').value).label,
  ].join(' · ');
}

function initBandToggles() {
  const cont = $('band-toggles');
  cont.innerHTML = '';
  for (const b of BANDS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'band-chip';
    chip.dataset.band = b.name;
    const sw = document.createElement('span');
    sw.className = 'chip-sw';
    sw.style.background = b.color; // JS-set style is CSP-safe
    const lbl = document.createElement('span');
    lbl.textContent = b.label;
    chip.append(sw, lbl);
    chip.addEventListener('click', () => toggleBand(b));
    cont.appendChild(chip);
  }
}

function syncBandChips() {
  for (const chip of document.querySelectorAll('.band-chip')) {
    const b = BANDS.find((x) => x.name === chip.dataset.band);
    const on = state.activeBands.has(b.name);
    chip.classList.toggle('on', on);
    chip.style.borderColor = on ? b.color : '';
  }
}

function toggleBand(band) {
  if (!state.tx) { $('coverage-results').innerHTML = '<p class="hint">Set a TX site first.</p>'; return; }
  if (state.activeBands.has(band.name)) state.activeBands.delete(band.name);
  else state.activeBands.add(band.name);
  syncBandChips();
  renderActiveBands();
  persist();
}

// --- Saved state and shareable links ---------------------------------------
// Station settings, sites, bands and view are remembered in this browser and
// mirrored into the URL hash, so a link reproduces the same view elsewhere.

const STORE_KEY = 'hf-range-planner:v1';
const STATION_INPUTS = { p: 'in-power', mode: 'in-mode', ant: 'in-ant', anth: 'in-ant-h', rx: 'in-rx-ant', rxh: 'in-rx-ant-h', noise: 'in-noise', to: 'in-takeoff' };

function snapshot() {
  const s = { m: state.mode, v: state.view, bands: [...state.activeBands].join(','), gnd: $('lyr-clutter').checked ? 1 : 0 };
  for (const w of ['tx', 'a', 'b']) if (state[w]) s[w] = `${state[w].lat},${state[w].lon}`;
  for (const [k, id] of Object.entries(STATION_INPUTS)) s[k] = $(id).value;
  return s;
}

function snapshotToParams(s, withTime = false) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) if (v !== '' && v != null) q.set(k, String(v));
  if (withTime && Math.abs(state.timeUTC.getTime() - Date.now()) > 5 * 60e3) {
    q.set('t', state.timeUTC.toISOString().slice(0, 16) + 'Z');
  }
  return q;
}

let persistTimer = null;
function persist() {
  if (state.restoring) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = snapshot();
    try {
      const collapsed = [...document.querySelectorAll('.panel.collapsible.collapsed')].map((p) => p.id);
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...s, collapsed }));
    } catch { /* storage unavailable (private mode etc.) — not essential */ }
    history.replaceState(null, '', `#${snapshotToParams(s)}`);
  }, 300);
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Apply a saved/shared snapshot (URL hash wins over localStorage). */
function restore() {
  const saved = loadSaved() || {};
  const hash = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const s = Object.keys(hash).length ? hash : saved;
  state.restoring = true;
  try {
    for (const [k, id] of Object.entries(STATION_INPUTS)) {
      if (s[k] == null) continue;
      const el = $(id);
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === s[k])) continue;
      el.value = s[k];
    }
    syncHeights();
    if (s.gnd != null) $('lyr-clutter').checked = String(s.gnd) === '1';
    for (const w of ['tx', 'a', 'b']) {
      const p = s[w] && parseSiteInput(s[w]);
      if (p) setPoint(w, p);
    }
    state.activeBands = new Set(String(s.bands || '').split(',').filter((n) => BANDS.some((b) => b.name === n)));
    syncBandChips();
    if (s.v === 'best' || s.v === 'bands') state.view = s.v;
    if (s.t && !Number.isNaN(Date.parse(s.t))) {
      state.timeUTC = new Date(Date.parse(s.t));
    }
    for (const id of saved.collapsed || []) { const p = $(id); if (p) p.classList.add('collapsed'); }
  } finally {
    state.restoring = false;
  }
  $('view-bands').classList.toggle('active', state.view === 'bands');
  $('view-best').classList.toggle('active', state.view === 'best');
  $('band-toggles').classList.toggle('disabled', state.view === 'best');
  if (s.m === 'path') setMode('path');
  if (state.tx) state.map.setView([state.tx.lat, state.tx.lon], 3);
}

async function shareLink() {
  const url = `${location.origin}${location.pathname}#${snapshotToParams(snapshot(), true)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied to the clipboard');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// --- Wire up -------------------------------------------------------------

function wire() {
  $('tab-coverage').addEventListener('click', () => setMode('coverage'));
  $('tab-path').addEventListener('click', () => setMode('path'));
  $('view-bands').addEventListener('click', () => setView('bands'));
  $('view-best').addEventListener('click', () => setView('best'));

  for (const w of ['tx', 'a', 'b']) {
    $(`btn-pick-${w}`).addEventListener('click', () => { state.picking = w; toast(`Click the map to place ${PIN_LABEL[w]}`); });
    const input = $(`loc-${w}`);
    const apply = () => {
      if (!input.value.trim()) { input.classList.remove('bad'); return; }
      const p = parseSiteInput(input.value);
      input.classList.toggle('bad', !p);
      if (!p) return;
      input.value = '';
      setPoint(w, p);
      state.map.setView([p.lat, p.lon], Math.max(state.map.getZoom(), 4));
      if (w !== 'tx' && state.a && state.b && state.mode === 'path') runPath(true);
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  }
  $('btn-loc-tx').addEventListener('click', () => geolocate('tx'));
  $('btn-loc-a').addEventListener('click', () => geolocate('a'));

  $('btn-run-path').addEventListener('click', () => runPath(true));

  // Inputs that change conditions update whichever mode is active.
  const refresh = refreshActive;
  $('btn-recompute').addEventListener('click', refresh);
  for (const id of ['in-power', 'in-takeoff', 'in-mode', 'in-ssn', 'in-kp', 'in-sfi',
    'in-ant', 'in-ant-h', 'in-rx-ant', 'in-rx-ant-h', 'in-noise', 'lyr-clutter']) {
    $(id).addEventListener('change', refresh);
  }

  $('time-slider').addEventListener('input', onSlider);
  const stepSlider = (delta) => {
    const s = $('time-slider');
    s.value = Math.min(Number(s.max), Math.max(Number(s.min), Number(s.value) + delta));
    onSlider();
  };
  $('btn-step-back').addEventListener('click', () => stepSlider(-1));
  $('btn-step-fwd').addEventListener('click', () => stepSlider(1));
  $('btn-refresh-solar').addEventListener('click', () => { loadSolar(); loadIonosondes(); });
  $('btn-now').addEventListener('click', () => {
    state.anchorTime = Date.now();
    state.timeUTC = new Date();
    applyIndicesForTime();
    renderTimeInput();
    redrawTerminator();
    refresh();
  });
  $('btn-noon').addEventListener('click', setNoonAtSite);
  $('in-time').addEventListener('change', () => { readTimeInput(); renderTimeInput(); redrawTerminator(); applyIndicesForTime(); refresh(); });

  $('lyr-terminator').addEventListener('change', redrawTerminator);
  $('lyr-kc2g').addEventListener('change', toggleKc2g);
  $('lyr-iono').addEventListener('change', redrawIonosondes);

  $('btn-share').addEventListener('click', shareLink);
  $('btn-collapse').addEventListener('click', () => setCollapsed(true));
  $('btn-expand').addEventListener('click', () => setCollapsed(false));

  // Collapsible sidebar sections (state remembered).
  for (const head of document.querySelectorAll('.panel.collapsible .panel-head')) {
    head.addEventListener('click', () => { head.parentElement.classList.toggle('collapsed'); persist(); });
  }
}

function setCollapsed(collapsed) {
  document.getElementById('app').classList.toggle('collapsed', collapsed);
  $('btn-expand').hidden = !collapsed;
  // Leaflet needs to recompute size after the container width changes.
  setTimeout(() => state.map.invalidateSize(), 220);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // SWs only run over https or localhost; silently skip otherwise.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
  });
}

async function main() {
  initMap();
  initWorker();
  initSelects();
  initBandToggles();
  state.anchorTime = Date.now();
  state.timeUTC = new Date();
  $('in-ssn').value = 60; // placeholder until live data arrives
  $('in-kp').value = 2;
  wire();
  restore();
  if (!state.tx) {
    // First visit: nothing set yet — show the empty-state prompt once.
    $('coverage-results').innerHTML = '<p class="hint">Set a TX site — click “On map”, use 📍 Me, or type your locator.</p>';
  }
  renderTimeInput();
  updateStationSummary();
  redrawTerminator();
  registerServiceWorker();
  renderWx();
  await Promise.all([loadSolar(), loadIonosondes()]);
  state.forecast = await fetchForecast(); // for the time-slider forecast indices
  // Ionosondes update every ~15 min; keep the assimilation fresh.
  setInterval(loadIonosondes, 15 * 60e3);
}

main();
