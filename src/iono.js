// iono.js — ionospheric model.
//
// foF2 and M(3000)F2 come from the CCIR numerical maps (ITU-R P.1239, the same
// coefficients IRI and VOACAP use). They encode the real diurnal shape (afternoon
// peak, slow post-sunset decay, pre-dawn minimum), the seasonal and winter
// anomalies, the equatorial anomaly and longitude effects, all as monthly
// medians. foE follows the P.1239 closed form; the F2 mirror height follows
// P.533. On top of the medians we apply a Kp storm depression (in geomagnetic
// latitude) and, when live ionosonde data is available, assimilate it
// (see assimilate.js) — giving a field that is evaluated on a global grid once
// per time step and bilinearly interpolated everywhere else.

import { CCIR_B64, CCIR_PER_MONTH } from './data/ccir.js';
import { subsolarPoint, cosZenith } from './geo.js';
import { magGrid, gridLookup, MAG_LAT_STEP, MAG_LON_STEP } from './magnetic.js';
import { computeAssimilation } from './assimilate.js';

const DEG = Math.PI / 180;

// --- CCIR coefficient maps -------------------------------------------------

const F2_N = 13 * 76;   // foF2: 13 time coefficients × 76 spatial, per R12 level
const M3_N = 9 * 49;    // M3000: 9 × 49
const QF = [11, 11, 8, 4, 1, 0, 0, 0, 0]; // foF2 latitude degrees per longitude harmonic
const QM = [6, 7, 5, 2, 1, 0, 0];         // M3000

let ccir = null;
function ccirData() {
  if (ccir) return ccir;
  const bin = atob(CCIR_B64);
  const dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  ccir = new Float32Array(bin.length / 4);
  for (let i = 0; i < ccir.length; i++) ccir[i] = dv.getFloat32(i * 4, true);
  return ccir;
}

/** CCIR maps saturate: ITU-R P.1239 says use R12 = 160 for higher activity. */
export const R12_SATURATION = 160;

/**
 * Monthly coefficients blended between the two nearest monthly maps (by day of
 * month) and linearly in R12 between the R12=0 and R12=100 maps.
 */
function blendedCoeffs(date, r12) {
  const d = ccirData();
  const R = Math.max(0, Math.min(R12_SATURATION, r12)) / 100;
  const mf = date.getUTCMonth() + (date.getUTCDate() - 15.5) / 30.44;
  const m0 = Math.floor(mf);
  const w1 = mf - m0;
  const ma = ((m0 % 12) + 12) % 12, mb = (ma + 1) % 12;
  const f2 = new Float64Array(F2_N), m3 = new Float64Array(M3_N);
  for (const [m, w] of [[ma, 1 - w1], [mb, w1]]) {
    const base = m * CCIR_PER_MONTH;
    for (let k = 0; k < F2_N; k++) f2[k] += w * (d[base + k] * (1 - R) + d[base + F2_N + k] * R);
    const mb3 = base + 2 * F2_N;
    for (let k = 0; k < M3_N; k++) m3[k] += w * (d[mb3 + k] * (1 - R) + d[mb3 + M3_N + k] * R);
  }
  return { f2, m3 };
}

/** Collapse the UT Fourier series (GAMMA1, first half): one coefficient per spatial term. */
function timeCoeffs(sfe, nSpatial, mm, iharm, utHours) {
  const hou = (15 * utHours - 180) * DEG;
  const s = [], c = [];
  for (let i = 0; i < iharm; i++) { s.push(Math.sin((i + 1) * hou)); c.push(Math.cos((i + 1) * hou)); }
  const coef = new Float64Array(nSpatial);
  for (let i = 0; i < nSpatial; i++) {
    const mi = i * mm;
    let v = sfe[mi];
    for (let j = 0; j < iharm; j++) v += sfe[mi + 2 * j + 1] * s[j] + sfe[mi + 2 * j + 2] * c[j];
    coef[i] = v;
  }
  return coef;
}

/** Spatial sum of GAMMA1 (Jones & Gallet functions of modip, lat, lon). */
function spatial(coef, nq, modipDeg, latDeg, lonDeg) {
  const xs = [1];
  const sm = Math.sin(modipDeg * DEG);
  let sum = coef[0], ss = sm;
  for (let j = 1; j <= nq[0]; j++) { sum += coef[j] * ss; xs.push(ss); ss *= sm; }
  xs.push(ss);
  let np = nq[0];
  const cl = Math.cos(latDeg * DEG);
  let cp = cl;
  for (let j = 1; j < nq.length; j++) {
    const a = lonDeg * j * DEG;
    const c1 = Math.cos(a), s1 = Math.sin(a);
    for (let l = 0; l <= nq[j]; l++) {
      sum += coef[++np] * xs[l] * cp * c1;
      sum += coef[++np] * xs[l] * cp * s1;
    }
    cp *= cl;
  }
  return sum;
}

/**
 * CCIR evaluator for one instant: returns (lat, lon, modip) → { foF2, M3000 }.
 * The UT harmonics are collapsed once, so each point costs ~125 multiply-adds.
 */
export function ccirEvaluator(date, r12) {
  const { f2, m3 } = blendedCoeffs(date, r12);
  const ut = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const cF = timeCoeffs(f2, 76, 13, 6, ut);
  const cM = timeCoeffs(m3, 49, 9, 4, ut);
  return (lat, lon, modip) => ({
    foF2: Math.max(0.5, spatial(cF, QF, modip, lat, lon)),
    M3000: Math.max(1.8, spatial(cM, QM, modip, lat, lon)),
  });
}

// --- E layer, heights, solar indices ----------------------------------------

/** 12-month smoothed 10.7 cm flux from R12 (ITU-R P.371 relation). */
export function phiFromR12(r12) {
  return 63.7 + 0.728 * r12 + 0.00089 * r12 * r12;
}

/**
 * foE (MHz), ITU-R P.1239: foE⁴ = A·B·C·D with solar, seasonal, latitude and
 * time-of-day factors, and a night-time floor. `declDeg` = solar declination.
 */
export function foE(latDeg, cosZ, declDeg, r12) {
  const phi = phiFromR12(r12);
  const A = 1 + 0.0094 * (phi - 66);
  const absLat = Math.abs(latDeg);
  const cl = Math.cos(latDeg * DEG);
  let N = latDeg - declDeg;
  if (Math.abs(N) >= 80) N = 80;
  const m = absLat < 32 ? -1.93 + 1.92 * cl : 0.11 - 0.49 * cl;
  const B = Math.pow(Math.cos(N * DEG), m);
  const C = absLat < 32 ? 23 + 116 * cl : 92 + 35 * cl;
  const p = absLat <= 12 ? 1.31 : 1.2;
  const chi = Math.acos(Math.max(-1, Math.min(1, cosZ))) / DEG;
  let D;
  if (chi <= 73) D = Math.pow(Math.cos(chi * DEG), p);
  else if (chi < 90) D = Math.pow(Math.cos((chi - 6.27e-13 * (chi - 50) ** 8) * DEG), p);
  else {
    // After sunset: decays as exp(−1.4·h), h ≈ hours since sunset.
    const h = (chi - 90) / (15 * Math.max(0.3, cl));
    D = Math.pow(0.072, p) * Math.exp(-1.4 * h);
  }
  const day = Math.pow(Math.max(0, A * B * C * D), 0.25);
  const night = Math.pow(0.004 * (1 + 0.021 * phi) ** 2, 0.25);
  return Math.max(day, night);
}

/**
 * F2 mirror-reflection height hr (km), ITU-R P.533:
 *   hr = 1490 / (M(3000)F2 + ΔM) − 176,  ΔM = 0.18/(y − 1.4) + 0.096(R12 − 25)/150,
 *   y = foF2/foE (≥ 1.8);  hr ≤ 500 km.
 */
export function mirrorHeightKm(M3000, foF2v, foEv, r12) {
  const y = Math.max(1.8, foF2v / Math.max(0.3, foEv));
  const dM = 0.18 / (y - 1.4) + 0.096 * (Math.min(r12, R12_SATURATION) - 25) / 150;
  return Math.max(200, Math.min(500, 1490 / (M3000 + dM) - 176));
}

/**
 * Geomagnetic-storm depression of foF2 (fraction removed). Negative storm phase
 * concentrates at high and upper-middle geomagnetic latitudes and grows with Kp;
 * quiet-time (Kp ≤ 3) is already represented by the monthly median.
 */
export function stormFactor(kp, magLatDeg) {
  if (!(kp > 3)) return 1;
  const latW = Math.max(0, Math.min(1.4, (Math.abs(magLatDeg) - 35) / 25));
  return 1 - Math.min(0.5, 0.06 * (kp - 3) * latW);
}

// --- The ionospheric field ---------------------------------------------------

export const FIELD_LAT_STEP = MAG_LAT_STEP;
export const FIELD_LON_STEP = MAG_LON_STEP;
const NLAT = Math.round(180 / FIELD_LAT_STEP) + 1;
const NLON = Math.round(360 / FIELD_LON_STEP);

/** Base day-to-day spread of the F2 MUF (log units): deciles ≈ ±15 % (ITU-R P.1240). */
export const MUF_SIGMA = 0.13;

/**
 * Build the global ionospheric field for one instant.
 * @param {{date: Date, r12: number, kp?: number, stations?: object[]|null, nowMs?: number}} p
 *   r12: 12-month smoothed sunspot number on the CCIR (v1) scale.
 *   stations: parsed ionosonde observations (assimilate.parseStations) or null.
 * @returns field with `at(lat, lon)` and summary metadata.
 */
export function buildIonoField({ date, r12, kp = 0, stations = null, nowMs = Date.now() }) {
  const mag = magGrid();
  const subsolar = subsolarPoint(date);
  const n = NLAT * NLON;
  const foF2g = new Float32Array(n), m3g = new Float32Array(n);
  const sigma = new Float32Array(n).fill(MUF_SIGMA);
  const foEs = new Float32Array(n);

  // Assimilation may replace R12 with an effective index fitted to ionosondes.
  // CCIR is linear in R12 (below saturation), so per station we need only the
  // R12 = 0 and R12 = 100 values, evaluated at the observation time.
  const assim = computeAssimilation({
    date, r12, stations, nowMs,
    modelFor: (dObs) => {
      const e0 = ccirEvaluator(dObs, 0), e100 = ccirEvaluator(dObs, 100);
      return (lat, lon) => {
        const modip = gridLookup(mag.modip, lat, lon, MAG_LAT_STEP, MAG_LON_STEP);
        const sf = stormFactor(kp, gridLookup(mag.mlat, lat, lon, MAG_LAT_STEP, MAG_LON_STEP));
        const a = e0(lat, lon, modip), b = e100(lat, lon, modip);
        return { f0: a.foF2 * sf, f100: b.foF2 * sf, m0: a.M3000, m100: b.M3000 };
      };
    },
  });
  const rUse = assim ? assim.r12Eff : r12;
  const ev = ccirEvaluator(date, rUse);

  for (let i = 0; i < NLAT; i++) {
    const lat = -90 + i * FIELD_LAT_STEP;
    for (let j = 0; j < NLON; j++) {
      const lon = -180 + j * FIELD_LON_STEP;
      const k = i * NLON + j;
      const v = ev(lat, lon, mag.modip[k]);
      let f = v.foF2 * stormFactor(kp, mag.mlat[k]);
      let M = v.M3000;
      if (assim) {
        const c = assim.correctionAt(lat, lon);
        f *= Math.exp(c.dlnF);
        M *= Math.exp(c.dlnM);
        sigma[k] = MUF_SIGMA * (1 - 0.55 * c.confidence);
        foEs[k] = c.foEs;
      }
      foF2g[k] = f;
      m3g[k] = M;
    }
  }

  const field = {
    date, subsolar, r12, r12Used: rUse, kp,
    assimilated: !!assim, stationsUsed: assim ? assim.used : 0, r12Fit: assim ? assim.r12Fit : null,
    /** All ionospheric parameters needed at a point. */
    at(lat, lon) {
      const cz = cosZenith(lat, lon, subsolar);
      const fo = gridLookup(foF2g, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP);
      const M = gridLookup(m3g, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP);
      const fe = foE(lat, cz, subsolar.lat, rUse);
      return {
        cosZ: cz,
        foF2: fo,
        M3000: M,
        foE: fe,
        hr: mirrorHeightKm(M, fo, fe, rUse),
        fH: gridLookup(mag.fH, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP),
        mlat: gridLookup(mag.mlat, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP),
        sigma: gridLookup(sigma, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP),
        foEs: gridLookup(foEs, lat, lon, FIELD_LAT_STEP, FIELD_LON_STEP),
      };
    },
  };
  return field;
}

// Small LRU so scrubbing time / multiple bands reuse the same field.
const fieldCache = new Map();
/** Cached buildIonoField keyed on time (to the minute), indices and station set. */
export function ionoField(p) {
  const key = [Math.round(p.date.getTime() / 60000), p.r12, p.kp, p.stations ? p.stations.version : 0].join('|');
  if (fieldCache.has(key)) return fieldCache.get(key);
  const f = buildIonoField(p);
  fieldCache.set(key, f);
  if (fieldCache.size > 40) fieldCache.delete(fieldCache.keys().next().value);
  return f;
}
