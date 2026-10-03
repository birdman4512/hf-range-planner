// magnetic.js — Earth's main magnetic field from IGRF-14.
// Supplies what the ionospheric model needs from the field:
//   * magnetic dip → MODIP (Rawer's modified dip latitude), the coordinate the
//     CCIR foF2/M(3000) maps are expressed in;
//   * dipole geomagnetic latitude (auroral oval, storm effects, polar cap);
//   * electron gyrofrequency fH (absorption and the X-mode MUF term).
// Field evaluated in geocentric spherical coordinates (the ~0.2° geodetic
// correction is far below what matters here).

import { IGRF, IGRF_EPOCH, IGRF_NMAX } from './data/igrf.js';

const DEG = Math.PI / 180;
const A = 6371.2; // IGRF reference radius (km)

function coeffsFor(year) {
  const dt = Math.max(-5, Math.min(10, year - IGRF_EPOCH));
  const N = IGRF_NMAX;
  const g = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  const h = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  for (const [n, m, gv, hv, dg, dh] of IGRF) {
    g[n][m] = gv + dg * dt;
    h[n][m] = hv + dh * dt;
  }
  return { g, h };
}

let cached = { year: NaN, c: null };
function coeffs(year) {
  const y = Math.round(year * 10) / 10;
  if (cached.year !== y) cached = { year: y, c: coeffsFor(y) };
  return cached.c;
}

/**
 * Magnetic field at (lat, lon) degrees and altitude (km). Returns north/east/
 * down components X, Y, Z and total F (nT), plus dip I and declination D (deg).
 */
export function igrfField(lat, lon, altKm = 0, year = 2026.0) {
  const { g, h } = coeffs(year);
  const N = IGRF_NMAX;
  const r = A + altKm;
  const θ = (90 - lat) * DEG;
  const φ = lon * DEG;
  const ct = Math.cos(θ);
  const st = Math.max(1e-9, Math.sin(θ));

  // Schmidt semi-normalised associated Legendre functions and θ-derivatives.
  const P = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  const dP = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  P[0][0] = 1;
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        if (n === 1) { P[1][1] = st; dP[1][1] = ct; }
        else {
          const k = Math.sqrt((2 * n - 1) / (2 * n));
          P[n][n] = k * st * P[n - 1][n - 1];
          dP[n][n] = k * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
        }
      } else {
        const k1 = (2 * n - 1) / Math.sqrt(n * n - m * m);
        const k2 = n - 2 >= m ? Math.sqrt(((n - 1) ** 2 - m * m) / (n * n - m * m)) : 0;
        const Pm2 = n - 2 >= m ? P[n - 2][m] : 0;
        const dPm2 = n - 2 >= m ? dP[n - 2][m] : 0;
        P[n][m] = k1 * ct * P[n - 1][m] - k2 * Pm2;
        dP[n][m] = k1 * (ct * dP[n - 1][m] - st * P[n - 1][m]) - k2 * dPm2;
      }
    }
  }

  let Br = 0, Bt = 0, Bp = 0;
  let ar = (A / r) ** 2;
  for (let n = 1; n <= N; n++) {
    ar *= A / r; // (a/r)^(n+2)
    for (let m = 0; m <= n; m++) {
      const cm = Math.cos(m * φ), sm = Math.sin(m * φ);
      const gh = g[n][m] * cm + h[n][m] * sm;
      Br += (n + 1) * ar * gh * P[n][m];
      Bt -= ar * gh * dP[n][m];
      Bp -= ar * m * (-g[n][m] * sm + h[n][m] * cm) * P[n][m] / st;
    }
  }
  const X = -Bt, Y = Bp, Z = -Br;
  const H = Math.hypot(X, Y);
  return {
    X, Y, Z, F: Math.hypot(H, Z),
    dipDeg: Math.atan2(Z, H) / DEG,
    decDeg: Math.atan2(Y, X) / DEG,
  };
}

/** Rawer's modified dip latitude (deg): tan μ = I / √cos φ. */
export function modipDeg(dipDeg, lat) {
  const c = Math.sqrt(Math.max(1e-6, Math.cos(lat * DEG)));
  return Math.atan((dipDeg * DEG) / c) / DEG;
}

/** North geomagnetic (centred-dipole) pole for a given year: { lat, lon } deg. */
export function dipolePole(year = 2026.0) {
  const { g, h } = coeffs(year);
  const B0 = Math.hypot(g[1][0], g[1][1], h[1][1]);
  const lat = 90 - Math.acos(-g[1][0] / B0) / DEG;
  const lon = Math.atan2(-h[1][1], -g[1][1]) / DEG;
  return { lat, lon };
}

/** Centred-dipole geomagnetic latitude (deg) of a point. */
export function geomagLat(lat, lon, pole = dipolePole()) {
  const s = Math.sin(lat * DEG) * Math.sin(pole.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(pole.lat * DEG) * Math.cos((lon - pole.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

// --- Static global grid --------------------------------------------------
// The field barely changes over a year, so modip / geomagnetic latitude / fH
// are computed once on a coarse grid and bilinearly interpolated thereafter.

export const MAG_LAT_STEP = 2.5;
export const MAG_LON_STEP = 5;
const NLAT = Math.round(180 / MAG_LAT_STEP) + 1; // −90..90
const NLON = Math.round(360 / MAG_LON_STEP);     // −180..175 (wraps)

let grid = null;

/** Build (once) the static magnetic grid: modip at 300 km, fH at 100 km, maglat. */
export function magGrid(year = new Date().getUTCFullYear() + 0.5) {
  if (grid) return grid;
  const modip = new Float32Array(NLAT * NLON);
  const fH = new Float32Array(NLAT * NLON);
  const mlat = new Float32Array(NLAT * NLON);
  const pole = dipolePole(year);
  for (let i = 0; i < NLAT; i++) {
    const lat = Math.max(-89.9, Math.min(89.9, -90 + i * MAG_LAT_STEP));
    for (let j = 0; j < NLON; j++) {
      const lon = -180 + j * MAG_LON_STEP;
      const f300 = igrfField(lat, lon, 300, year);
      const f100 = igrfField(lat, lon, 100, year);
      const k = i * NLON + j;
      modip[k] = modipDeg(f300.dipDeg, lat);
      fH[k] = 2.8e-5 * f100.F; // MHz (fH = eB/2πm ≈ 0.028 MHz per µT)
      mlat[k] = geomagLat(lat, lon, pole);
    }
  }
  grid = { modip, fH, mlat, pole };
  return grid;
}

/** Bilinear lookup on a −90..90 × −180..180 grid with longitude wrap. */
export function gridLookup(arr, lat, lon, latStep, lonStep) {
  const nLat = Math.round(180 / latStep) + 1;
  const nLon = Math.round(360 / lonStep);
  const y = Math.max(0, Math.min(nLat - 1.000001, (lat + 90) / latStep));
  let x = (((lon + 180) % 360) + 360) % 360 / lonStep;
  const i0 = Math.floor(y), j0 = Math.floor(x) % nLon;
  const j1 = (j0 + 1) % nLon;
  const fy = y - i0, fx = x - Math.floor(x);
  const a = arr[i0 * nLon + j0], b = arr[i0 * nLon + j1];
  const c = arr[(i0 + 1) * nLon + j0], d = arr[(i0 + 1) * nLon + j1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Magnetic quantities at a point: { modip, fH, mlat }. */
export function magAt(lat, lon) {
  const g = magGrid();
  return {
    modip: gridLookup(g.modip, lat, lon, MAG_LAT_STEP, MAG_LON_STEP),
    fH: gridLookup(g.fH, lat, lon, MAG_LAT_STEP, MAG_LON_STEP),
    mlat: gridLookup(g.mlat, lat, lon, MAG_LAT_STEP, MAG_LON_STEP),
  };
}
