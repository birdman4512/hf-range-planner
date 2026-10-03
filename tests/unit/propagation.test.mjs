import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxHopGroundKm, hopGeometry, f2BasicMuf, f2Dmax, phi, preparePath, evalPath, analyzePath,
  coverageGrids, statusFor, disturbanceAbsDb, pathMuf, bestBandAt,
} from '../../src/propagation.js';
import { buildIonoField } from '../../src/iono.js';
import { reflectionLossDb, classifySurface, isLand } from '../../src/clutter.js';
import { antennaGainDbi } from '../../src/antenna.js';

const sys = (over = {}) => ({
  powerW: 100, txAnt: { type: 'dipole', heightM: 10 }, rxAnt: { type: 'dipole', heightM: 10 },
  reqDbHz: 14, noiseEnv: 'residential', clutter: true, spaceWx: { kp: 2 }, ...over,
});
const field = (iso, r12 = 80) => buildIonoField({ date: new Date(iso), r12, kp: 2 });

test('single-hop geometry: max range, M-factor, slant length', () => {
  const d = maxHopGroundKm(300);
  assert.ok(d > 3600 && d < 4100, `max hop ${d}`);
  assert.ok(maxHopGroundKm(300, 3) < d);
  const near = hopGeometry(100, 300), far = hopGeometry(3000, 300);
  assert.ok(near.mFactor < 1.1 && far.mFactor > 3.0 && far.mFactor < 3.5);
  assert.ok(near.takeoffDeg > far.takeoffDeg);
  assert.ok(far.slantKm > 3000 && far.slantKm < 3400, `slant ${far.slantKm}`);
});

test('P.1240 MUF: foF2 + fH/2 at vertical, ≈ B·foF2 at 3000 km', () => {
  const c = { foF2: 8, foE: 3, M3000: 3.2, fH: 1.2 };
  assert.ok(Math.abs(f2BasicMuf(0, c) - (8 + 0.6)) < 0.05);
  const { B, dmax } = f2Dmax(c);
  assert.ok(dmax <= 4000 && dmax >= 2500);
  assert.ok(Math.abs(f2BasicMuf(3000, c) - (B * 8 + 0.6 * (1 - 3000 / dmax))) < 0.05);
  assert.ok(f2BasicMuf(3500, c) > f2BasicMuf(1000, c));
});

test('normal CDF', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(phi(1.2816) - 0.9) < 1e-3);
  assert.ok(Math.abs(phi(-1.2816) - 0.1) < 1e-3);
});

test('transatlantic path: F2 modes, daytime MUF far above night-time MUF', () => {
  const day = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T15:00:00Z') });
  const night = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T05:00:00Z') });
  assert.ok(day.modes.some((m) => m.layer === 'F2'));
  assert.ok(day.modes.every((m) => m.layer === 'F2'), 'no E modes beyond 4000 km');
  assert.ok(pathMuf(day) > 1.5 * pathMuf(night), `${pathMuf(day)} vs ${pathMuf(night)}`);
  assert.ok(pathMuf(day) > 15 && pathMuf(day) < 40);
});

test('reliability: 20 m transatlantic open by day for FT8, 10 m above the night MUF', () => {
  const d = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T15:00:00Z') });
  const n = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T05:00:00Z') });
  assert.ok(evalPath(d, 14.1, sys()).reliability > 0.5);
  const r10 = evalPath(n, 28.3, sys());
  assert.ok(r10.reliability < 0.1 && r10.limit === 'muf', `10 m night ${r10.reliability} ${r10.limit}`);
});

test('far above the MUF reliability falls to ~0 and never rises with frequency', () => {
  const n = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T05:00:00Z') });
  const muf = pathMuf(n);
  let prev = Infinity;
  for (const f of [1.5, 2, 3, 4].map((k) => k * muf)) {
    const r = evalPath(n, f, sys({ reqDbHz: 6 })).reliability;
    assert.ok(r <= prev + 1e-9, `rel rose to ${r} at ${f.toFixed(1)} MHz`);
    prev = r;
  }
  assert.ok(prev < 0.01, `rel at 4×MUF ${prev}`);
});

test('SSB needs ~30 dB more than FT8: reliability ordering holds', () => {
  const p = preparePath({ lat1: 51.5, lon1: -0.1, lat2: 40.7, lon2: -74, field: field('2026-10-02T15:00:00Z') });
  const ft8 = evalPath(p, 14.1, sys()).reliability;
  const ssb = evalPath(p, 14.1, sys({ reqDbHz: 44 })).reliability;
  const qrp = evalPath(p, 14.1, sys({ reqDbHz: 44, powerW: 5 })).reliability;
  assert.ok(ft8 >= ssb && ssb >= qrp, `${ft8} ${ssb} ${qrp}`);
});

test('daytime D-layer absorption: much worse on 80 m than 20 m, and gone at night', () => {
  const day = preparePath({ lat1: 40, lon1: -105, lat2: 41.9, lon2: -87.6, field: field('2026-06-21T18:00:00Z') });
  const night = preparePath({ lat1: 40, lon1: -105, lat2: 41.9, lon2: -87.6, field: field('2026-06-21T07:00:00Z') });
  const a80 = evalPath(day, 3.6, sys()), a20 = evalPath(day, 14.1, sys());
  assert.ok(a80.absorptionDb > 3 * a20.absorptionDb, `${a80.absorptionDb} vs ${a20.absorptionDb}`);
  assert.ok(evalPath(night, 3.6, sys()).absorptionDb < a80.absorptionDb / 4);
});

test('NVIS: 300 km path is covered on 80/40 m by a low dipole in daytime', () => {
  const p = preparePath({ lat1: 40, lon1: -105, lat2: 42.6, lon2: -104.5, field: field('2026-03-20T19:00:00Z') });
  const low = { type: 'dipole', heightM: 6 };
  const r = Math.max(evalPath(p, 3.6, sys({ txAnt: low, rxAnt: low })).reliability,
    evalPath(p, 7.1, sys({ txAnt: low, rxAnt: low })).reliability);
  assert.ok(r > 0.5, `NVIS reliability ${r}`);
});

test('E-layer screening blocks low-frequency F2 modes on a sunlit short path', () => {
  const p = preparePath({ lat1: 40, lon1: -105, lat2: 41.9, lon2: -87.6, field: field('2026-06-21T18:00:00Z') });
  const f2 = p.modes.find((m) => m.layer === 'F2');
  assert.ok(f2.fScreen > 3, `screening frequency ${f2.fScreen}`);
  const r = evalPath(p, 3.6, sys());
  assert.ok(!r.mode || r.mode.layer !== 'F2' || r.mode.fScreen <= 3.6);
});

test('long-path analysis exists and is longer than half the circumference', () => {
  const a = analyzePath({ lat1: -33.9, lon1: 151.2, lat2: 51.5, lon2: -0.1, field: field('2026-10-02T07:00:00Z'), sys: sys() });
  assert.ok(a.long.distanceKm > 20015 && a.short.distanceKm < 20015);
  assert.ok(a.short.hopCount >= 4);
});

test('disturbances: auroral absorption with Kp, flare absorption on the dayside only', () => {
  const pen = { mlat: 62, fH: 1.3, cosZ: 0.8 };
  assert.ok(disturbanceAbsDb(pen, 7, { kp: 7 }) > 5 * disturbanceAbsDb(pen, 7, { kp: 1 }));
  const flare = disturbanceAbsDb({ mlat: 10, fH: 1, cosZ: 0.9 }, 7, { kp: 0, xrayWm2: 1e-4 });
  const flareNight = disturbanceAbsDb({ mlat: 10, fH: 1, cosZ: -0.3 }, 7, { kp: 0, xrayWm2: 1e-4 });
  assert.ok(flare > 5 && flareNight < 0.01, `${flare} / ${flareNight}`);
});

test('ground: land mask, sea reflects better than land, ice worst', () => {
  assert.ok(isLand(48.85, 2.35) && !isLand(40, -40) && isLand(-80, 0));
  assert.equal(classifySurface(30, -40), 'sea');
  assert.equal(classifySurface(-80, 0), 'ice');
  const sea = reflectionLossDb('sea', 14, 10), land = reflectionLossDb('land', 14, 10), ice = reflectionLossDb('ice', 14, 10);
  assert.ok(sea < 0.5 && land > sea + 1 && ice > land, `${sea} ${land} ${ice}`);
});

test('antennas: a vertical has a ground-level null; a higher dipole favours lower angles', () => {
  assert.ok(antennaGainDbi({ type: 'vertical' }, 14, 0.5) < -15);
  assert.ok(antennaGainDbi({ type: 'vertical' }, 14, 20) > -3);
  const hi = antennaGainDbi({ type: 'dipole', heightM: 20 }, 14, 8);
  const lo = antennaGainDbi({ type: 'dipole', heightM: 5 }, 14, 8);
  assert.ok(hi > lo + 4, `${hi} vs ${lo}`);
  assert.ok(antennaGainDbi({ type: 'dipole', heightM: 5 }, 7, 85) > antennaGainDbi({ type: 'dipole', heightM: 5 }, 7, 10));
  assert.equal(antennaGainDbi({ type: 'iso' }, 14, 10), 0);
});

test('coverage grids share path preparation across bands', () => {
  const f = field('2026-10-02T15:00:00Z');
  const cache = new Map();
  const [g20, g10] = coverageGrids({ txLat: 40, txLon: -100, freqsMhz: [14.1, 28.3], field: f, sys: sys(), latStep: 10, lonStep: 10, prepCache: cache });
  assert.ok(cache.size > 100);
  assert.ok(g20.maxReachKm > 3000, `20 m reach ${g20.maxReachKm}`);
  assert.ok(g20.cells.some((v) => v > 128));
  assert.ok(g10.cells.reduce((a, v) => a + v, 0) <= g20.cells.reduce((a, v) => a + v, 0) * 1.5);
});

test('status thresholds', () => {
  assert.equal(statusFor(0.8), 'open');
  assert.equal(statusFor(0.3), 'marginal');
  assert.equal(statusFor(0.05), 'closed');
});

test('best band per cell: highest reliability, near-ties go to the higher band', () => {
  const g = (...v) => ({ cells: Uint8Array.from(v) });
  // cell 0: 255 vs 250 (tie within 5 %) → higher band; cell 1: clear winner; cell 2: nothing.
  const grids = [g(255, 255, 0), g(250, 100, 0)];
  assert.deepEqual(bestBandAt(grids, 0), { index: 1, value: 250 });
  assert.deepEqual(bestBandAt(grids, 1), { index: 0, value: 255 });
  assert.equal(bestBandAt(grids, 2).index, -1);
});
