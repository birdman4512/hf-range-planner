// sw.js — service worker for PWA offline support.
// Network-first for same-origin requests so online users always get the latest
// deploy; falls back to cache when offline. Cross-origin (tiles, SWPC, KC2G,
// unpkg) always goes straight to the network.
//
// NOTE: bump CACHE whenever the precached shell list changes.

const CACHE = 'hf-range-planner-v6';
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
  if (url.origin !== self.location.origin) return; // let cross-origin hit network

  // Network-first: fetch fresh, cache a copy, fall back to cache when offline.
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
  );
});
