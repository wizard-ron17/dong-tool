// App-shell caching so the tool installs as a real PWA and still opens
// (with last-known data) when offline. Two different strategies on purpose:
//
// - data.json changes multiple times a day and freshness is the whole point
//   of the tool, so it's network-first: always try the network, only fall
//   back to whatever's cached if the request fails (offline).
// - Everything else (index.html, icons, manifest) is stale-while-revalidate:
//   serve the cached copy instantly, then refetch in the background and
//   update the cache for next time. That means a shell edit shows up after
//   one extra reload, with no manual cache-version bump needed.
const CACHE_NAME = 'dong-tool-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/logo.svg',
  './icons/favicon.ico',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // leave third-party requests (fonts, MLB API) alone

  if (url.pathname.endsWith('data.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => { cache.put(event.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
