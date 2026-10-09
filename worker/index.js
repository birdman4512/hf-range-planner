// worker/index.js — Cloudflare Worker in front of the static site.
//
// Static files are served by Workers Static Assets and never reach this code;
// wrangler.jsonc routes only /api/* here ("run_worker_first").
//
//   GET /api/ionosondes — KC2G's aggregation of GIRO digisonde data. KC2G sends
//   no CORS headers, so browsers can't read it directly; this proxies it to the
//   app's own origin and caches it at the edge for a few minutes. The data is
//   CC BY-NC-SA 4.0 (GIRO / LGDC / station operators, via KC2G) and is passed
//   through unmodified.

export const KC2G_STATIONS = 'https://prop.kc2g.com/api/stations.json';
export const IONOSONDE_TTL_S = 300;   // KC2G refreshes roughly every 5–15 min

const json = (body, status, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

/** True for a plausible KC2G stations.json payload (a non-trivial array of records). */
export function isStationList(data) {
  return Array.isArray(data) && data.length > 5 && data.every((r) => r && typeof r === 'object' && r.station);
}

async function ionosondes(request, ctx) {
  const cache = globalThis.caches?.default ?? null;   // edge cache (absent off-Cloudflare)
  const key = new Request(new URL('/api/ionosondes', request.url).toString());
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  let body;
  try {
    const up = await fetch(KC2G_STATIONS, {
      headers: { 'user-agent': `hf-range-planner (+${new URL(request.url).origin})`, accept: 'application/json' },
    });
    if (!up.ok) return json({ error: `upstream HTTP ${up.status}` }, 502);
    body = await up.text();
    if (!isStationList(JSON.parse(body))) return json({ error: 'unexpected upstream payload' }, 502);
  } catch (e) {
    return json({ error: `upstream unavailable: ${e && e.message}` }, 502);
  }

  const res = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${IONOSONDE_TTL_S}`,
      'x-data-source': 'GIRO via KC2G (prop.kc2g.com), CC BY-NC-SA 4.0',
    },
  });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/ionosondes') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
      return ionosondes(request, ctx);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
