import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manMadeFa, galacticFa, atmosphericFa, totalNoiseFa, noiseEnvById } from '../../src/noise.js';

test('P.372 man-made noise curves', () => {
  const res = noiseEnvById('residential');
  assert.ok(Math.abs(manMadeFa(res, 14) - 40.75) < 0.1);
  assert.ok(manMadeFa(noiseEnvById('city'), 7) > manMadeFa(noiseEnvById('quiet'), 7) + 20);
  assert.ok(Math.abs(galacticFa(10) - 29) < 0.01);
});

test('atmospheric noise: louder at night, in summer, in the tropics, and at low frequency', () => {
  const doyJul = 196;
  assert.ok(atmosphericFa(3.6, 40, -0.5, doyJul) > atmosphericFa(3.6, 40, 0.8, doyJul) + 15);
  assert.ok(atmosphericFa(3.6, 40, -0.5, doyJul) > atmosphericFa(3.6, 40, -0.5, 15) + 8);
  assert.ok(atmosphericFa(3.6, 5, -0.5, doyJul) > atmosphericFa(3.6, 60, -0.5, doyJul));
  assert.ok(atmosphericFa(1.9, 40, -0.5, doyJul) > atmosphericFa(14, 40, -0.5, doyJul) + 20);
});

test('total noise: atmospheric dominates 160 m summer nights; galactic only above foF2', () => {
  const env = noiseEnvById('quiet');
  const night160 = totalNoiseFa({ env, freqMhz: 1.9, lat: 35, cosZ: -0.5, dayOfYear: 196, foF2: 5 });
  assert.ok(night160 > manMadeFa(env, 1.9) + 5);
  const with28 = totalNoiseFa({ env, freqMhz: 28, lat: 50, cosZ: 0.5, dayOfYear: 15, foF2: 5 });
  const without28 = totalNoiseFa({ env, freqMhz: 28, lat: 50, cosZ: 0.5, dayOfYear: 15, foF2: 30 });
  assert.ok(with28 > without28);
});
