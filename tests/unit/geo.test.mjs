import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  greatCircleKm, bearingDeg, destinationPoint, intermediatePoint,
  subsolarPoint, cosZenith, zenithAngleDeg, nightPolygon,
} from '../../src/geo.js';

const LON = [51.5074, -0.1278];   // London
const NYC = [40.7128, -74.006];   // New York

test('great-circle London↔NYC ≈ 5570 km', () => {
  const d = greatCircleKm(...LON, ...NYC);
  assert.ok(Math.abs(d - 5570) < 120, `got ${d}`);
});

test('bearing London→NYC is roughly west-northwest', () => {
  const b = bearingDeg(...LON, ...NYC);
  assert.ok(b > 270 && b < 305, `got ${b}`);
});

test('destinationPoint is the inverse of distance/bearing', () => {
  const [lat, lon] = destinationPoint(51.5, -0.13, 90, 1000);
  const back = greatCircleKm(51.5, -0.13, lat, lon);
  assert.ok(Math.abs(back - 1000) < 1, `got ${back}`);
});

test('intermediate point at f=0.5 is ~half the distance from each end', () => {
  const [lat, lon] = intermediatePoint(...LON, ...NYC, 0.5);
  const dA = greatCircleKm(...LON, lat, lon);
  const dB = greatCircleKm(lat, lon, ...NYC);
  assert.ok(Math.abs(dA - dB) < 1, `halves differ: ${dA} vs ${dB}`);
});

test('subsolar point at equinox noon UTC is near (0,0)', () => {
  const ss = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(ss.lat) < 2, `lat ${ss.lat}`);
  assert.ok(Math.abs(ss.lon) < 5, `lon ${ss.lon}`);
});

test('cosZenith is ~1 at the subsolar point and negative on the night side', () => {
  const ss = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  assert.ok(cosZenith(ss.lat, ss.lon, ss) > 0.99);
  // Antipodal longitude is local midnight → sun well below horizon.
  const nightLon = ((ss.lon + 180 + 540) % 360) - 180;
  assert.ok(cosZenith(ss.lat, nightLon, ss) < 0, 'night side should be negative');
  assert.ok(zenithAngleDeg(ss.lat, ss.lon, ss) < 5);
});

test('night polygon is a closed ring that reaches the dark pole', () => {
  const ss = subsolarPoint(new Date('2026-06-21T12:00:00Z')); // sun north
  const ring = nightPolygon(ss, 5);
  assert.ok(ring.length > 50, 'enough vertices');
  // Sun is north at the June solstice → the south pole is in darkness.
  assert.ok(ring.some(([lat]) => lat <= -89), 'closes toward the south pole');
});
