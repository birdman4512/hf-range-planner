import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxHopGroundKm, hopGeometry, analyzePath, bandStatus, coverageFootprint,
} from '../../src/propagation.js';
import { subsolarPoint } from '../../src/geo.js';

test('single-hop F2 max ground range is ~3700–4100 km', () => {
  const d = maxHopGroundKm(300);
  assert.ok(d > 3600 && d < 4100, `got ${d}`);
});

test('M-factor grows from ~1 (vertical) to ~3.4 (max range)', () => {
  const near = hopGeometry(100, 300);
  const far = hopGeometry(maxHopGroundKm(300) - 20, 300);
  assert.ok(near.mFactor < 1.1, `near ${near.mFactor}`);
  assert.ok(far.mFactor > 3.0 && far.mFactor < 3.5, `far ${far.mFactor}`);
  assert.ok(near.takeoffDeg > far.takeoffDeg, 'closer hop has higher takeoff angle');
});

test('daytime 2000 km path at solar max has a sensible MUF and FOT', () => {
  // Noon over the path: put both ends near the subsolar longitude.
  const ss = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  const a = analyzePath({
    lat1: ss.lat, lon1: ss.lon - 9,   // ~ +/- 1000 km east-west of subsolar
    lat2: ss.lat, lon2: ss.lon + 9,
    ssn: 180, kp: 1, subsolar: ss,
  });
  assert.equal(a.hopCount, 1, 'should be single hop under ~4000 km');
  assert.ok(a.mufMhz > 14 && a.mufMhz < 40, `MUF ${a.mufMhz}`);
  assert.ok(Math.abs(a.fotMhz - 0.85 * a.mufMhz) < 1e-6);
  assert.ok(a.lufMhz < a.mufMhz, 'LUF below MUF when path is open');
});

test('long path forces multiple hops', () => {
  const ss = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  const a = analyzePath({
    lat1: 0, lon1: 0, lat2: 0, lon2: 90, // ~10000 km
    ssn: 120, kp: 1, subsolar: ss,
  });
  assert.ok(a.hopCount >= 3, `got ${a.hopCount} hops`);
});

test('bandStatus classifies open/marginal/closed', () => {
  const fake = { lufMhz: 7, mufMhz: 21, fotMhz: 17.85 };
  assert.equal(bandStatus(fake, 14), 'open');
  assert.equal(bandStatus(fake, 22), 'marginal');
  assert.equal(bandStatus(fake, 28), 'closed');
  assert.equal(bandStatus(fake, 3.6), 'closed');
});

test('coverage footprint returns sectors and a skip distance for a high band', () => {
  const ss = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  const fp = coverageFootprint({
    txLat: ss.lat, txLon: ss.lon, freqMhz: 21.2,
    ssn: 150, kp: 1, subsolar: ss, azStepDeg: 30, dStepKm: 250,
  });
  assert.equal(fp.sectors.length, 12);
  assert.ok(fp.maxReachKm > 0, 'something should be reachable on 15m at solar max noon');
});
