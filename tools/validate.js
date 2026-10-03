// validate.js — score the propagation model against real WSPR receptions.
//
// WSPR is ideal ground truth: every transmitter reports its power, the decode
// threshold is fixed (≈ −28 dB in 2.5 kHz), and wspr.live exposes the complete
// spot database (CORS-enabled ClickHouse). For each 2-minute slot and band:
//   positives  = (tx, rx) pairs that were decoded;
//   negatives  = pairs where the transmitter was demonstrably on the air (someone
//                decoded it) and the receiver demonstrably listening on that band
//                (it decoded someone), but this receiver did not decode it.
// The model's reliability for each pair is then scored (ROC AUC, Brier, log-loss,
// calibration), and the CALIBRATION constants can be fitted on some slots and
// tested on held-out ones.
//
// Even on a wide-open path only a fraction of station pairs decode (receivers
// with poor antennas or high local noise, slot collisions, decoder limits), so
// the observed probability is modelled as  P(decode) = ceiling × P(path open).
// The ceiling is a property of the WSPR network, not of propagation, and is
// fitted alongside but kept out of the app's CALIBRATION.

import { ionoField } from '../src/iono.js';
import { preparePath, evalPath, modeTerms, combineModes, CALIBRATION } from '../src/propagation.js';
import { greatCircleKm } from '../src/geo.js';
import { modeByName } from '../src/bands.js';

const WSPR_SQL = 'https://db1.wspr.live/';
/** wspr.live band code → dial frequency (MHz). */
export const WSPR_BANDS = { 1: 1.8366, 3: 3.5686, 5: 5.2872, 7: 7.0386, 10: 10.1387, 14: 14.0956, 18: 18.1046, 21: 21.0946, 24: 24.9246, 28: 28.1246 };

const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Fetch every spot for the given slot start times (Date, even minutes) and band codes. */
export async function fetchWspr(times, bands) {
  const q = `SELECT toUnixTimestamp(time) t, band, rx_sign, rx_lat, rx_lon, tx_sign, tx_lat, tx_lon, power, snr
    FROM wspr.rx WHERE time IN (${times.map((t) => `toDateTime('${iso(t)}')`).join(',')})
    AND band IN (${bands.join(',')}) FORMAT JSONCompact`;
  const r = await fetch(`${WSPR_SQL}?query=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`wspr.live HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const js = await r.json();
  return js.data.map(([t, band, rxs, rxla, rxlo, txs, txla, txlo, p, snr]) => ({
    t: t * 1000, band, rx: rxs, rxLat: rxla, rxLon: rxlo, tx: txs, txLat: txla, txLon: txlo, dbm: p, snr,
  }));
}

/** Deterministic PRNG (mulberry32) so runs are repeatable. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build labelled pairs from spots. Paths under `minKm` are dropped (ground wave).
 * Up to `maxPos` decodes are sampled per slot-band, and the non-decodes in the
 * same proportion, so the true decode base rate (and thus calibration) is kept.
 */
export function buildPairs(spots, { minKm = 300, maxPos = 100, seed = 1 } = {}) {
  const rand = rng(seed);
  const groups = new Map();
  for (const s of spots) {
    const k = `${s.t}|${s.band}`;
    if (!groups.has(k)) groups.set(k, { t: s.t, band: s.band, tx: new Map(), rx: new Map(), pos: new Set() });
    const g = groups.get(k);
    g.tx.set(s.tx, { lat: s.txLat, lon: s.txLon, dbm: s.dbm });
    g.rx.set(s.rx, { lat: s.rxLat, lon: s.rxLon });
    g.pos.add(`${s.tx}|${s.rx}`);
  }
  const pairs = [];
  for (const g of groups.values()) {
    const f = WSPR_BANDS[g.band];
    if (!f) continue;
    const pos = [], neg = [];
    for (const [ts, tx] of g.tx) {
      for (const [rs, rx] of g.rx) {
        if (ts === rs) continue;
        const d = greatCircleKm(tx.lat, tx.lon, rx.lat, rx.lon);
        if (d < minKm) continue;
        const item = { t: g.t, band: g.band, f, tx, rx, d, powerW: 10 ** ((tx.dbm - 30) / 10), y: g.pos.has(`${ts}|${rs}`) ? 1 : 0 };
        (item.y ? pos : neg).push(item);
      }
    }
    const sample = (arr, k) => { // partial Fisher–Yates
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rand() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr.slice(0, k);
    };
    const posK = sample(pos, Math.min(pos.length, maxPos));
    // Keep the slot-band's true decode rate: subsample negatives in proportion.
    const negK = Math.min(neg.length, Math.round(neg.length * posK.length / Math.max(1, pos.length)));
    pairs.push(...posK, ...sample(neg, negK));
  }
  return pairs;
}

/** Default receiving/transmitting system for WSPR stations (unknown antennas). */
export function wsprSys(powerW) {
  return {
    powerW, txAnt: { type: 'dipole', heightM: 10 }, rxAnt: { type: 'dipole', heightM: 10 },
    reqDbHz: modeByName('wspr').reqDbHz, noiseEnv: 'residential', clutter: true, spaceWx: { kp: 2 },
  };
}

/** Prepare every pair's path once (fields cached per slot time). */
export function preparePairs(pairs, { r12, kp = 2 }) {
  for (const p of pairs) {
    const field = ionoField({ date: new Date(p.t), r12, kp });
    p.prep = preparePath({ lat1: p.tx.lat, lon1: p.tx.lon, lat2: p.rx.lat, lon2: p.rx.lon, field, thorough: false });
  }
  return pairs;
}

/** Station-heterogeneity ceiling for WSPR decodes (fitted; see header). */
export const NETWORK = { ceiling: 0.2 };

/** Model P(path open) per pair; pass `withCeiling` for P(decode). */
export function predict(pairs, withCeiling = false) {
  const c = withCeiling ? NETWORK.ceiling : 1;
  return pairs.map((p) => c * evalPath(p.prep, p.f, wsprSys(p.powerW)).reliability);
}

/** ROC AUC (rank-based), Brier score, log-loss, base rate and a calibration table. */
export function metrics(y, pIn) {
  // Non-finite predictions would break the rank ties below; count and zero them.
  let nonFinite = 0;
  const p = pIn.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : (nonFinite++, 0)));
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let sumPos = 0, nPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && p[idx[j]] === p[idx[i]]) j++;
    const avg = (i + j + 1) / 2; // average rank for ties
    for (let k = i; k < j; k++) if (y[idx[k]]) { sumPos += avg; nPos++; }
    i = j;
  }
  const nNeg = y.length - nPos;
  const auc = nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : NaN;
  let brier = 0, ll = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < y.length; i++) {
    const q = Math.min(1 - 1e-4, Math.max(1e-4, p[i]));
    brier += (p[i] - y[i]) ** 2;
    ll -= y[i] ? Math.log(q) : Math.log(1 - q);
    const b = bins[Math.min(9, Math.floor(p[i] * 10))];
    b.n++; b.sumP += p[i]; b.sumY += y[i];
  }
  return {
    n: y.length, nonFinite, baseRate: nPos / y.length, auc,
    brier: brier / y.length, logLoss: ll / y.length,
    calibration: bins.map((b, i) => ({ bin: `${i / 10}–${(i + 1) / 10}`, n: b.n, meanP: b.n ? b.sumP / b.n : NaN, observed: b.n ? b.sumY / b.n : NaN })),
  };
}

/**
 * Fit CALIBRATION (absorption scale, system offset, signal σ) by coordinate
 * descent on log-loss over `pairs`. Mutates and returns CALIBRATION.
 */
export function fitCalibration(pairs, { rounds = 3, log = () => {}, fixed = {} } = {}) {
  Object.assign(CALIBRATION, fixed);
  const y = pairs.map((p) => p.y);
  const terms = pairs.map((p) => modeTerms(p.prep, p.f, wsprSys(p.powerW)));
  // Log-loss only (no AUC sort) — this runs thousands of times.
  const loss = () => {
    let ll = 0;
    for (let i = 0; i < terms.length; i++) {
      const q = Math.min(1 - 1e-4, Math.max(1e-4, NETWORK.ceiling * combineModes(terms[i]).reliability));
      ll -= y[i] ? Math.log(q) : Math.log(1 - q);
    }
    return ll / terms.length;
  };
  const target = (k) => (k === 'ceiling' ? NETWORK : CALIBRATION);
  const grids = {
    ceiling: [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.85, 1],
    absorptionScale: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0],
    systemOffsetDb: [-20, -16, -13, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 15],
    signalSdDb: [4, 5, 6, 7, 8, 9, 10, 12],
  };
  for (let r = 0; r < rounds; r++) {
    for (const [key, vals] of Object.entries(grids)) {
      if (key in fixed) continue;
      const obj = target(key);
      let best = obj[key], bl = Infinity;
      for (const v of vals) {
        obj[key] = v;
        const l = loss();
        if (l < bl) { bl = l; best = v; }
      }
      obj[key] = best;
      log(`round ${r + 1}: ${key} = ${best} (log-loss ${bl.toFixed(4)})`);
    }
  }
  // Absorption and offset trade off against each other: finish with a joint
  // local search around the coordinate-descent optimum (re-fitting the ceiling).
  if (!('absorptionScale' in fixed) && !('systemOffsetDb' in fixed)) {
    const near = (vals, v, k) => {
      const i = vals.indexOf(v);
      return i < 0 ? vals : vals.slice(Math.max(0, i - k), i + k + 1);
    };
    let best = null;
    for (const a of near(grids.absorptionScale, CALIBRATION.absorptionScale, 2)) {
      for (const o of near(grids.systemOffsetDb, CALIBRATION.systemOffsetDb, 3)) {
        CALIBRATION.absorptionScale = a; CALIBRATION.systemOffsetDb = o;
        for (const c of near(grids.ceiling, NETWORK.ceiling, 2)) {
          NETWORK.ceiling = c;
          const l = loss();
          if (!best || l < best.l) best = { l, a, o, c };
        }
      }
    }
    Object.assign(CALIBRATION, { absorptionScale: best.a, systemOffsetDb: best.o });
    NETWORK.ceiling = best.c;
    log(`joint: absorptionScale ${best.a}, systemOffsetDb ${best.o}, ceiling ${best.c} (log-loss ${best.l.toFixed(4)})`);
  }
  return { ...CALIBRATION, ceiling: NETWORK.ceiling };
}

/** Even-minute slot start times going back from `endMs`, every `stepH` hours. */
export function slotTimes(endMs, count, stepH) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = endMs - (i * stepH + 0.5) * 3600e3;
    out.push(new Date(Math.floor(t / 120000) * 120000));
  }
  return out;
}
