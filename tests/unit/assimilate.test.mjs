import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStations, computeAssimilation, fitEffectiveR, gaussianProcess } from '../../src/assimilate.js';
import { ccirEvaluator, buildIonoField } from '../../src/iono.js';
import { magAt } from '../../src/magnetic.js';
import { STATIONS, FETCHED_MS } from '../fixtures/kc2g-2026-10-02.js';

const modelFor = (d) => {
  const e0 = ccirEvaluator(d, 0), e1 = ccirEvaluator(d, 100);
  return (lat, lon) => {
    const m = magAt(lat, lon).modip;
    const a = e0(lat, lon, m), b = e1(lat, lon, m);
    return { f0: a.foF2, f100: b.foF2, m0: a.M3000, m100: b.M3000 };
  };
};

test('parseStations keeps fresh, confident GIRO records and normalises longitude', () => {
  const st = parseStations(STATIONS, FETCHED_MS);
  assert.ok(st.length >= 20, `usable ${st.length}`);
  for (const s of st) {
    assert.ok(s.lon >= -180 && s.lon <= 180);
    assert.ok(FETCHED_MS - s.timeMs <= 3 * 3600e3);
    assert.ok(s.foF2 > 0.5);
  }
  assert.ok(st.version > 0);
});

test('fitEffectiveR recovers the activity level that generated the data', () => {
  const m = modelFor(new Date(FETCHED_MS));
  const obs = [[40, -100], [50, 10], [-30, 150], [35, 140], [-25, -50], [60, 20]].map(([la, lo]) => {
    const v = m(la, lo);
    return { ...v, foF2: v.f0 + (v.f100 - v.f0) * 0.42, w: 1 };
  });
  assert.ok(Math.abs(fitEffectiveR(obs) - 42) < 0.6);
});

test('GP reproduces a station value and relaxes to zero far away', () => {
  const u = (lat, lon) => [Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180)];
  const pts = [{ u: u(40, -100), t: 0, q: 1, r: 0.3 }];
  const gp = gaussianProcess(pts, (p) => p.r, { sd: 0.18, lengthKm: 1500, tauH: 3, noiseSd: 0.02 });
  const near = gp.predict(u(40, -100), 0), far = gp.predict(u(-40, 80), 0);
  assert.ok(Math.abs(near.mean - 0.3) < 0.02 && near.confidence > 0.9);
  assert.ok(Math.abs(far.mean) < 1e-3 && far.confidence < 0.01);
  // Fades in time too.
  assert.ok(gp.predict(u(40, -100), 12 * 3600e3).mean < 0.02);
});

test('leave-one-out on real ionosonde data: assimilation beats the median model', () => {
  const st = parseStations(STATIONS, FETCHED_MS);
  const date = new Date(FETCHED_MS);
  const m = modelFor(date);
  let eModel = 0, eAssim = 0;
  for (let i = 0; i < st.length; i++) {
    const rest = Object.assign(st.filter((_, j) => j !== i), { fetchedMs: FETCHED_MS, version: 1 });
    const a = computeAssimilation({ date, r12: 60, stations: rest, nowMs: FETCHED_MS, modelFor });
    const o = st[i], v = m(o.lat, o.lon);
    const base = v.f0 + (v.f100 - v.f0) * a.r12Fit / 100;
    const pred = base * Math.exp(a.correctionAt(o.lat, o.lon).dlnF);
    const plain = v.f0 + (v.f100 - v.f0) * 0.60;
    eModel += Math.log(o.foF2 / plain) ** 2;
    eAssim += Math.log(o.foF2 / pred) ** 2;
  }
  const rmsModel = Math.sqrt(eModel / st.length), rmsAssim = Math.sqrt(eAssim / st.length);
  assert.ok(rmsAssim < 0.75 * rmsModel, `assim ${rmsAssim.toFixed(3)} vs model ${rmsModel.toFixed(3)}`);
});

test('assimilated field matches stations and carries higher confidence near them', () => {
  const st = parseStations(STATIONS, FETCHED_MS);
  const f = buildIonoField({ date: new Date(FETCHED_MS), r12: 60, kp: 2, stations: st, nowMs: FETCHED_MS });
  assert.ok(f.assimilated && f.stationsUsed >= 20);
  let e = 0;
  for (const s of st) e += Math.log(s.foF2 / f.at(s.lat, s.lon).foF2) ** 2;
  assert.ok(Math.sqrt(e / st.length) < 0.1);
  // Narrower MUF spread over Europe (dense ionosondes) than over the South Pacific.
  assert.ok(f.at(50, 10).sigma < f.at(-40, -130).sigma);
});
