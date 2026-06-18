// geo.js — great-circle geometry and solar position.
// Pure functions, no DOM. Unit-testable in Node.

export const EARTH_RADIUS_KM = 6371.0;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const toRad = (d) => d * DEG;
export const toDeg = (r) => r * RAD;

/**
 * Great-circle distance between two lat/lon points (degrees) in km. Haversine.
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing (degrees, 0=N clockwise) from point 1 to point 2.
 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Destination point given start (degrees), bearing (degrees) and distance (km).
 * Returns [lat, lon] in degrees, lon normalised to [-180, 180].
 */
export function destinationPoint(lat, lon, bearing, distanceKm) {
  const δ = distanceKm / EARTH_RADIUS_KM;
  const θ = toRad(bearing);
  const φ1 = toRad(lat), λ1 = toRad(lon);
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

/**
 * Intermediate point at fraction f (0..1) along the great circle from 1 to 2.
 * Used to sample the ionosphere at hop reflection points.
 */
export function intermediatePoint(lat1, lon1, lat2, lon2, f) {
  const φ1 = toRad(lat1), λ1 = toRad(lon1), φ2 = toRad(lat2), λ2 = toRad(lon2);
  const δ = greatCircleKm(lat1, lon1, lat2, lon2) / EARTH_RADIUS_KM;
  if (δ === 0) return [lat1, lon1];
  const a = Math.sin((1 - f) * δ) / Math.sin(δ);
  const b = Math.sin(f * δ) / Math.sin(δ);
  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
  const z = a * Math.sin(φ1) + b * Math.sin(φ2);
  const φ = Math.atan2(z, Math.hypot(x, y));
  const λ = Math.atan2(y, x);
  return [toDeg(φ), toDeg(λ)];
}

// --- Solar position -------------------------------------------------------

/**
 * Day-of-year fractional from a Date (UTC).
 */
function dayOfYearUTC(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start;
  return diff / 86400000; // days incl. fractional
}

/**
 * Subsolar point (latitude, longitude in degrees) for a given Date (UTC).
 * Low-precision NOAA-style approximation; good to a fraction of a degree —
 * ample for ionospheric zenith-angle work.
 */
export function subsolarPoint(date) {
  const n = dayOfYearUTC(date);
  // Solar declination (Cooper's approximation), degrees.
  const decl = -23.44 * Math.cos(toRad((360 / 365) * (n + 10)));
  // Equation of time (minutes) — approximate.
  const B = toRad((360 / 365) * (n - 81));
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  // Longitude of the subsolar point: noon (sun overhead) tracks westward.
  let lon = -15 * (utcHours - 12 + eot / 60);
  lon = ((lon + 540) % 360) - 180;
  return { lat: decl, lon };
}

/**
 * Cosine of the solar zenith angle at (lat, lon) for the given subsolar point.
 * Returns value in [-1, 1]; negative means the sun is below the horizon (night).
 */
export function cosZenith(lat, lon, subsolar) {
  const φ = toRad(lat), δ = toRad(subsolar.lat);
  const H = toRad(lon - subsolar.lon); // hour angle from subsolar longitude
  return Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H);
}

/**
 * Solar zenith angle (degrees) at a point. 0 = sun overhead, 90 = horizon.
 */
export function zenithAngleDeg(lat, lon, subsolar) {
  return toDeg(Math.acos(Math.max(-1, Math.min(1, cosZenith(lat, lon, subsolar)))));
}

/**
 * Day/night terminator as an array of [lat, lon] points (the great circle 90°
 * from the subsolar point). Useful for drawing the boundary line.
 */
export function terminatorPolyline(subsolar, steps = 180) {
  // Antisolar point is the centre of the night hemisphere; the terminator is the
  // set of points 90° from the subsolar point.
  const pts = [];
  const antilat = -subsolar.lat;
  const antilon = ((subsolar.lon + 180 + 540) % 360) - 180;
  for (let i = 0; i <= steps; i++) {
    const brg = (360 * i) / steps;
    pts.push(destinationPoint(antilat, antilon, brg, EARTH_RADIUS_KM * (Math.PI / 2)));
  }
  return pts;
}

/**
 * Closed polygon ring [[lat,lon],...] covering the NIGHT hemisphere, suitable
 * for a dark shaded overlay. Terminator latitude as a function of longitude
 * (where solar zenith = 90°), closed toward whichever pole is in darkness.
 */
export function nightPolygon(subsolar, stepDeg = 2) {
  const δ = subsolar.lat;
  const tanδ = Math.tan(toRad(δ)) || 1e-6; // avoid divide-by-zero at equinox
  const pts = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const H = toRad(lon - subsolar.lon);
    const lat = toDeg(Math.atan(-Math.cos(H) / tanδ));
    pts.push([lat, lon]);
  }
  // Close the ring along the dark pole: sun north (δ≥0) ⇒ south pole is dark.
  const darkPole = δ >= 0 ? -90 : 90;
  pts.push([darkPole, 180], [darkPole, -180]);
  return pts;
}
