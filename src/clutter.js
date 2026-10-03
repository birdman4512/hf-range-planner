// clutter.js — ground classification and ground-reflection physics.
//
// Surface type at any point comes from a 0.5° land/sea mask (Natural Earth
// 1:50m), with polar ice caps and sea ice inferred by latitude. Reflection loss
// at an intermediate ground bounce is computed from the Fresnel reflection
// coefficients for that surface's electrical constants (ITU-R P.527), the
// frequency and the grazing angle — sea water reflects almost perfectly, dry
// land and ice lose several dB. The same Fresnel coefficients drive the
// antenna ground-reflection patterns in antenna.js.

import { LAND_B64, LAND_STEP, LAND_ROWS, LAND_COLS } from './data/landmask.js';

const DEG = Math.PI / 180;

/** Surface electrical constants (ITU-R P.527): relative permittivity, conductivity S/m. */
export const SURFACE = {
  sea: { label: 'Sea water', er: 70, sigma: 5 },
  land: { label: 'Average land', er: 15, sigma: 0.005 },
  ice: { label: 'Ice / snow', er: 3, sigma: 0.0002 },
};

/** P.533's fixed per-reflection ground loss, used when clutter modelling is off. */
export const DEFAULT_GROUND_LOSS_DB = 2;

let mask = null;
function landMask() {
  if (mask) return mask;
  const bin = atob(LAND_B64);
  mask = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) mask[i] = bin.charCodeAt(i);
  return mask;
}

/** True if (lat, lon) falls on land in the 0.5° mask. */
export function isLand(lat, lon) {
  const r = Math.max(0, Math.min(LAND_ROWS - 1, Math.floor((90 - lat) / LAND_STEP)));
  const lw = ((((lon + 180) % 360) + 360) % 360);
  const c = Math.min(LAND_COLS - 1, Math.floor(lw / LAND_STEP));
  const k = r * LAND_COLS + c;
  return (landMask()[k >> 3] >> (k & 7)) & 1 ? true : false;
}

/**
 * Classify the surface at a reflection point: 'sea' | 'land' | 'ice'.
 * @param {(lat:number,lon:number)=>string|null} [maskFn] optional override.
 */
export function classifySurface(lat, lon, maskFn) {
  if (maskFn) {
    const m = maskFn(lat, lon);
    if (m) return m;
  }
  const land = isLand(lat, lon);
  if (land) {
    // Antarctic and Greenland ice sheets.
    if (lat < -60 || (lat > 60 && lon > -75 && lon < -10)) return 'ice';
    return 'land';
  }
  return Math.abs(lat) > 75 ? 'ice' : 'sea'; // permanent / seasonal sea ice
}

// --- Fresnel reflection -----------------------------------------------------

const csqrt = (re, im) => {
  const m = Math.hypot(re, im);
  const a = Math.sqrt((m + re) / 2);
  const b = Math.sign(im || 1) * Math.sqrt(Math.max(0, (m - re) / 2));
  return [a, b];
};
const cdiv = (ar, ai, br, bi) => {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
};

/**
 * Complex Fresnel reflection coefficients for horizontal (Rh) and vertical (Rv)
 * polarisation at grazing angle ψ over a surface with constants {er, sigma}.
 * Returns { h: [re, im], v: [re, im] }.
 */
export function fresnel(surface, freqMhz, grazingDeg) {
  const lambda = 299.792458 / freqMhz;
  const er = surface.er, ei = -60 * surface.sigma * lambda; // εc = εr − j60σλ
  const s = Math.sin(Math.max(0.05, grazingDeg) * DEG);
  const c2 = 1 - s * s;
  const [qr, qi] = csqrt(er - c2, ei);
  const h = cdiv(s - qr, -qi, s + qr, qi);
  const [er_s, ei_s] = [er * s, ei * s];
  const v = cdiv(er_s - qr, ei_s - qi, er_s + qr, ei_s + qi);
  return { h, v };
}

/**
 * Power loss (dB, ≥ 0) of one ground reflection. Sky waves arrive with mixed
 * (elliptical) polarisation, so the H and V reflected powers are averaged.
 */
export function reflectionLossDb(surfaceKey, freqMhz, grazingDeg) {
  const { h, v } = fresnel(SURFACE[surfaceKey], freqMhz, grazingDeg);
  const p = ((h[0] ** 2 + h[1] ** 2) + (v[0] ** 2 + v[1] ** 2)) / 2;
  return Math.min(20, -10 * Math.log10(Math.max(1e-6, p)));
}

/**
 * Classify the intermediate ground reflection points of a path.
 * @returns {{ detail: {lat, lon, surface}[] }}
 */
export function classifyReflections(reflectionPoints, maskFn) {
  return { detail: reflectionPoints.map(([lat, lon]) => ({ lat, lon, surface: classifySurface(lat, lon, maskFn) })) };
}
