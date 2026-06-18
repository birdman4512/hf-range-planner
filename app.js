// app.js — UI bootstrap and orchestration. Imports the pure engine modules and
// wires them to the Leaflet map and the sidebar controls.

import { subsolarPoint } from './src/geo.js';
import { fetchSpaceWeather, ssnFromSfi } from './src/solar.js';
import { BANDS, bandByName, nearestBand } from './src/bands.js';
import {
  analyzePath, coverageFootprint, bandStatus, pathAbsorptionDb, nvisCeilingMhz,
} from './src/propagation.js';
import { groundReflectionLossDb } from './src/clutter.js';
import { makeTerminator, makeKc2gOverlay, makeFootprint, makePath } from './src/overlays.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  mode: 'coverage',
  tx: null, a: null, b: null,
  picking: null,
  layers: { terminator: null, kc2g: null, result: null },
};

// --- Map -----------------------------------------------------------------

function initMap() {
  state.map = L.map('map', { worldCopyJump: true, minZoom: 2 }).setView([30, 0], 3);
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

function setPoint(which, p) {
  state[which] = p;
  const fmt = `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
  if (which === 'tx') $('tx-coords').textContent = fmt;
  if (which === 'a') $('a-coords').textContent = fmt;
  if (which === 'b') $('b-coords').textContent = fmt;
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
}

// --- Mode A: coverage footprint ------------------------------------------

function clearResultLayer() {
  if (state.layers.result) { state.map.removeLayer(state.layers.result); state.layers.result = null; }
}

function runCoverage() {
  if (!state.tx) { $('coverage-results').innerHTML = '<p class="hint">Set a TX site first.</p>'; return; }
  const { ssn, kp } = getConditions();
  const subsolar = getSubsolar();
  const freq = Number($('in-freq').value) || nearestBand(14).mhz;

  const fp = coverageFootprint({ txLat: state.tx.lat, txLon: state.tx.lon, freqMhz: freq, ssn, kp, subsolar });
  const nvis = nvisCeilingMhz({ txLat: state.tx.lat, txLon: state.tx.lon, ssn, kp, subsolar });

  clearResultLayer();
  state.layers.result = makeFootprint(fp).addTo(state.map);

  const skip = fp.skipKm ? `${Math.round(fp.skipKm)} km` : 'none (local coverage)';
  const maxr = fp.maxReachKm ? `${Math.round(fp.maxReachKm)} km` : '—';
  const nvisOk = freq <= nvis;
  $('coverage-results').innerHTML = `
    <table>
      <tr><td>Frequency</td><td><b>${freq.toFixed(2)} MHz</b> (${nearestBand(freq).label})</td></tr>
      <tr><td>Skip distance</td><td>${skip}</td></tr>
      <tr><td>Max reach</td><td>${maxr}</td></tr>
      <tr><td>NVIS (overhead foF2)</td><td>${nvis.toFixed(1)} MHz — ${nvisOk
        ? '<span class="pill open">local coverage</span>'
        : '<span class="pill closed">skips over</span>'}</td></tr>
    </table>
    <p class="hint">Shaded rings = where this frequency lands. The gap nearest TX is the skip zone.</p>`;
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
  const analysis = analyzePath({
    lat1: state.a.lat, lon1: state.a.lon, lat2: state.b.lat, lon2: state.b.lon, ssn, kp, subsolar,
  });

  const useClutter = $('lyr-clutter').checked;
  const ground = useClutter
    ? groundReflectionLossDb(analysis.groundPoints)
    : { totalDb: 0, detail: [] };

  clearResultLayer();
  state.layers.result = makePath(state.a, state.b, analysis).addTo(state.map);
  state.map.fitBounds(L.latLngBounds([state.a.lat, state.a.lon], [state.b.lat, state.b.lon]).pad(0.3));

  // Best band: open band nearest FOT.
  const open = BANDS.filter((b) => bandStatus(analysis, b.mhz) === 'open');
  const best = open.length
    ? open.reduce((x, b) => (Math.abs(b.mhz - analysis.fotMhz) < Math.abs(x.mhz - analysis.fotMhz) ? b : x))
    : null;

  const rows = BANDS.map((b) => {
    const st = bandStatus(analysis, b.mhz);
    const rel = st === 'open' ? `${reliabilityPct(analysis, b.mhz, ground.totalDb)}%` : '—';
    const cls = best && b.name === best.name ? 'row-best' : '';
    return `<tr class="${cls}"><td>${b.label}</td><td><span class="pill ${st}">${st}</span></td><td>${rel}</td></tr>`;
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
    <p class="hint">FOT (≈0.85×MUF) is the day-to-day reliable working frequency.</p>`;
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
  clearResultLayer();
}

// --- Band selector -------------------------------------------------------

function initBands() {
  const sel = $('in-band');
  sel.innerHTML = BANDS.map((b) => `<option value="${b.name}">${b.label}</option>`).join('');
  sel.value = '20m';
  $('in-freq').value = bandByName('20m').mhz;
  sel.addEventListener('change', () => { $('in-freq').value = bandByName(sel.value).mhz; });
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

  $('btn-run-coverage').addEventListener('click', runCoverage);
  $('btn-run-path').addEventListener('click', runPath);

  $('btn-refresh-solar').addEventListener('click', loadSolar);
  $('btn-now').addEventListener('click', () => { setTimeInput(new Date()); redrawTerminator(); });
  $('in-time').addEventListener('change', redrawTerminator);
  $('in-sfi').addEventListener('change', () => { $('in-ssn').value = ssnFromSfi(Number($('in-sfi').value) || 0); });

  $('lyr-terminator').addEventListener('change', redrawTerminator);
  $('lyr-kc2g').addEventListener('change', toggleKc2g);
}

async function main() {
  initMap();
  initBands();
  setTimeInput(new Date());
  wire();
  redrawTerminator();
  await loadSolar();
}

main();
