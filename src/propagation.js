// propagation.js — skywave hop geometry and the MUF/LUF/FOT engine.
// Ties geo.js (geometry + solar position) and iono.js (layer params) together.
// Everything here is pure and unit-testable.

import {
  EARTH_RADIUS_KM, toRad, toDeg,
  greatCircleKm, bearingDeg, destinationPoint, intermediatePoint,
  cosZenith,
} from './geo.js';
import { foF2, foE, hmF2, hmE, absorptionIndex } from './iono.js';

const R = EARTH_RADIUS_KM;
const KABS = 250;          // absorption dB scaling constant
const FH = 1.0;            // electron gyro-frequency (MHz), absorption denominator
const ABS_THRESHOLD = 25;  // dB of absorption tolerated before a path is "below LUF"
const MAX_TOTAL_KM = 13000;

/** Maximum single-hop ground range (km) for a reflection at virtual height h. */
export function maxHopGroundKm(hKm) {
  // At zero takeoff the ray is tangent to the earth: cos(ψ) = R/(R+h).
  const psi = Math.acos(R / (R + hKm));
  return 2 * R * psi;
}

/**
 * Hop geometry for a single hop of ground range d (km) reflecting at virtual
 * height h (km). Returns takeoff angle, layer incidence angle and the MUF
 * "M-factor" (= sec of the incidence angle). valid=false if d exceeds the
 * geometric maximum for this height.
 */
export function hopGeometry(groundKm, hKm) {
  const psi = (groundKm / 2) / R;            // central half-angle (rad)
  if (psi <= 0) return { takeoffDeg: 90, incidenceDeg: 0, mFactor: 1, valid: true };
  const tanΔ = (Math.cos(psi) - R / (R + hKm)) / Math.sin(psi);
  const Δ = Math.atan(tanΔ);                 // takeoff/elevation (rad)
  const sinφ = (R / (R + hKm)) * Math.cos(Δ);
  const φ = Math.asin(Math.min(1, sinφ));    // incidence at layer (rad)
  return {
    takeoffDeg: toDeg(Δ),
    incidenceDeg: toDeg(φ),
    mFactor: 1 / Math.cos(φ),
    valid: Δ >= -1e-9,
  };
}

/** Sample ionospheric params at each hop's reflection midpoint along a path. */
function samplePathIono(lat1, lon1, lat2, lon2, n, env) {
  const { ssn, kp, subsolar } = env;
  const pts = [];
  for (let k = 1; k <= n; k++) {
    const frac = (2 * k - 1) / (2 * n);      // midpoint of hop k
    const [lat, lon] = intermediatePoint(lat1, lon1, lat2, lon2, frac);
    const c = cosZenith(lat, lon, subsolar);
    pts.push({
      lat, lon, cosZenith: c,
      foF2: foF2(c, ssn, { kp, absLat: Math.abs(lat) }),
      foE: foE(c, ssn),
      hmF2: hmF2(c, ssn),
      absIdx: absorptionIndex(c, ssn),
    });
  }
  return pts;
}

/**
 * Analyse a single great-circle path. Returns distance/bearing, the chosen hop
 * count, MUF (basic, F2 and E modes), LUF, FOT, and per-hop detail.
 * @param {{lat1,lon1,lat2,lon2, ssn, kp, subsolar}} env
 */
export function analyzePath(env) {
  const { lat1, lon1, lat2, lon2 } = env;
  const D = greatCircleKm(lat1, lon1, lat2, lon2);
  const brg = bearingDeg(lat1, lon1, lat2, lon2);

  // Pick the fewest hops geometrically possible (fewest hops ⇒ highest MUF),
  // using the mid-path F2 height as the nominal reflector.
  const [mlat, mlon] = intermediatePoint(lat1, lon1, lat2, lon2, 0.5);
  const midCos = cosZenith(mlat, mlon, env.subsolar);
  const hMid = hmF2(midCos, env.ssn);
  const maxHopF2 = maxHopGroundKm(hMid);
  const hopCount = Math.max(1, Math.ceil(D / maxHopF2));
  const dHop = D / hopCount;

  const samples = samplePathIono(lat1, lon1, lat2, lon2, hopCount, env);

  // F2 mode: MUF limited by the weakest hop. Also accumulate absorption term.
  let mufF2 = Infinity;
  let absSum = 0;
  for (const s of samples) {
    const g = hopGeometry(dHop, s.hmF2);
    const hopMuf = s.foF2 * g.mFactor;
    mufF2 = Math.min(mufF2, hopMuf);
    const obliquity = Math.min(5, 1 / Math.sin(toRad(Math.max(3, g.takeoffDeg))));
    absSum += s.absIdx * obliquity;
  }
  if (!Number.isFinite(mufF2)) mufF2 = 0;

  // E mode (only meaningful for short hops within E-layer reach).
  let mufE = 0;
  const maxHopE = maxHopGroundKm(hmE());
  if (dHop <= maxHopE) {
    let m = Infinity;
    for (const s of samples) {
      const g = hopGeometry(dHop, hmE());
      m = Math.min(m, s.foE * g.mFactor);
    }
    mufE = Number.isFinite(m) ? m : 0;
  }

  const mufMhz = Math.max(mufF2, mufE);
  // LUF from total absorption: solve (Kabs·Σ)/(f+fH)² = threshold for f.
  // Higher TX power tolerates more absorption (≈10·log10(P/100) dB vs 100 W
  // reference), lowering the LUF and extending usable reach on absorption-limited
  // paths. (It does not raise the MUF — you can't out-power the F2 ceiling.)
  const powerW = env.powerW || 100;
  const absThreshold = Math.max(5, ABS_THRESHOLD + 10 * Math.log10(powerW / 100));
  const lufRaw = Math.sqrt((KABS * absSum) / absThreshold) - FH;
  const lufMhz = Math.max(1.6, lufRaw);
  const fotMhz = 0.85 * mufMhz;

  // Intermediate ground touch-down points (hopCount − 1 of them) for clutter.
  const groundPoints = [];
  for (let k = 1; k < hopCount; k++) {
    groundPoints.push(intermediatePoint(lat1, lon1, lat2, lon2, k / hopCount));
  }

  return {
    distanceKm: D,
    bearingDeg: brg,
    hopCount,
    hopKm: dHop,
    mufMhz,
    mufF2,
    mufE,
    lufMhz,
    fotMhz,
    open: lufMhz <= fotMhz, // path has any usable window at all
    samples,
    groundPoints,
  };
}

/**
 * Per-hop absorption (dB) at a specific frequency for an already-analysed path.
 * Lets the UI report whether a chosen band is absorption-limited.
 */
export function pathAbsorptionDb(analysis, freqMhz) {
  let total = 0;
  for (const s of analysis.samples) {
    const g = hopGeometry(analysis.hopKm, s.hmF2);
    const obliquity = Math.min(5, 1 / Math.sin(toRad(Math.max(3, g.takeoffDeg))));
    total += (KABS * s.absIdx * obliquity) / ((freqMhz + FH) ** 2);
  }
  return total;
}

/**
 * Classify a band on a path: 'open' (LUF ≤ f ≤ MUF), 'marginal' (within 10%
 * of an edge) or 'closed'.
 */
export function bandStatus(analysis, freqMhz) {
  const { lufMhz, mufMhz } = analysis;
  if (freqMhz >= lufMhz && freqMhz <= mufMhz) return 'open';
  const nearHigh = freqMhz > mufMhz && freqMhz <= mufMhz * 1.1;
  const nearLow = freqMhz < lufMhz && freqMhz >= lufMhz * 0.9;
  return nearHigh || nearLow ? 'marginal' : 'closed';
}

/**
 * Reliability proxy in [0,1] for working a path at frequency f: best near the
 * FOT (≈0.85·MUF), tapering to the LUF/MUF edges, with a penalty per extra hop.
 * 0 means the frequency is outside the usable [LUF, MUF] window.
 */
export function pathReliability(analysis, freqMhz) {
  const { lufMhz, mufMhz, fotMhz, hopCount } = analysis;
  if (freqMhz < lufMhz || freqMhz > mufMhz) return 0;
  const span = Math.max(fotMhz - lufMhz, mufMhz - fotMhz, 0.1);
  const proximity = Math.max(0, 1 - Math.abs(freqMhz - fotMhz) / span);
  const hopPenalty = Math.max(0.2, 1 - 0.12 * (hopCount - 1));
  return Math.max(0, Math.min(1, proximity * hopPenalty));
}

/**
 * Build a coverage footprint for a TX site at a single frequency. For each
 * azimuth it records the reachable span (LUF ≤ f ≤ MUF) and, within it, the
 * "reliable core" span where the reliability proxy is high — so the UI can show
 * graded coverage (a faint reach area plus a brighter sweet-spot ring) rather
 * than a flat blob. NVIS near-in coverage appears as a span starting near 0.
 */
export function coverageFootprint({ txLat, txLon, freqMhz, ssn, kp, subsolar, powerW = 100,
                                    azStepDeg = 4, dStepKm = 120, goodThreshold = 0.5 }) {
  const sectors = [];
  let maxReachKm = 0;
  let skipKm = null;

  for (let az = 0; az < 360; az += azStepDeg) {
    let reachInner = 0, reachOuter = 0, goodInner = 0, goodOuter = 0;
    for (let d = dStepKm; d <= MAX_TOTAL_KM; d += dStepKm) {
      const [rxLat, rxLon] = destinationPoint(txLat, txLon, az, d);
      const a = analyzePath({ lat1: txLat, lon1: txLon, lat2: rxLat, lon2: rxLon, ssn, kp, subsolar, powerW });
      if (freqMhz >= a.lufMhz && freqMhz <= a.mufMhz) {
        if (!reachInner) reachInner = d;
        reachOuter = d;
        if (pathReliability(a, freqMhz) >= goodThreshold) {
          if (!goodInner) goodInner = d;
          goodOuter = d;
        }
      }
    }
    if (reachOuter > 0) {
      maxReachKm = Math.max(maxReachKm, reachOuter);
      if (reachInner > dStepKm && (skipKm === null || reachInner < skipKm)) skipKm = reachInner;
    }
    sectors.push({ azimuth: az, reachInner, reachOuter, goodInner, goodOuter });
  }

  return { txLat, txLon, freqMhz, azStepDeg, sectors, maxReachKm, skipKm };
}

/**
 * NVIS check at the TX site: can the operating frequency reflect at near-
 * vertical incidence (f ≤ foF2 overhead)? If so there is local coverage with
 * no skip zone.
 */
export function nvisCeilingMhz({ txLat, txLon, ssn, kp, subsolar }) {
  const c = cosZenith(txLat, txLon, subsolar);
  return foF2(c, ssn, { kp, absLat: Math.abs(txLat) });
}
