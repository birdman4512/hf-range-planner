import { test } from 'node:test';
import assert from 'node:assert/strict';
import { igrfField, dipolePole, geomagLat, magAt, modipDeg } from '../../src/magnetic.js';

// Reference values: BGS IGRF-14 web service (geodetic), 2026-01-01. Our evaluation
// is geocentric, which shifts dip by up to ~0.4° at mid-latitudes.
test('IGRF reproduces known surface field at Boulder, CO', () => {
  const f = igrfField(40.0, -105.25, 0, 2026.0);
  assert.ok(Math.abs(f.dipDeg - 66.04) < 0.6, `dip ${f.dipDeg}`);
  assert.ok(Math.abs(f.F - 51194) < 400, `F ${f.F}`);
  assert.ok(f.decDeg > 6 && f.decDeg < 10, `declination ${f.decDeg}`);
});

test('IGRF reproduces known surface field at London', () => {
  const f = igrfField(51.5, -0.1, 0, 2026.0);
  assert.ok(Math.abs(f.dipDeg - 66.53) < 0.6, `dip ${f.dipDeg}`);
  assert.ok(Math.abs(f.F - 49096) < 400, `F ${f.F}`);
});

test('dip equator passes near Huancayo / Jicamarca, Peru', () => {
  const f = igrfField(-12.04, -75.32, 0, 2026.0);
  assert.ok(Math.abs(f.dipDeg + 1.83) < 0.6, `dip ${f.dipDeg}`);
});

test('geomagnetic north pole is near 80.7°N, 72.7°W', () => {
  const p = dipolePole(2026.0);
  assert.ok(Math.abs(p.lat - 80.8) < 0.6, `lat ${p.lat}`);
  assert.ok(Math.abs(p.lon + 72.7) < 1.5, `lon ${p.lon}`);
  // North America sits ~10° higher in geomagnetic latitude than Europe at equal latitude.
  assert.ok(geomagLat(45, -90, p) - geomagLat(45, 10, p) > 7);
});

test('modip is 0 at the dip equator and ±90 at the dip poles', () => {
  assert.equal(modipDeg(0, 10), 0);
  assert.ok(modipDeg(89.9, 89.9) > 85);
  // Mid-latitude: modip sits a little below the dip itself (≈ 61.6° for I=75°, φ=60°).
  assert.ok(Math.abs(modipDeg(75, 60) - 61.6) < 0.3);
});

test('gridded magAt gives sensible modip and gyrofrequency', () => {
  const m = magAt(40, -105);
  assert.ok(m.modip > 50 && m.modip < 70, `modip ${m.modip}`);
  assert.ok(m.fH > 1.1 && m.fH < 1.6, `fH ${m.fH}`);
  assert.ok(m.mlat > 45 && m.mlat < 52, `mlat ${m.mlat}`);
});
