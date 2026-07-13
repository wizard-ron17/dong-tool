// App-shell caching so the tool installs as a real PWA and still opens
// (with last-known data) when offline. Two different strategies on purpose:
//
// - data.json changes multiple times a day and freshness is the whole point
//   of the tool, so it's network-first: always try the network, only fall
//   back to whatever's cached if the request fails (offline).
// - Everything else (index.html, icons, manifest) is stale-while-revalidate:
//   serve the cached copy instantly, then refetch in the background.
//
// APP_VERSION is stamped by scripts/build-data.js = a short hash of index.html,
// so it changes exactly when the app CODE changes (not on the 30-min data-only
// rebuilds). A changed sw.js is the only thing the browser treats as "new
// version available" — so this is what makes a homescreen PWA actually update.
// On a new version we deliberately DON'T skipWaiting: the new worker installs
// and waits, the page notices and shows a "refresh to update" prompt, and only
// then do we take over (see the SKIP_WAITING message handler).
const APP_VERSION = 'd297dcce01';
const CACHE_NAME = 'dong-tool-' + APP_VERSION;
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
  // Pull the shell fresh (bypass the HTTP cache) into this version's cache so
  // the post-update reload is guaranteed to serve the new code.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL_ASSETS.map((u) =>
        cache.add(new Request(u, { cache: 'reload' })).catch(() => {})
      ))
    )
  );
  // No skipWaiting() — wait so the page can prompt before we swap versions.
});

// The page posts this when the user taps "refresh" on the update prompt.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
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
        // Offline fallback: for a client-side route (/due, /picks/results, …) that
        // was never cached, serve the app shell so path deep-links still open.
        .catch(() => cached || (event.request.mode === 'navigate' ? cache.match('./index.html') : undefined));
      return cached || network;
    })
  );
});
