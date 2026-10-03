// assimilate.js — fold live ionosonde observations into the CCIR median model.
//
// Real-time foF2 / M(3000)F2 / foEs from GIRO digisondes (as aggregated by
// KC2G, prop.kc2g.com) are used in two stages, the same idea as KC2G's own maps:
//   1. Effective sunspot number: one global R12 that best fits all stations,
//      which removes the bulk day-to-day bias of the monthly-median maps.
//   2. Local residual correction: what is left at each station is interpolated
//      by Gaussian-process regression (kriging, ~1500 km / 3 h space–time
//      kernel), relaxing back to the model away from stations and in time.
// Sporadic-E (foEs) is mapped with a much shorter kernel (patches are small).

import { EARTH_RADIUS_KM } from './geo.js';

const DEG = Math.PI / 180;

export const ASSIM = {
  // GP priors on log-residuals (log obs/model): foF2 deviations ~±18 %, M3000 ~±6 %.
  GP_F: { sd: 0.18, lengthKm: 1500, tauH: 3, noiseSd: 0.05 },
  GP_M: { sd: 0.06, lengthKm: 1500, tauH: 3, noiseSd: 0.03 },
  LES_KM: 500,       // sporadic-E patch scale
  TAU_GLOBAL_H: 36,  // effective-R12 offset fades back to the forecast R12
  TAU_ES_H: 1,
  MAX_AGE_H: 3,      // ignore observations older than this at fetch time
  OUTLIER_LN: Math.log(1.7),
  MIN_STATIONS: 4,
};

/**
 * Parse KC2G `stations.json` (array of GIRO records) into usable observations.
 * Drops missing/low-confidence/stale records. Returns an array tagged with a
 * `version` (for cache keys) and `fetchedMs`.
 */
export function parseStations(json, fetchedMs = Date.now()) {
  const out = [];
  if (!Array.isArray(json)) return Object.assign(out, { version: 0, fetchedMs });
  for (const r of json) {
    const st = r && r.station;
    const foF2 = Number(r && r.fof2);
    if (!st || !(foF2 > 0.5 && foF2 < 30)) continue;
    const cs = r.cs == null ? null : Number(r.cs);
    if (cs != null && cs >= 0 && cs < 25) continue; // poor autoscaling confidence
    const t = Date.parse(String(r.time).endsWith('Z') ? r.time : `${r.time}Z`);
    if (!Number.isFinite(t) || fetchedMs - t > ASSIM.MAX_AGE_H * 3600e3) continue;
    let lon = Number(st.longitude);
    const lat = Number(st.latitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lon > 180) lon -= 360;
    const md = Number(r.md);
    const mufd = Number(r.mufd);
    const M3000 = md > 1.5 && md < 5 ? md : (mufd > 0 ? mufd / foF2 : NaN);
    const foEs = Number(r.foes);
    out.push({
      code: st.code, name: st.name, lat, lon, timeMs: t, foF2,
      M3000: M3000 > 1.5 && M3000 < 5 ? M3000 : NaN,
      foEs: foEs > 0 && foEs < 30 ? foEs : NaN,
      quality: cs == null || cs < 0 ? 0.7 : Math.min(1, cs / 100),
    });
  }
  let h = 0;
  for (const s of out) h = (h * 31 + s.timeMs / 1000 + s.foF2 * 1000) % 1e9;
  return Object.assign(out, { version: Math.round(h) + out.length, fetchedMs });
}

const unit = (lat, lon) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];

/**
 * Least-squares effective R12 (log-ratio) from per-station linear model values
 * f(R) = f0 + (f100 − f0)·R/100. Grid search then refine; R clamped to [0, 160].
 */
export function fitEffectiveR(obs) {
  const cost = (R) => {
    let s = 0;
    for (const o of obs) {
      const m = Math.max(0.5, o.f0 + (o.f100 - o.f0) * R / 100);
      const e = Math.log(o.foF2 / m);
      s += o.w * e * e;
    }
    return s;
  };
  let best = 0, bc = Infinity;
  for (let R = 0; R <= 160; R += 2) { const c = cost(R); if (c < bc) { bc = c; best = R; } }
  for (let R = Math.max(0, best - 2); R <= Math.min(160, best + 2); R += 0.1) {
    const c = cost(R); if (c < bc) { bc = c; best = R; }
  }
  return Math.round(best * 10) / 10;
}

/**
 * Compute the assimilation for a field at `date`.
 * @param {{date: Date, r12: number, stations: object[]|null, nowMs: number,
 *          modelFor: (dateObs: Date) => (lat:number, lon:number) => {f0,f100,m0,m100}}} p
 * @returns null (no usable data) or { r12Eff, used, correctionAt(lat, lon) }
 */
export function computeAssimilation({ date, r12, stations, nowMs, modelFor }) {
  if (!stations || stations.length < ASSIM.MIN_STATIONS) return null;
  const tObs = stations.reduce((a, s) => a + s.timeMs, 0) / stations.length;
  const model = modelFor(new Date(tObs));
  const fetched = stations.fetchedMs || nowMs;

  let obs = stations.map((s) => {
    const m = model(s.lat, s.lon);
    const fresh = Math.exp(-Math.max(0, fetched - s.timeMs) / 3600e3 / 1.5);
    return { ...s, ...m, w: s.quality * fresh };
  });
  let R = fitEffectiveR(obs);
  // Reject autoscaling outliers against the fitted model, then refit once.
  const resid = (o, RR) => Math.log(o.foF2 / Math.max(0.5, o.f0 + (o.f100 - o.f0) * RR / 100));
  obs = obs.filter((o) => Math.abs(resid(o, R)) < ASSIM.OUTLIER_LN);
  if (obs.length < ASSIM.MIN_STATIONS) return null;
  R = fitEffectiveR(obs);

  // Time distance between the field instant and the observations.
  const dtNowH = Math.abs(date.getTime() - nowMs) / 3600e3;
  const r12Eff = r12 + (R - r12) * Math.exp(-dtNowH / ASSIM.TAU_GLOBAL_H);

  const T = date.getTime();
  const pts = obs.map((o) => {
    const fR = Math.max(0.5, o.f0 + (o.f100 - o.f0) * R / 100);
    const mR = o.m0 + (o.m100 - o.m0) * Math.min(R, 160) / 100;
    return {
      u: unit(o.lat, o.lon),
      t: o.timeMs,
      rF: Math.log(o.foF2 / fR),
      rM: Number.isFinite(o.M3000) ? Math.max(-0.25, Math.min(0.25, Math.log(o.M3000 / mR))) : NaN,
      q: o.w,
      foEs: o.foEs,
      wEs: o.w * Math.exp(-Math.abs(T - o.timeMs) / 3600e3 / ASSIM.TAU_ES_H),
    };
  });

  const gpF = gaussianProcess(pts, (p) => p.rF, ASSIM.GP_F);
  const mPts = pts.filter((p) => Number.isFinite(p.rM));
  const gpM = mPts.length >= ASSIM.MIN_STATIONS ? gaussianProcess(mPts, (p) => p.rM, ASSIM.GP_M) : null;
  const kEs = 1 / (2 * (ASSIM.LES_KM / EARTH_RADIUS_KM) ** 2);

  return {
    r12Eff,
    r12Fit: R,
    used: obs.length,
    correctionAt(lat, lon) {
      const u = unit(lat, lon);
      const f = gpF.predict(u, T);
      const m = gpM ? gpM.predict(u, T) : { mean: 0 };
      let es = 0;
      for (const p of pts) {
        if (!Number.isFinite(p.foEs)) continue;
        const ang = Math.acos(Math.min(1, u[0] * p.u[0] + u[1] * p.u[1] + u[2] * p.u[2]));
        const e = p.foEs * Math.exp(-kEs * ang * ang) * p.wEs;
        if (e > es) es = e;
      }
      return {
        dlnF: Math.max(-0.7, Math.min(0.7, f.mean)),
        dlnM: Math.max(-0.25, Math.min(0.25, m.mean)),
        confidence: f.confidence,
        foEs: es,
      };
    },
  };
}

/**
 * Space–time Gaussian-process regression (simple kriging) of station residuals.
 * Kernel k = s²·exp(−θ²/2L²)·exp(−|Δt|/τ) on great-circle angle θ; each station
 * carries its own noise variance (worse autoscaling confidence ⇒ more noise).
 * Far from stations the mean relaxes to 0 (i.e. to the model) and confidence → 0.
 */
export function gaussianProcess(pts, val, { sd, lengthKm, tauH, noiseSd }) {
  const n = pts.length;
  const s2 = sd * sd;
  const kθ = 1 / (2 * (lengthKm / EARTH_RADIUS_KM) ** 2);
  const kern = (a, b, ta, tb) => {
    const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    return s2 * Math.exp(-kθ * ang * ang) * Math.exp(-Math.abs(ta - tb) / 3600e3 / tauH);
  };
  // K + diag(noise²), Cholesky-factorised.
  const Lm = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let v = kern(pts[i].u, pts[j].u, pts[i].t, pts[j].t);
      if (i === j) { const ns = noiseSd / Math.max(0.2, pts[i].q); v += ns * ns; }
      Lm[i * n + j] = v;
    }
  }
  for (let j = 0; j < n; j++) {
    let d = Lm[j * n + j];
    for (let k = 0; k < j; k++) d -= Lm[j * n + k] ** 2;
    d = Math.sqrt(Math.max(d, 1e-12));
    Lm[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let v = Lm[i * n + j];
      for (let k = 0; k < j; k++) v -= Lm[i * n + k] * Lm[j * n + k];
      Lm[i * n + j] = v / d;
    }
  }
  const solveL = (b) => { // L y = b
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let v = b[i]; for (let k = 0; k < i; k++) v -= Lm[i * n + k] * y[k]; y[i] = v / Lm[i * n + i]; }
    return y;
  };
  const solveLT = (y) => { // Lᵀ x = y
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let v = y[i]; for (let k = i + 1; k < n; k++) v -= Lm[k * n + i] * x[k]; x[i] = v / Lm[i * n + i]; }
    return x;
  };
  const alpha = solveLT(solveL(pts.map(val)));
  return {
    predict(u, t) {
      const ks = new Float64Array(n);
      let mean = 0;
      for (let i = 0; i < n; i++) { ks[i] = kern(u, pts[i].u, t, pts[i].t); mean += ks[i] * alpha[i]; }
      const v = solveL(ks);
      let red = 0;
      for (let i = 0; i < n; i++) red += v[i] * v[i];
      return { mean, confidence: Math.max(0, Math.min(1, red / s2)) };
    },
  };
}
