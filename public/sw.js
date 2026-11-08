// Offline support: keep the last good copy of the app, the data snapshot and recently viewed map
// tiles, so the page still opens (with clearly dated data) when the network or power is patchy.
//
// - Data (data/*.json): network first, fall back to the cached copy.
// - App shell + static overlays: stale-while-revalidate.
// - Base map, fonts and flood tiles: cache first, capped so storage stays small.
// - Radar and forecasts are live-only: old radar is worse than none.

const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const TILES = `tiles-${VERSION}`;
const MAX_TILES = 600;

const scope = new URL(self.registration.scope);

// Precache the page plus the hashed JS/CSS it references, so the very first visit is enough to
// open the app offline later.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const res = await fetch(scope.pathname, { cache: 'no-cache' });
      const html = await res.clone().text();
      await cache.put(scope.pathname, res);
      const assets = [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll([...new Set(assets)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)) {
    if (url.pathname.startsWith(`${scope.pathname}data/`)) return event.respondWith(networkFirst(req, DATA));
    if (req.mode === 'navigate') return event.respondWith(networkFirst(req, SHELL, scope.pathname));
    return event.respondWith(staleWhileRevalidate(req, SHELL));
  }
  if (url.hostname === 'tiles.openfreemap.org') {
    // Tiles and font glyphs are immutable; the style and TileJSON point at weekly-versioned tile
    // builds, so those must stay fresh (cached only as an offline fallback).
    const immutable = /\.(pbf|png|webp)$/.test(url.pathname);
    return event.respondWith(immutable ? cacheFirst(req, TILES) : networkFirst(req, TILES));
  }
  if (url.hostname === 'spatial-gis.information.qld.gov.au') {
    return event.respondWith(cacheFirst(req, TILES)); // historic flood extents don't change
  }
  // Everything else (radar, forecast, …) goes straight to the network.
});

async function networkFirst(req, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackKey ?? req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackKey ?? req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit ?? fresh;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    trim(cache);
  }
  return res;
}

async function trim(cache) {
  const keys = await cache.keys();
  // Cache keys come back in insertion order, so drop the oldest.
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(key);
}
