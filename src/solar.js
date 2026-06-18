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

    if (flux && flux.Flux != null) {
      out.sfi = Math.round(Number(flux.Flux));
      out.ssn = ssnFromSfi(out.sfi);
      out.timestamp = flux.TimeStamp || null;
    }
    // EP_KP is an array of rows; row[0] is the header. Last row = latest.
    if (Array.isArray(kpArr) && kpArr.length > 1) {
      const header = kpArr[0];
      const kpIdx = header.indexOf('Kp') >= 0 ? header.indexOf('Kp')
                  : header.indexOf('kp_index') >= 0 ? header.indexOf('kp_index') : 1;
      const last = kpArr[kpArr.length - 1];
      const kp = Number(last[kpIdx]);
      if (Number.isFinite(kp)) out.kp = kp;
    }
    out.source = 'NOAA SWPC';
    out.ok = true;
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return out;
}
