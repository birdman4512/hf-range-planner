import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, buildPairs, slotTimes } from '../../tools/validate.js';

test('metrics: AUC, ties, and non-finite predictions', () => {
  assert.equal(metrics([1, 0, 1, 0], [0.9, 0.1, 0.8, 0.2]).auc, 1);
  assert.equal(metrics([1, 0, 1, 0], [0.3, 0.3, 0.3, 0.3]).auc, 0.5);
  // Non-finite values must not hang the tie grouping; they are counted and zeroed.
  const m = metrics([1, 0, 1], [NaN, 0.5, 0.5]);
  assert.equal(m.nonFinite, 1);
  assert.ok(Number.isFinite(m.logLoss));
  assert.ok(Number.isFinite(metrics([1, 0], [-0.2, 1.3]).brier));
});

test('buildPairs labels decodes and samples non-decodes at the true rate', () => {
  const spot = (tx, rx, lonTx, lonRx) => ({ t: 0, band: 14, tx, rx, txLat: 40, txLon: lonTx, rxLat: 50, rxLon: lonRx, dbm: 37, snr: -20 });
  // 2 transmitters × 3 receivers, 3 decodes observed.
  const spots = [spot('A', 'X', -100, 0), spot('A', 'Y', -100, 10), spot('B', 'Z', -80, 20)];
  const pairs = buildPairs(spots, { maxPos: 100 });
  assert.equal(pairs.filter((p) => p.y).length, 3);
  assert.equal(pairs.filter((p) => !p.y).length, 3); // A–Z, B–X, B–Y
  assert.ok(Math.abs(pairs[0].powerW - 5.01) < 0.01); // 37 dBm
});

test('slot times land on even minutes, newest first', () => {
  const ts = slotTimes(Date.UTC(2026, 9, 2, 12, 0), 3, 2);
  assert.equal(ts.length, 3);
  for (const t of ts) assert.equal(t.getTime() % 120000, 0);
  assert.ok(ts[0] > ts[1] && ts[1] > ts[2]);
});
