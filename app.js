// app.js — UI bootstrap and orchestration. Imports the pure engine modules and
// wires them to the Leaflet map and the sidebar controls.

import { subsolarPoint, destinationPoint } from './src/geo.js';
import { fetchSpaceWeather, ssnFromSfi } from './src/solar.js';
import { BANDS } from './src/bands.js';
import { analyzePath, coverageFootprint, bandStatus } from './src/propagation.js';
import { groundReflectionLossDb } from './src/clutter.js';
import { makeTerminator, makeKc2gOverlay, makeFootprint, makePath } from './src/overlays.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  mode: 'coverage',
  tx: null, a: null, b: null,
  picking: null,
  activeBands: new Set(),
  bandLayers: {},
  markers: { tx: null, a: null, b: null },
  layers: { terminator: null, kc2g: null, result: null, bandCoverage: null },
};

const PIN_LABEL = { tx: 'TX', a: 'A', b: 'B' };
const pinIcon = (which) => L.divIcon({
  className: 'pin-wrap',
  html: `<span class="pin pin-${which}">${PIN_LABEL[which]}</span>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
});

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

  state.map.on('click', (e) => {
    if (!state.picking) return;
    const p = { lat: +e.latlng.lat.toFixed(3), lon: +e.latlng.lng.toFixed(3) };
    setPoint(state.picking, p);
    state.picking = null;
  });
}

// Pins are mirrored onto adjacent world copies so they stay visible as the map
// wraps (the main pin is draggable; the ghosts just follow).
const GHOST_OFFSETS = [-360, 360];

function markSet(which) {
  const card = $(`site-${which}`);
  if (card) card.classList.add('is-set');
}

function setPoint(which, p) {
  state[which] = p;
  $(`${which}-coords`).textContent = `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
  markSet(which);

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
      state[which] = { lat: +ll.lat.toFixed(3), lon: +ll.lng.toFixed(3) };
      $(`${which}-coords`).textContent =
        `${state[which].lat.toFixed(2)}, ${state[which].lon.toFixed(2)}`;
      if (which === 'tx') renderActiveBands();
    });
    const ghosts = GHOST_OFFSETS.map((d) =>
      L.marker([p.lat, p.lon + d], { icon: pinIcon(which), interactive: false, keyboard: false }).addTo(state.map));
    state.markers[which] = { main, ghosts };
  }
  if (which === 'tx') renderActiveBands();
}

// --- Conditions / time ---------------------------------------------------

function getConditions() {
  const ssn = Number($('in-ssn').value) || 0;
  const kp = Number($('in-kp').value) || 0;
  return { ssn, kp };
}

function getTimeUTC() {
  const v = $('in-time').value;
  // datetime-local has no zone; we treat the entered value as UTC for HF work.
  return v ? new Date(v + ':00Z') : new Date();
}

function getSubsolar() {
  return subsolarPoint(getTimeUTC());
}

function setTimeInput(date) {
  // Render a Date as a UTC datetime-local string (yyyy-MM-ddThh:mm).
  const p = (n) => String(n).padStart(2, '0');
  $('in-time').value =
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

function redrawTerminator() {
  if (state.layers.terminator) state.map.removeLayer(state.layers.terminator);
  if (!$('lyr-terminator').checked) return;
  state.layers.terminator = makeTerminator(getSubsolar()).addTo(state.map);
}

// --- Solar fetch ---------------------------------------------------------

async function loadSolar() {
  $('solar-status').textContent = 'Loading live data…';
  const sw = await fetchSpaceWeather();
  $('in-sfi').value = sw.sfi;
  $('in-ssn').value = sw.ssn;
  $('in-kp').value = sw.kp;
  if (sw.ok) {
    const ts = sw.timestamp ? ` (${sw.timestamp} UTC)` : '';
    $('solar-status').textContent = `Live: ${sw.source}${ts}`;
  } else {
    $('solar-status').textContent = `Live fetch failed — using defaults. Edit values to override.`;
  }
  renderActiveBands();
}

// --- Mode A: coverage footprint ------------------------------------------

function clearResultLayer() {
  if (state.layers.result) { state.map.removeLayer(state.layers.result); state.layers.result = null; }
  clearBandCoverage();
}

function getCoverageEnv() {
  const { ssn, kp } = getConditions();
  return {
    ssn, kp,
    subsolar: getSubsolar(),
    powerW: Number($('in-power').value) || 100,
    minTakeoffDeg: Number($('in-takeoff').value) || 3,
  };
}

function clearBandLayers() {
  for (const k of Object.keys(state.bandLayers)) {
    state.map.removeLayer(state.bandLayers[k]);
    delete state.bandLayers[k];
  }
}

// Why is a band giving no coverage right now? Sample a representative 2500 km
// path due east of the TX to see whether it's above the MUF or D-layer absorbed.
function bandDiagnosis(band, env) {
  const [rxLat, rxLon] = destinationPoint(state.tx.lat, state.tx.lon, 90, 2500);
  const a = analyzePath({ lat1: state.tx.lat, lon1: state.tx.lon, lat2: rxLat, lon2: rxLon, ...env });
  if (band.mhz > a.mufMhz) return 'above MUF — try in daylight or a lower band';
  if (band.mhz < a.lufMhz) return 'D-layer absorbed — try after dark';
  return 'closed here, open on other paths';
}

function renderActiveBands() {
  clearBandLayers();
  if (!state.tx) { $('coverage-results').innerHTML = '<p class="hint">Set a TX site first.</p>'; return; }
  if (!state.activeBands.size) { $('coverage-results').innerHTML = ''; return; }

  const env = getCoverageEnv();
  const openRows = [];
  const closedRows = [];
  for (const b of BANDS) {
    if (!state.activeBands.has(b.name)) continue;
    const fp = coverageFootprint({ txLat: state.tx.lat, txLon: state.tx.lon, freqMhz: b.mhz, ...env });
    if (fp.maxReachKm) {
      state.bandLayers[b.name] = makeFootprint(fp, { color: b.color, opacity: 0.34 }).addTo(state.map);
      const skip = fp.skipKm ? `skip ${Math.round(fp.skipKm)} km` : 'local';
      openRows.push(`<tr><td><span class="bdot" data-band="${b.name}"></span>${b.label}</td>` +
        `<td>${Math.round(fp.maxReachKm)} km</td><td>${skip}</td></tr>`);
    } else {
      closedRows.push(`<tr><td><span class="bdot" data-band="${b.name}"></span>${b.label}</td>` +
        `<td colspan="2"><span class="pill closed">closed</span> ${bandDiagnosis(b, env)}</td></tr>`);
    }
  }
  $('coverage-results').innerHTML =
    (openRows.length ? `<table><tr><th>Band</th><th>Reach</th><th></th></tr>${openRows.join('')}</table>` : '') +
    (closedRows.length ? `<table>${closedRows.join('')}</table>` : '') +
    `<p class="hint">Each band's filled region = where it lands; the gap by the TX is the skip zone.</p>`;
  colourBandDots();
}

// Colour the legend dots in the results table (JS-set styles are CSP-safe).
function colourBandDots() {
  for (const dot of document.querySelectorAll('.bdot')) {
    const band = BANDS.find((b) => b.name === dot.dataset.band);
    if (band) dot.style.background = band.color;
  }
}

// --- Mode B: point-to-point best band ------------------------------------

function reliabilityPct(analysis, freq, groundLossDb) {
  if (freq < analysis.lufMhz || freq > analysis.mufMhz) return 0;
  let r = 95;
  r -= (analysis.hopCount - 1) * 8;          // each extra hop costs reliability
  r -= groundLossDb * 2;                      // cumulative ground reflection loss
  // Penalty for sitting near a band edge of the usable window.
  const mid = (analysis.lufMhz + analysis.mufMhz) / 2;
  const halfWin = (analysis.mufMhz - analysis.lufMhz) / 2 || 1;
  r -= 15 * Math.abs(freq - mid) / halfWin;
  return Math.max(5, Math.min(98, Math.round(r)));
}

function runPath() {
  if (!state.a || !state.b) { $('path-results').innerHTML = '<p class="hint">Set both A and B.</p>'; return; }
  const { ssn, kp } = getConditions();
  const subsolar = getSubsolar();
  const powerW = Number($('in-power').value) || 100;
  const minTakeoffDeg = Number($('in-takeoff').value) || 3;
  const analysis = analyzePath({
    lat1: state.a.lat, lon1: state.a.lon, lat2: state.b.lat, lon2: state.b.lon,
    ssn, kp, subsolar, powerW, minTakeoffDeg,
  });

  const useClutter = $('lyr-clutter').checked;
  const ground = useClutter
    ? groundReflectionLossDb(analysis.groundPoints)
    : { totalDb: 0, detail: [] };

  clearResultLayer();
  state.layers.result = makePath(state.a, state.b, analysis).addTo(state.map);
  // Frame the path without zooming so far out that the world repeats.
  state.map.fitBounds(
    L.latLngBounds([state.a.lat, state.a.lon], [state.b.lat, state.b.lon]),
    { padding: [50, 50], maxZoom: 6 },
  );

  // Best band: open band nearest FOT.
  const open = BANDS.filter((b) => bandStatus(analysis, b.mhz) === 'open');
  const best = open.length
    ? open.reduce((x, b) => (Math.abs(b.mhz - analysis.fotMhz) < Math.abs(x.mhz - analysis.fotMhz) ? b : x))
    : null;

  const rows = BANDS.map((b) => {
    const st = bandStatus(analysis, b.mhz);
    const rel = st === 'open' ? `${reliabilityPct(analysis, b.mhz, ground.totalDb)}%` : '—';
    const cls = best && b.name === best.name ? 'row-best' : '';
    return `<tr class="band-row ${cls}" data-freq="${b.mhz}"><td>${b.label}</td>` +
           `<td><span class="pill ${st}">${st}</span></td><td>${rel}</td></tr>`;
  }).join('');

  const surfaces = ground.detail.length
    ? ground.detail.map((d) => d.surface).join(', ')
    : (useClutter ? 'single hop (no intermediate bounce)' : 'disabled');

  $('path-results').innerHTML = `
    <div class="big">${best ? best.label : 'No open band'}</div>
    <table>
      <tr><td>Distance</td><td>${Math.round(analysis.distanceKm)} km, ${analysis.hopCount} hop(s)</td></tr>
      <tr><td>Bearing A→B</td><td>${Math.round(analysis.bearingDeg)}°</td></tr>
      <tr><td>MUF / FOT / LUF</td><td>${analysis.mufMhz.toFixed(1)} / ${analysis.fotMhz.toFixed(1)} / ${analysis.lufMhz.toFixed(1)} MHz</td></tr>
      <tr><td>Ground reflections</td><td>${surfaces}${ground.totalDb ? ` (${ground.totalDb.toFixed(1)} dB)` : ''}</td></tr>
    </table>
    <table>
      <tr><th>Band</th><th>Status</th><th>Rel.</th></tr>
      ${rows}
    </table>
    <p class="hint">Click a band to map its coverage from both ends
      (<span class="dot dot-a"></span>A, <span class="dot dot-b"></span>B).
      FOT (≈0.85×MUF) is the day-to-day reliable working frequency.</p>`;

  // Clicking a band row overlays the coverage footprint from A and from B.
  for (const tr of $('path-results').querySelectorAll('.band-row')) {
    tr.addEventListener('click', () => {
      for (const r of $('path-results').querySelectorAll('.band-row')) r.classList.remove('selected');
      tr.classList.add('selected');
      showBandCoverage(Number(tr.dataset.freq), { ssn, kp, subsolar, powerW, minTakeoffDeg });
    });
  }
}

function clearBandCoverage() {
  if (state.layers.bandCoverage) {
    state.map.removeLayer(state.layers.bandCoverage);
    state.layers.bandCoverage = null;
  }
}

function showBandCoverage(freqMhz, { ssn, kp, subsolar, powerW, minTakeoffDeg }) {
  clearBandCoverage();
  const grp = L.layerGroup();
  for (const [pt, color] of [[state.a, '#3fb950'], [state.b, '#f7a32f']]) {
    if (!pt) continue;
    const fp = coverageFootprint({ txLat: pt.lat, txLon: pt.lon, freqMhz, ssn, kp, subsolar, powerW, minTakeoffDeg });
    makeFootprint(fp, { color, opacity: 0.26 }).addTo(grp);
  }
  grp.addTo(state.map);
  state.layers.bandCoverage = grp;
}

// --- Geolocation ---------------------------------------------------------

function geolocate(which) {
  if (!navigator.geolocation) { alert('Geolocation not supported by this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) };
      setPoint(which, p);
      state.map.setView([p.lat, p.lon], 5);
    },
    (err) => alert('Could not get location: ' + err.message),
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

// --- Mode switching ------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  state.picking = null;
  $('tab-coverage').classList.toggle('active', mode === 'coverage');
  $('tab-path').classList.toggle('active', mode === 'path');
  $('mode-coverage').classList.toggle('hidden', mode !== 'coverage');
  $('mode-path').classList.toggle('hidden', mode !== 'path');
  if (mode === 'path') {
    clearBandLayers();
  } else {
    clearResultLayer();
    renderActiveBands();
  }
}

// --- Band toggle chips (coverage mode) -----------------------------------

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
    chip.addEventListener('click', () => toggleBand(b, chip));
    cont.appendChild(chip);
  }
}

function toggleBand(band, chip) {
  if (!state.tx) { $('coverage-results').innerHTML = '<p class="hint">Set a TX site first.</p>'; return; }
  const on = !state.activeBands.has(band.name);
  if (on) state.activeBands.add(band.name); else state.activeBands.delete(band.name);
  chip.classList.toggle('on', on);
  chip.style.borderColor = on ? band.color : '';
  renderActiveBands();
}

// --- Wire up -------------------------------------------------------------

function wire() {
  $('tab-coverage').addEventListener('click', () => setMode('coverage'));
  $('tab-path').addEventListener('click', () => setMode('path'));

  $('btn-pick-tx').addEventListener('click', () => { state.picking = 'tx'; });
  $('btn-pick-a').addEventListener('click', () => { state.picking = 'a'; });
  $('btn-pick-b').addEventListener('click', () => { state.picking = 'b'; });
  $('btn-loc-tx').addEventListener('click', () => geolocate('tx'));
  $('btn-loc-a').addEventListener('click', () => geolocate('a'));

  $('btn-run-path').addEventListener('click', runPath);

  // Inputs that change conditions re-render the active coverage bands live;
  // the Recompute button is an explicit trigger for the same.
  const refresh = () => renderActiveBands();
  $('btn-recompute').addEventListener('click', refresh);
  $('in-power').addEventListener('change', refresh);
  $('in-takeoff').addEventListener('change', refresh);
  $('in-ssn').addEventListener('change', refresh);
  $('in-kp').addEventListener('change', refresh);

  $('btn-refresh-solar').addEventListener('click', loadSolar);
  $('btn-now').addEventListener('click', () => { setTimeInput(new Date()); redrawTerminator(); refresh(); });
  $('in-time').addEventListener('change', () => { redrawTerminator(); refresh(); });
  $('in-sfi').addEventListener('change', () => {
    $('in-ssn').value = ssnFromSfi(Number($('in-sfi').value) || 0);
    refresh();
  });

  $('lyr-terminator').addEventListener('change', redrawTerminator);
  $('lyr-kc2g').addEventListener('change', toggleKc2g);

  $('btn-collapse').addEventListener('click', () => setCollapsed(true));
  $('btn-expand').addEventListener('click', () => setCollapsed(false));
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
  initBandToggles();
  setTimeInput(new Date());
  wire();
  redrawTerminator();
  registerServiceWorker();
  await loadSolar();
}

main();
