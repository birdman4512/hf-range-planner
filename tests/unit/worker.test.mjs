import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isStationList, KC2G_STATIONS } from '../../worker/index.js';
import { fetchIonosondes } from '../../src/solar.js';

const STATIONS = Array.from({ length: 8 }, (_, i) => ({ fof2: 5 + i, station: { code: `S${i}` } }));
const ctx = { waitUntil() {} };
const env = { ASSETS: { fetch: async () => new Response('asset') } };

/** Run fn with globalThis.fetch replaced by stub, restoring it afterwards. */
async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('isStationList accepts KC2G-shaped arrays only', () => {
  assert.equal(isStationList(STATIONS), true);
  assert.equal(isStationList([]), false);
  assert.equal(isStationList({ error: 'x' }), false);
  assert.equal(isStationList([...STATIONS, { station: null }]), false);
});

test('worker proxies /api/ionosondes from KC2G with a cacheable response', async () => {
  const seen = [];
  const res = await withFetch(async (url) => { seen.push(String(url)); return new Response(JSON.stringify(STATIONS)); },
    () => worker.fetch(new Request('https://hfskip.example/api/ionosondes'), env, ctx));
  assert.deepEqual(seen, [KC2G_STATIONS]);
  assert.equal(res.status, 200);
  assert.ok(/max-age=\d+/.test(res.headers.get('cache-control')));
  assert.deepEqual(await res.json(), STATIONS);
});

test('worker returns 502 on upstream failure or junk, 404/405 elsewhere under /api', async () => {
  const bad = await withFetch(async () => new Response('down', { status: 503 }),
    () => worker.fetch(new Request('https://hfskip.example/api/ionosondes'), env, ctx));
  assert.equal(bad.status, 502);
  const junk = await withFetch(async () => new Response('<html>'),
    () => worker.fetch(new Request('https://hfskip.example/api/ionosondes'), env, ctx));
  assert.equal(junk.status, 502);
  assert.equal((await worker.fetch(new Request('https://hfskip.example/api/nope'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request('https://hfskip.example/api/ionosondes', { method: 'POST' }), env, ctx)).status, 405);
  assert.equal(await (await worker.fetch(new Request('https://hfskip.example/'), env, ctx)).text(), 'asset');
});

test('fetchIonosondes falls back to the next source', async () => {
  const seen = [];
  const got = await withFetch(async (url) => {
    seen.push(url);
    return url === 'a' ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(STATIONS));
  }, () => fetchIonosondes(['a', 'b']));
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(got.length, STATIONS.length);
  assert.equal(await withFetch(async () => { throw new Error('offline'); }, () => fetchIonosondes(['a', 'b'])), null);
});
