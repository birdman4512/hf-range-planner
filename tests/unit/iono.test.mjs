import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ccirEvaluator, foE, mirrorHeightKm, stormFactor, buildIonoField, phiFromR12,
} from '../../src/iono.js';
import { magAt } from '../../src/magnetic.js';

const fo = (date, r12, lat, lon) => ccirEvaluator(date, r12)(lat, lon, magAt(lat, lon).modip);
// Boulder-ish site; local solar time ≈ UT − 7 h.
const atLocal = (month, lt) => new Date(Date.UTC(2026, month, 15, (lt + 7) % 24));

test('CCIR foF2 has a realistic mid-latitude diurnal shape', () => {
  const noon = fo(atLocal(2, 14), 100, 40, -105).foF2;
  const predawn = fo(atLocal(2, 4), 100, 40, -105).foF2;
  const evening = fo(atLocal(2, 20), 100, 40, -105).foF2;
  assert.ok(noon > 8 && noon < 13, `afternoon ${noon}`);
  assert.ok(predawn > 3 && predawn < 6, `pre-dawn ${predawn}`);
  // F2 decays slowly after sunset: 20 LT is still well above the pre-dawn minimum.
  assert.ok(evening > predawn * 1.2, `evening ${evening} vs pre-dawn ${predawn}`);
});

test('winter anomaly: NH mid-latitude noon foF2 higher in December than June', () => {
  const dec = fo(new Date(Date.UTC(2026, 11, 15, 12)), 100, 50, 10).foF2;
  const jun = fo(new Date(Date.UTC(2026, 5, 15, 12)), 100, 50, 10).foF2;
  assert.ok(dec > jun * 1.2, `Dec ${dec} vs Jun ${jun}`);
});

test('equatorial anomaly: evening crests either side of the dip equator', () => {
  const d = new Date(Date.UTC(2026, 2, 16, 1)); // ≈ 20 LT at 75°W
  const trough = fo(d, 150, -10, -75).foF2;      // dip equator ≈ 12°S here
  const north = fo(d, 150, 5, -75).foF2;
  const south = fo(d, 150, -25, -75).foF2;
  assert.ok(north > trough * 1.3 && south > trough * 1.3, `${south} | ${trough} | ${north}`);
});

test('foF2 grows with solar activity and saturates above R12 = 160', () => {
  const d = new Date(Date.UTC(2026, 2, 15, 19));
  const lo = fo(d, 0, 40, -105).foF2, hi = fo(d, 150, 40, -105).foF2;
  assert.ok(hi > lo * 1.4, `${lo} → ${hi}`);
  assert.equal(fo(d, 250, 40, -105).foF2, fo(d, 160, 40, -105).foF2);
});

test('M(3000)F2 stays in its physical range', () => {
  for (const h of [0, 6, 12, 18]) {
    const m = fo(new Date(Date.UTC(2026, 5, 15, h)), 80, 35, 140).M3000;
    assert.ok(m > 2.3 && m < 4.0, `M3000 ${m}`);
  }
});

test('P.1239 foE: ~3.5–4 MHz summer noon at R12 100, ~0.5–0.8 at night', () => {
  const noon = foE(40, Math.cos((40 - 23.4) * Math.PI / 180), 23.4, 100);
  const night = foE(40, -0.5, 23.4, 100);
  assert.ok(noon > 3.3 && noon < 4.2, `noon ${noon}`);
  assert.ok(night > 0.4 && night < 0.9, `night ${night}`);
  assert.ok(Math.abs(phiFromR12(100) - 145.4) < 0.5);
});

test('P.533 mirror height is ~250–400 km', () => {
  const day = mirrorHeightKm(3.2, 9, 3.4, 100);
  const night = mirrorHeightKm(2.8, 4, 0.6, 100);
  assert.ok(day > 240 && day < 330, `day ${day}`);
  assert.ok(night > day && night < 420, `night ${night}`);
});

test('storm depression only above Kp 3 and stronger at high geomagnetic latitude', () => {
  assert.equal(stormFactor(2, 65), 1);
  assert.ok(stormFactor(7, 65) < stormFactor(7, 45));
  assert.ok(stormFactor(7, 65) >= 0.5);
  assert.equal(stormFactor(7, 20), 1);
});

test('field interpolates the CCIR grid closely and exposes all parameters', () => {
  const date = new Date(Date.UTC(2026, 9, 2, 18));
  const f = buildIonoField({ date, r12: 80, kp: 1 });
  const p = f.at(40, -100);
  const direct = fo(date, 80, 40, -100).foF2;
  assert.ok(Math.abs(p.foF2 / direct - 1) < 0.04, `${p.foF2} vs ${direct}`);
  for (const k of ['cosZ', 'foF2', 'M3000', 'foE', 'hr', 'fH', 'mlat', 'sigma']) {
    assert.ok(Number.isFinite(p[k]), k);
  }
});
