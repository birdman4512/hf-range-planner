// sw.js — service worker for offline app-shell caching (PWA).
// Same-origin shell is cache-first; cross-origin (tiles, SWPC, KC2G, unpkg) is
// always network so live data and maps stay fresh.

const CACHE = 'hf-range-planner-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './src/geo.js',
  './src/solar.js',
  './src/bands.js',
  './src/iono.js',
  './src/propagation.js',
  './src/clutter.js',
  './src/overlays.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Only manage our own origin; let everything else hit the network directly.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(request).then((hit) =>
      hit ||
      fetch(request).then((res) => {
        // Runtime-cache successful same-origin responses.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
