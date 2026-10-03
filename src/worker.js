// worker.js — computes coverage grids off the main thread so the map stays
// responsive. Holds its own copy of the ionosonde observations and keeps the
// (expensive, frequency-independent) path preparations cached between requests,
// so toggling bands or modes only re-runs the cheap per-frequency evaluation.
//
// Messages in:
//   { type: 'stations', stations: { list, version, fetchedMs } | null }
//   { type: 'coverage', id, dateMs, nowMs, r12, kp, minTakeoffDeg, sys, origins: [{lat, lon}], freqsMhz }
// Messages out:
//   { type: 'coverage', id, results: [[grid, …] per origin] }   (cells transferred)
//   { type: 'error', id, message }

import { ionoField } from './iono.js';
import { coverageGrids } from './propagation.js';

let stations = null;
const prepCaches = new Map(); // key → Map(cell → prepared path); small LRU

function cacheFor(key) {
  if (prepCaches.has(key)) {
    const m = prepCaches.get(key);
    prepCaches.delete(key); prepCaches.set(key, m); // refresh LRU order
    return m;
  }
  const m = new Map();
  prepCaches.set(key, m);
  while (prepCaches.size > 4) prepCaches.delete(prepCaches.keys().next().value);
  return m;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'stations') {
    stations = m.stations
      ? Object.assign(m.stations.list, { version: m.stations.version, fetchedMs: m.stations.fetchedMs })
      : null;
    prepCaches.clear();
    return;
  }
  if (m.type !== 'coverage') return;
  try {
    const date = new Date(m.dateMs);
    const field = ionoField({ date, r12: m.r12, kp: m.kp, stations, nowMs: m.nowMs });
    const transfer = [];
    const results = m.origins.map((o) => {
      const key = [o.lat, o.lon, m.dateMs, m.r12, m.kp, stations ? stations.version : 0, m.minTakeoffDeg].join('|');
      const grids = coverageGrids({
        txLat: o.lat, txLon: o.lon, freqsMhz: m.freqsMhz, field, sys: m.sys,
        minTakeoffDeg: m.minTakeoffDeg, prepCache: cacheFor(key),
      });
      for (const g of grids) transfer.push(g.cells.buffer);
      return grids;
    });
    self.postMessage({ type: 'coverage', id: m.id, results }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack ? err.stack : err) });
  }
};
