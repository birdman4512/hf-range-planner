// propagation.js — sky-wave link budget after ITU-R P.533.
//
// For a path the engine enumerates propagation modes (n-hop F2, E and, where
// ionosondes report it, sporadic-E), and for each computes:
//   basic MUF       ITU-R P.1240 (foF2, M(3000)F2, foE, fH at control points)
//   E screening     an F2 mode is blocked below 1.05·foE·sec i₁₁₀
//   transmission loss  Lb = 32.45 + 20log f + 20log p′  (slant ray path)
//                        + Li (D-layer absorption, George–Bradley, at the actual
//                              110 km penetration points, plus auroral, polar-cap
//                              and flare absorption from live space weather)
//                        + Lm (above-MUF loss) + Lg (Fresnel ground reflections)
//                        + Lz (8.72 dB, P.533's empirical excess loss)
//   received SNR    P_t + G_t(Δ) + G_r(Δ) − Lb − N₀  (dB-Hz), N₀ from ITU-R P.372
//   reliability     P(SNR ≥ required), combining the day-to-day spread of the
//                   MUF (log-normal, ±15 % deciles) and of signal/noise (σ ≈ 8 dB).
// The path result is the best mode. Work is split into a frequency-independent
// `preparePath` (geometry + ionosphere sampling, cached) and a cheap `evalPath`.

import {
  EARTH_RADIUS_KM, toRad, toDeg, greatCircleKm, bearingDeg, destinationPoint,
} from './geo.js';
import { classifySurface, reflectionLossDb, DEFAULT_GROUND_LOSS_DB } from './clutter.js';
import { antennaGainDbi } from './antenna.js';
import { totalNoiseFa, noiseDensityDbW, noiseEnvById } from './noise.js';

const R = EARTH_RADIUS_KM;
export const LZ_DB = 8.72;           // P.533 "not otherwise included" loss
const H_D = 110;                     // D/E-region penetration height (km)
const H_ES = 105;                    // sporadic-E height
const E_DMAX_KM = 2000;              // P.533 E-mode maximum hop
const MAX_PATH_KM = 20000;

/**
 * Empirical calibration, fitted against WSPR reception data (tools/validate.html):
 *   absorptionScale — multiplier on George–Bradley D-layer absorption;
 *   systemOffsetDb  — net bias of everything not modelled explicitly (real
 *                     antenna efficiency, feedline loss, receiver noise above
 *                     the P.372 external noise, multipath fading margins).
 */
//
// Fitted 2026-10-02 on 24 h of WSPR (12 slots, ~82k labelled pairs, scored on
// held-out slots; σ held at 10 dB): textbook George–Bradley overstates
// D-layer absorption ~3×, and net system SNR runs ~8 dB above the bare budget.
export const CALIBRATION = { absorptionScale: 0.3, systemOffsetDb: 8, signalSdDb: 10 };
const E_SIGMA = 0.07;                // E-layer MUF spread (log)
const ES_SIGMA = 0.35;               // sporadic-E is highly variable

// --- Geometry ----------------------------------------------------------------

/**
 * Maximum single-hop ground range (km) for reflection at height h, given the
 * lowest usable elevation angle (deg).
 */
export function maxHopGroundKm(hKm, minTakeoffDeg = 0) {
  const k = R / (R + hKm);
  const beta = toRad(minTakeoffDeg);
  const psi = Math.acos(Math.min(1, k * Math.cos(beta))) - beta;
  return 2 * R * Math.max(0, psi);
}

/**
 * Single-hop geometry for ground range d (km) and mirror height h (km): elevation
 * (takeoff) angle, incidence at the reflecting layer, the secant-law M-factor,
 * and the slant (ray) length of the hop.
 */
export function hopGeometry(groundKm, hKm) {
  const psi = Math.max(1e-6, (groundKm / 2) / R);
  const Δ = Math.atan((Math.cos(psi) - R / (R + hKm)) / Math.sin(psi));
  const sinφ = (R / (R + hKm)) * Math.cos(Δ);
  const φ = Math.asin(Math.min(1, sinφ));
  return {
    takeoffDeg: toDeg(Δ),
    incidenceDeg: toDeg(φ),
    mFactor: 1 / Math.cos(φ),
    slantKm: 2 * R * Math.sin(psi) / Math.cos(Δ + psi),
    valid: Δ >= -1e-9,
  };
}

/** sec of the incidence angle at height hx for a ray leaving the ground at elevation Δ. */
function secIncidence(elevDeg, hx) {
  const s = (R / (R + hx)) * Math.cos(toRad(elevDeg));
  return 1 / Math.sqrt(Math.max(1e-4, 1 - s * s));
}

/** Ground distance (km) from a hop's end to where its ray crosses height hx. */
function penetrationKm(elevDeg, hx) {
  const Δ = toRad(elevDeg);
  const i = Math.asin(Math.min(1, (R / (R + hx)) * Math.cos(Δ)));
  return R * Math.max(0, Math.PI / 2 - Δ - i);
}

// --- MUF (ITU-R P.1240) --------------------------------------------------------

const cd = (Z) => 0.74 - 0.591 * Z - 0.424 * Z ** 2 - 0.090 * Z ** 3 + 0.088 * Z ** 4 + 0.181 * Z ** 5 + 0.096 * Z ** 6;

/** P.1240 F2 maximum hop range dmax (km) at a control point. */
export function f2Dmax(c) {
  const x = Math.max(2, c.foF2 / Math.max(0.3, c.foE));
  const M = c.M3000;
  const B = M - 0.124 + (M * M - 4) * (0.0215 + 0.005 * Math.sin(7.854 / x - 1.9635));
  const dmax = 4780 + (12610 + 2140 / x ** 2 - 49720 / x ** 4 + 688900 / x ** 6) * (1 / B - 0.303);
  return { B, dmax: Math.max(2500, Math.min(4000, dmax)) };
}

/** P.1240 basic F2 MUF (MHz) for a hop of ground length d at control point c. */
export function f2BasicMuf(d, c) {
  const { B, dmax } = f2Dmax(c);
  const Z = Math.max(-1, Math.min(1, 1 - 2 * d / dmax));
  const Z3 = Math.max(-1, Math.min(1, 1 - 6000 / dmax));
  return (1 + (cd(Z) / cd(Z3)) * (B - 1)) * c.foF2 + (c.fH / 2) * Math.max(0, 1 - d / dmax);
}

// --- Statistics ------------------------------------------------------------------

/** Standard normal CDF. */
export function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// --- Path preparation (frequency-independent) ------------------------------------

/**
 * Absorption index at a D-region penetration point: George–Bradley
 * I = (1 + 0.0037·R12)·cos^1.3(0.881χ), with a small night-time floor.
 */
function gbIndex(cosZ, r12) {
  const chi = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const c = Math.max(0, Math.cos(0.881 * chi));
  return (1 + 0.0037 * r12) * Math.max(0.03, c ** 1.3);
}

function point(p, s) {
  return destinationPoint(p.lat1, p.lon1, p.brg, s);
}

/**
 * Build one propagation mode's frequency-independent description, or null if
 * it is geometrically impossible.
 */
function buildMode(p, field, layer, n, minElev) {
  const D = p.distanceKm;
  const dHop = D / n;
  // Reflection (control) points at each hop's midpoint.
  const ctrlPts = [];
  for (let k = 0; k < n; k++) ctrlPts.push(point(p, (k + 0.5) * dHop));
  const ctrls = ctrlPts.map(([la, lo]) => ({ lat: la, lon: lo, ...field.at(la, lo) }));

  let h;
  if (layer === 'F2') {
    h = ctrls.reduce((a, c) => a + c.hr, 0) / n;
  } else h = layer === 'E' ? H_D : H_ES;
  const g = hopGeometry(dHop, h);
  if (g.takeoffDeg < minElev - 1e-9) return null;

  // Basic MUF: P.533 control-point rule — for long paths only the hops nearest
  // each terminal set the MUF; otherwise every hop counts.
  const mufIdx = n > 2 && D > 4000 ? [0, n - 1] : ctrls.map((_, i) => i);
  let fb = Infinity, sigma = 0, fScreen = 0;
  const sec110 = secIncidence(g.takeoffDeg, H_D);
  for (const i of mufIdx) {
    const c = ctrls[i];
    let m;
    if (layer === 'F2') {
      if (dHop > f2Dmax(c).dmax + 1) return null;
      m = f2BasicMuf(dHop, c);
      sigma = Math.max(sigma, c.sigma);
    } else if (layer === 'E') {
      m = c.foE * sec110;
      sigma = E_SIGMA;
    } else {
      if (!(c.foEs > c.foE * 1.15)) return null; // no sporadic-E above normal E here
      m = c.foEs * secIncidence(g.takeoffDeg, H_ES);
      sigma = ES_SIGMA;
    }
    fb = Math.min(fb, m);
  }
  if (layer === 'F2') for (const c of ctrls) fScreen = Math.max(fScreen, 1.05 * c.foE * sec110);

  // D-region penetration points: two per hop (up and down legs).
  const gp = layer === 'F2' ? penetrationKm(g.takeoffDeg, H_D) : dHop / 2;
  const pens = [];
  for (let k = 0; k < n; k++) {
    const s0 = k * dHop, s1 = (k + 1) * dHop;
    for (const s of [s0 + gp, s1 - gp]) {
      const [la, lo] = point(p, Math.min(Math.max(s, 0), D));
      const c = field.at(la, lo);
      pens.push({ I: gbIndex(c.cosZ, field.r12Used), fH: c.fH, mlat: c.mlat, cosZ: c.cosZ });
    }
  }

  const grounds = [];
  for (let k = 1; k < n; k++) {
    const [la, lo] = point(p, k * dHop);
    grounds.push({ lat: la, lon: lo, surface: classifySurface(la, lo) });
  }

  return {
    layer, n, dHop, hKm: h, elevDeg: g.takeoffDeg, sec110,
    slantKm: n * g.slantKm,
    fb, sigma, fScreen, ctrls, pens, grounds,
  };
}

/**
 * Prepare a path: geometry, mode set and ionosphere sampling. Frequency-
 * independent, so it can be evaluated cheaply at many frequencies.
 * @param {{lat1, lon1, lat2, lon2, field, minTakeoffDeg?, longPath?, thorough?}} p
 */
export function preparePath({ lat1, lon1, lat2, lon2, field, minTakeoffDeg = 3, longPath = false, thorough = true }) {
  const short = greatCircleKm(lat1, lon1, lat2, lon2);
  const brgShort = bearingDeg(lat1, lon1, lat2, lon2);
  const D = Math.max(1, longPath ? 2 * Math.PI * R - short : short);
  const brg = longPath ? (brgShort + 180) % 360 : brgShort;
  const p = { lat1, lon1, lat2, lon2, distanceKm: D, brg, longPath };

  const modes = [];
  // F2: from the fewest hops the geometry/MUF allow, plus higher-order modes.
  const [mla, mlo] = point(p, D / 2);
  const mid = field.at(mla, mlo);
  const hopLimit = Math.min(f2Dmax(mid).dmax, maxHopGroundKm(mid.hr, minTakeoffDeg));
  let n0 = Math.max(1, Math.ceil(D / Math.max(500, hopLimit)));
  const extra = thorough ? 2 : 1;
  for (let n = n0, tries = 0; n <= n0 + extra && n <= 40 && tries < 6; n++, tries++) {
    const m = buildMode(p, field, 'F2', n, minTakeoffDeg);
    if (m) modes.push(m); else if (modes.length === 0) n0++; // shift window if lowest order failed
  }
  // E and sporadic-E: only on paths up to 4000 km (P.533).
  if (D <= 4000) {
    const nE = Math.max(1, Math.ceil(D / Math.min(E_DMAX_KM, maxHopGroundKm(H_D, minTakeoffDeg))));
    for (let n = nE; n <= nE + (thorough ? 1 : 0); n++) {
      const e = buildMode(p, field, 'E', n, minTakeoffDeg);
      if (e) modes.push(e);
    }
    const es = buildMode(p, field, 'Es', nE, minTakeoffDeg);
    if (es) modes.push(es);
  }

  const rx = field.at(lat2, lon2);
  const date = field.date;
  const doy = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000;
  return {
    ...p,
    bearingDeg: brg,
    modes,
    rx: { lat: lat2, lon: lon2, cosZ: rx.cosZ, foF2: rx.foF2, doy },
    field,
  };
}

// --- Frequency evaluation ------------------------------------------------------------

/**
 * Extra (non-George–Bradley) one-way vertical absorption (dB) at a penetration
 * point from geomagnetic and solar disturbances:
 *   auroral (Kp-driven oval), polar-cap (≥10 MeV protons), flare SWF (X-rays, D-RAP).
 */
export function disturbanceAbsDb(pen, f, sw) {
  if (!sw) return 0;
  let a = 0;
  const kp = sw.kp || 0;
  const ml = Math.abs(pen.mlat);
  // Auroral absorption zone moves equatorward and strengthens with Kp.
  const centre = 67 - 1.6 * kp, width = 4 + 0.5 * kp;
  const a30 = 0.1 * Math.exp(0.45 * kp);
  a += a30 * Math.exp(-0.5 * ((ml - centre) / width) ** 2) * ((30 + pen.fH) / (f + pen.fH)) ** 2;
  // Polar-cap absorption: A30 ≈ 0.115√J by day, 0.020√J by night (Sauer & Wilkinson).
  if (sw.protonPfu > 0) {
    const cutoff = 63 - 0.9 * kp;
    const inCap = 1 / (1 + Math.exp(-(ml - cutoff) / 1.5));
    const ap = (pen.cosZ > 0 ? 0.115 : 0.02) * Math.sqrt(sw.protonPfu);
    a += inCap * ap * (30 / f) ** 2;
  }
  // Sudden ionospheric disturbance from X-ray flares (sunlit side): HAF = 10·log X + 65 MHz.
  if (sw.xrayWm2 > 0 && pen.cosZ > 0) {
    const haf = (10 * Math.log10(sw.xrayWm2) + 65) * pen.cosZ ** 0.75;
    if (haf > 0) a += (haf / f) ** 1.5;
  }
  return a;
}

// P.533 above-MUF loss. Uncapped in P.533; the 300 dB guard only avoids overflow.
const lmLoss = (layer, ratio) => (ratio <= 1 ? 0 : Math.min(300, (layer === 'F2' ? 130 : 46) * (ratio - 1) ** 2));

/**
 * System parameters used by evalPath.
 * @typedef {{ powerW: number, txAnt: object, rxAnt: object, reqDbHz: number,
 *   noiseEnv: string, clutter?: boolean, spaceWx?: {kp:number, protonPfu?:number, xrayWm2?:number} }} System
 */

/**
 * Calibration-independent per-mode terms at frequency f. `evalPath` combines
 * these with CALIBRATION; the validation fit reuses them to avoid recomputing
 * the whole link budget for every trial calibration.
 */
export function modeTerms(prep, f, sys) {
  const ptDbW = 10 * Math.log10(Math.max(0.01, sys.powerW || 100));
  const fa = totalNoiseFa({
    env: noiseEnvById(sys.noiseEnv), freqMhz: f,
    lat: prep.rx.lat, cosZ: prep.rx.cosZ, dayOfYear: prep.rx.doy, foF2: prep.rx.foF2,
  });
  const n0 = noiseDensityDbW(fa);
  const sw = sys.spaceWx;
  const terms = [];
  for (const m of prep.modes) {
    if (m.layer === 'F2' && f < m.fScreen) continue; // screened by the E layer
    // Absorption: George–Bradley per hop (scaled by calibration) + disturbance terms.
    let liGB = 0, liDist = 0;
    for (let k = 0; k < m.n; k++) {
      const a = m.pens[2 * k], b = m.pens[2 * k + 1];
      const fh = (a.fH + b.fH) / 2;
      liGB += 677.2 * m.sec110 * ((a.I + b.I) / 2) / ((f + fh) ** 1.98 + 10.2);
      liDist += (disturbanceAbsDb(a, f, sw) + disturbanceAbsDb(b, f, sw)) * m.sec110;
    }
    let lg = 0;
    for (const gpt of m.grounds) {
      lg += sys.clutter === false ? DEFAULT_GROUND_LOSS_DB : reflectionLossDb(gpt.surface, f, m.elevDeg);
    }
    const lfs = 32.45 + 20 * Math.log10(f) + 20 * Math.log10(m.slantKm);
    const gain = antennaGainDbi(sys.txAnt, f, m.elevDeg) + antennaGainDbi(sys.rxAnt, f, m.elevDeg);
    const ratio = f / m.fb;
    terms.push({
      mode: m, liGB, liDist, lg, lfs, gain,
      snr0: ptDbW + gain - (lfs + liDist + lg + LZ_DB) - n0, // before GB absorption & calibration
      pIon: phi(Math.log(m.fb / f) / m.sigma),
      lmMed: lmLoss(m.layer, ratio),
      // On days the MUF falls below f: typical excess ≈ the median ratio, or σ/2 when f is below the median MUF.
      lmBad: lmLoss(m.layer, Math.max(ratio, 1 + 0.5 * m.sigma)),
    });
  }
  return { terms, noiseFa: fa, req: sys.reqDbHz };
}

/** Combine mode terms under a calibration: best mode by reliability. */
export function combineModes({ terms, noiseFa, req }, cal = CALIBRATION) {
  let best = null;
  const sd = cal.signalSdDb;
  for (const t of terms) {
    const li = cal.absorptionScale * t.liGB + t.liDist;
    const snrOpen = t.snr0 - cal.absorptionScale * t.liGB + cal.systemOffsetDb;
    const rel = t.pIon * phi((snrOpen - req) / sd) + (1 - t.pIon) * phi((snrOpen - t.lmBad - req) / sd);
    const snrMed = snrOpen - t.lmMed;
    if (best && !(rel > best.reliability + 1e-9 ||
        (Math.abs(rel - best.reliability) <= 1e-9 && snrMed > best.snrDb))) continue;
    best = {
      reliability: rel, snrDb: snrMed, snrOpen, mode: t.mode, pIon: t.pIon,
      lossDb: t.lfs + li + t.lg + LZ_DB + t.lmMed,
      absorptionDb: li, groundDb: t.lg, gainDb: t.gain, noiseFa, elevDeg: t.mode.elevDeg,
    };
  }
  if (!best) return { reliability: 0, snrDb: -Infinity, mode: null, limit: 'screened', noiseFa };
  best.limit = best.reliability >= 0.5 ? null
    : best.pIon < 0.5 && best.snrOpen >= req ? 'muf' : 'snr';
  return best;
}

/**
 * Evaluate a prepared path at frequency f (MHz).
 * @returns {{ reliability, snrDb, mode, limit, lossDb, absorptionDb, groundDb,
 *   gainDb, noiseFa, elevDeg }}  snrDb is the median SNR in dB-Hz.
 */
export function evalPath(prep, f, sys) {
  const r = combineModes(modeTerms(prep, f, sys));
  if (!r.mode && !prep.modes.length) r.limit = 'geometry';
  return r;
}

// --- Path summary -------------------------------------------------------------------

/** Highest basic MUF over the path's modes (MHz). */
export function pathMuf(prep) {
  return prep.modes.reduce((a, m) => Math.max(a, m.fb), 0);
}

/**
 * Lowest usable frequency (MHz): the lowest frequency at which the best mode's
 * median SNR meets the requirement (absorption/noise limit). Scans 1.5–MUF.
 */
export function pathLuf(prep, sys, mufMhz = pathMuf(prep)) {
  for (let f = 1.5; f <= Math.max(1.6, mufMhz); f *= 1.03) {
    const r = evalPath(prep, f, sys);
    if (r.snrDb >= sys.reqDbHz) return f;
  }
  return Infinity;
}

/**
 * Convenience: prepare + summarise a path (both short and long path), returning
 * the better of the two along with MUF/FOT/LUF and drawing data.
 */
export function analyzePath({ lat1, lon1, lat2, lon2, field, sys, minTakeoffDeg = 3, includeLongPath = true }) {
  const sp = preparePath({ lat1, lon1, lat2, lon2, field, minTakeoffDeg });
  const lp = includeLongPath ? preparePath({ lat1, lon1, lat2, lon2, field, minTakeoffDeg, longPath: true }) : null;
  const summarise = (prep) => {
    const mufMhz = pathMuf(prep);
    const f2 = prep.modes.find((m) => m.layer === 'F2');
    const lead = f2 || prep.modes[0];
    return {
      prep,
      distanceKm: prep.distanceKm,
      bearingDeg: prep.bearingDeg,
      longPath: prep.longPath,
      hopCount: lead ? lead.n : Math.ceil(prep.distanceKm / 4000),
      hopKm: lead ? lead.dHop : prep.distanceKm,
      mufMhz,
      fotMhz: 0.85 * mufMhz,
      lufMhz: sys ? pathLuf(prep, sys, mufMhz) : NaN,
      groundPoints: lead ? lead.grounds.map((g) => [g.lat, g.lon]) : [],
    };
  };
  return { short: summarise(sp), long: lp ? summarise(lp) : null };
}

/** Reliability → status label used across the UI. */
export function statusFor(rel) {
  return rel >= 0.5 ? 'open' : rel >= 0.2 ? 'marginal' : 'closed';
}

/**
 * Global coverage on a lat/lon grid from one transmitter: reliability (0–255)
 * per cell for each requested frequency. Path preparation (the expensive part)
 * is shared across frequencies. Returns one grid per frequency.
 */
export function coverageGrids({ txLat, txLon, freqsMhz, field, sys, minTakeoffDeg = 3, latStep = 3, lonStep = 3, prepCache = null }) {
  const nLat = Math.round(180 / latStep) + 1;
  const nLon = Math.round(360 / lonStep);
  const grids = freqsMhz.map((f) => ({
    freqMhz: f, nLat, nLon, latStep, lonStep,
    cells: new Uint8Array(nLat * nLon), maxReachKm: 0, skipKm: 0, _min: Infinity, _local: false,
  }));
  for (let iLat = 0; iLat < nLat; iLat++) {
    const lat = -90 + iLat * latStep;
    for (let iLon = 0; iLon < nLon; iLon++) {
      const lon = -180 + iLon * lonStep;
      const d = greatCircleKm(txLat, txLon, lat, lon);
      if (d < 80 || d > MAX_PATH_KM) continue;
      const key = iLat * nLon + iLon;
      let prep = prepCache && prepCache.get(key);
      if (!prep) {
        prep = preparePath({ lat1: txLat, lon1: txLon, lat2: lat, lon2: lon, field, minTakeoffDeg, thorough: false });
        if (prepCache) prepCache.set(key, prep);
      }
      for (const g of grids) {
        const r = evalPath(prep, g.freqMhz, sys).reliability;
        g.cells[key] = Math.round(Math.max(0, Math.min(1, r)) * 255);
        if (r >= 0.5) {
          if (d > g.maxReachKm) g.maxReachKm = d;
          if (d < g._min) g._min = d;
          if (d < 700) g._local = true;
        }
      }
    }
  }
  for (const g of grids) {
    g.skipKm = g._local ? 0 : (g._min === Infinity ? 0 : g._min);
    delete g._min; delete g._local;
  }
  return grids;
}
