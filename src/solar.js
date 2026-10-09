// solar.js — live space weather and ionosonde data.
//
//   * R12 (12-month smoothed sunspot number) drives the CCIR maps. SWPC's
//     predicted/observed solar-cycle products give it on the SILSO v2 scale;
//     the CCIR maps were built on the v1 scale, so we convert (v1 ≈ 0.7·v2).
//     Daily SFI is shown for reference but deliberately NOT used as the model
//     index — the ionosphere tracks smoothed activity, and day-to-day departures
//     are captured far better by the ionosonde assimilation.
//   * Kp (planetary), GOES X-ray flux (flare absorption) and ≥10 MeV proton flux
//     (polar-cap absorption).
//   * Ionosondes: KC2G's aggregation of GIRO digisonde data. KC2G does not send
//     CORS headers, so the deployed site proxies it at /api/ionosondes (see
//     worker/index.js). Where that isn't available (a local static server) we
//     fall back to the copy a scheduled GitHub Action mirrors to this repo's
//     `data` branch (see .github/workflows/ionosondes.yml).

const SWPC = 'https://services.swpc.noaa.gov';
const EP_FLUX = `${SWPC}/products/summary/10cm-flux.json`;
const EP_KP = `${SWPC}/products/noaa-planetary-k-index.json`;
const EP_OUTLOOK = `${SWPC}/text/27-day-outlook.txt`;
const EP_CYCLE_PRED = `${SWPC}/json/solar-cycle/predicted-solar-cycle.json`;
const EP_CYCLE_OBS = `${SWPC}/json/solar-cycle/observed-solar-cycle-indices.json`;
const EP_XRAY = `${SWPC}/json/goes/primary/xrays-6-hour.json`;
const EP_PROTON = `${SWPC}/json/goes/primary/integral-protons-6-hour.json`;
export const IONOSONDE_URLS = [
  'api/ionosondes',
  'https://raw.githubusercontent.com/birdman4512/hf-range-planner/data/stations.json',
];

/** SILSO v2 → v1 (CCIR-calibrated) sunspot scale factor. */
export const SSN_V2_TO_V1 = 0.7;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

/**
 * NOAA 27-day outlook: daily forecast of 10.7 cm flux (SFI), Ap and largest Kp.
 * Returns [{ date(ms UTC, day start), sfi, ap, kp }]. Empty array on failure.
 */
export async function fetchForecast() {
  try {
    const r = await fetch(EP_OUTLOOK, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const rows = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^(\d{4})\s+([A-Z][a-z]{2})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (m && MONTHS[m[2]] != null) {
        rows.push({ date: Date.UTC(+m[1], MONTHS[m[2]], +m[3]), sfi: +m[4], ap: +m[5], kp: +m[6] });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Covington relation SFI = 63.75 + 0.728·SSN + 0.00089·SSN², inverted.
 * (Used only to suggest an R12 when the user types an SFI.)
 */
export function ssnFromSfi(sfi) {
  const a = 0.00089, b = 0.728, c = 63.75 - sfi;
  if (sfi <= 63.75) return 0;
  const ssn = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return Math.max(0, Math.round(ssn));
}

export function sfiFromSsn(ssn) {
  return Math.round(63.75 + 0.728 * ssn + 0.00089 * ssn * ssn);
}

/**
 * Smoothed sunspot number for a month from SWPC: the predicted value for that
 * month if present, else the latest observed smoothed value. v2 scale.
 */
export function r12V2For(date, predicted, observed) {
  const tag = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const p = Array.isArray(predicted) && predicted.find((r) => r['time-tag'] === tag);
  if (p && p.predicted_ssn > 0) return { r12: p.predicted_ssn, source: `predicted ${tag}` };
  if (Array.isArray(observed)) {
    for (let i = observed.length - 1; i >= 0; i--) {
      if (observed[i].smoothed_ssn > 0) return { r12: observed[i].smoothed_ssn, source: `smoothed ${observed[i]['time-tag']}` };
    }
  }
  return null;
}

/** Latest GOES 0.1–0.8 nm X-ray flux (W/m²) or null. */
export function latestXray(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (r.energy === '0.1-0.8nm' && r.flux > 0) return { flux: r.flux, time: r.time_tag };
  }
  return null;
}

/** Latest GOES ≥10 MeV integral proton flux (pfu) or null. */
export function latestProtons(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (r.energy === '>=10 MeV' && r.flux >= 0) return { flux: r.flux, time: r.time_tag };
  }
  return null;
}

/** X-ray flux → flare class string (e.g. 2.3e-5 → "M2.3"). */
export function flareClass(flux) {
  if (!(flux > 0)) return '—';
  const classes = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
  for (const [c, base] of classes) if (flux >= base) return `${c}${(flux / base).toFixed(1)}`;
  return 'A0';
}

/**
 * Fetch current conditions. Every source is independent and best-effort.
 * Returns { sfi, kp, r12, r12V2, r12Source, xray, protons, timestamp, ok, errors }.
 * r12 is on the CCIR (v1) scale.
 */
export async function fetchSpaceWeather() {
  const out = {
    sfi: null, kp: 2, r12: 60, r12V2: null, r12Source: 'default',
    xray: null, protons: null, timestamp: null, ok: false, errors: [],
  };
  const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
  const [flux, kpArr, pred, obs, xr, pr] = await Promise.all(
    [EP_FLUX, EP_KP, EP_CYCLE_PRED, EP_CYCLE_OBS, EP_XRAY, EP_PROTON].map((u) => settle(getJson(u))));

  if (flux.v) {
    const rec = Array.isArray(flux.v) ? flux.v[flux.v.length - 1] : flux.v;
    const val = rec && Number(rec.flux ?? rec.Flux);
    if (Number.isFinite(val)) { out.sfi = Math.round(val); out.timestamp = rec.time_tag || null; }
  } else out.errors.push('SFI');

  if (Array.isArray(kpArr.v) && kpArr.v.length) {
    const last = kpArr.v[kpArr.v.length - 1];
    const kp = Number(last.Kp ?? last.kp_index ?? last.estimated_kp);
    if (Number.isFinite(kp)) out.kp = Math.round(kp * 10) / 10;
  } else out.errors.push('Kp');

  const r = r12V2For(new Date(), pred.v, obs.v);
  if (r) {
    out.r12V2 = r.r12;
    out.r12 = Math.round(r.r12 * SSN_V2_TO_V1 * 10) / 10;
    out.r12Source = r.source;
  } else out.errors.push('R12');

  out.xray = latestXray(xr.v);
  out.protons = latestProtons(pr.v);
  out.ok = out.errors.length === 0;
  return out;
}

/**
 * Fetch the KC2G ionosonde feed, trying each source in turn. Resolves to the
 * raw JSON array or null (offline / no source available).
 */
export async function fetchIonosondes(urls = IONOSONDE_URLS) {
  for (const url of [].concat(urls)) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const js = await r.json();
      if (Array.isArray(js)) return js;
    } catch {
      // try the next source
    }
  }
  return null;
}
