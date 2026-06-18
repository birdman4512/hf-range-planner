import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foF2, foE, absorptionIndex, hmF2, ionoAt } from '../../src/iono.js';

test('foE is higher at noon than at night', () => {
  assert.ok(foE(1, 100) > foE(-0.5, 100));
  assert.ok(foE(-1, 100) >= 0.5, 'night floor');
});

test('foF2 sits in realistic MHz ranges', () => {
  const maxNoon = foF2(1, 180);
  const minNight = foF2(-0.5, 0);
  const minNoon = foF2(1, 0);
  assert.ok(maxNoon > 11 && maxNoon < 16, `solar-max noon ${maxNoon}`);
  assert.ok(minNight > 1.5 && minNight < 3, `solar-min night ${minNight}`);
  assert.ok(minNoon > 5 && minNoon < 8, `solar-min noon ${minNoon}`);
});

test('geomagnetic storm depresses foF2 at high latitude', () => {
  const quiet = foF2(1, 120, { kp: 0, absLat: 65 });
  const storm = foF2(1, 120, { kp: 7, absLat: 65 });
  assert.ok(storm < quiet, `${storm} should be < ${quiet}`);
});

test('absorption is zero at night, positive by day', () => {
  assert.equal(absorptionIndex(-0.3, 120), 0);
  assert.ok(absorptionIndex(1, 120) > 0);
});

test('F2 height rises with solar activity', () => {
  assert.ok(hmF2(1, 180) > hmF2(1, 0));
});

test('ionoAt bundles consistent values', () => {
  const p = ionoAt({ cosZenith: 1, ssn: 120 });
  assert.ok(p.foF2 > p.foE, 'F2 critical above E critical at noon');
  assert.ok(p.hmF2 > p.hmE);
});
