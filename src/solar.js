// solar.js — live space-weather fetch (NOAA SWPC) + index conversions.
// Browser fetch from CORS-enabled SWPC JSON endpoints, with graceful fallback.

const SWPC = 'https://services.swpc.noaa.gov';
const EP_FLUX = `${SWPC}/products/summary/10cm-flux.json`;
const EP_KP = `${SWPC}/products/noaa-planetary-k-index.json`;

/**
 * Standard Covington relation SFI = 63.75 + 0.728·SSN + 0.00089·SSN².
 * We invert it (quadratic formula) to estimate SSN from a measured SFI,
 * which avoids depending on a separate (often delayed) sunspot feed.
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

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

/**
 * Fetch current conditions. Returns { sfi, ssn, kp, timestamp, source, ok }.
 * On any failure returns ok:false with sensible mid-cycle defaults so the UI
 * and model still work offline.
 */
export async function fetchSpaceWeather() {
  const out = { sfi: 120, ssn: ssnFromSfi(120), kp: 2, timestamp: null, source: 'default', ok: false };
  try {
    const [flux, kpArr] = await Promise.all([getJson(EP_FLUX), getJson(EP_KP)]);

    // Flux endpoint: array of objects [{ flux, time_tag }] (or a single object).
    const fluxRec = Array.isArray(flux) ? flux[flux.length - 1] : flux;
    const fluxVal = fluxRec && (fluxRec.flux ?? fluxRec.Flux);
    if (fluxVal != null && Number.isFinite(Number(fluxVal))) {
      out.sfi = Math.round(Number(fluxVal));
      out.ssn = ssnFromSfi(out.sfi);
      out.timestamp = fluxRec.time_tag || fluxRec.TimeStamp || null;
    }

    // Kp endpoint: array of objects [{ time_tag, Kp, a_running, ... }]; last = latest.
    if (Array.isArray(kpArr) && kpArr.length) {
      const last = kpArr[kpArr.length - 1];
      const kp = Number(last.Kp ?? last.kp_index ?? last.estimated_kp);
      if (Number.isFinite(kp)) out.kp = Math.round(kp * 10) / 10;
    }
    out.source = 'NOAA SWPC';
    out.ok = true;
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return out;
}
