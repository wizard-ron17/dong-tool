// App-shell caching so the tool installs as a real PWA and still opens
// (with last-known data) when offline. Two different strategies on purpose:
//
// - data.json AND the document (index.html / client-side routes) are
//   network-first: always try the network, fall back to cache only when the
//   fetch fails (offline). Freshness is the whole point — a code push or a data
//   rebuild should show up on the very next load, not the one after.
// - Static shell assets (icons, manifest) are stale-while-revalidate: serve the
//   cached copy instantly, then refetch in the background.
//
// APP_VERSION is stamped by scripts/build-data.js = a short hash of index.html,
// so it changes exactly when the app CODE changes (not on the 30-min data-only
// rebuilds). A changed sw.js is the only thing the browser treats as "new
// version available" — so this is what makes a homescreen PWA actually update.
// A new worker skipWaiting()s and claims clients, so it controls fetches right
// away; combined with network-first documents, the next load is fresh. The
// update-prompt path (SKIP_WAITING message) is kept for an in-session heads-up.
const APP_VERSION = '729adff054';
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
  // Activate immediately: the page is network-first for the document (below), so
  // a reload always fetches fresh code online — no more serving a stale cached
  // page until the user happens to tap an update prompt.
  self.skipWaiting();
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

  // Lazy data files (data.json, matchup-cards.json, pitch-arsenal.json) are
  // network-first — always fetch fresh, fall back to cache only when offline.
  // Crucially, never cache a non-JSON body: before a file is deployed Netlify's
  // SPA fallback serves index.html with a 200, and caching that HTML would wedge
  // the feature (JSON.parse fails) until a revalidation that may not come.
  if (url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // The document (index.html / any client-side route) is network-first too: the
  // whole app is one file that changes with every code push, and freshness beats
  // a marginally faster stale paint. Falls back to the cached shell offline so
  // deep-links still open. This is what stops "I pushed a fix but see the old page."
  const isDoc = event.request.mode === 'navigate'
    || url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (isDoc) {
    event.respondWith(
      fetch(event.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (icons, manifest) stays stale-while-revalidate.
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
