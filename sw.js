/* Larder service worker — app-shell caching for offline use. */
const VERSION = 'v8.3.0';
const CACHE = `larder-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/ui.js',
  'js/units.js',
  'js/itemform.js',
  'js/backup.js',
  'js/ai.js',
  'js/off.js',
  'js/cost.js',
  'js/match.js',
  'js/nutrition.js',
  'js/usda.js',
  'js/orderparse.js',
  'js/recipeparse.js',
  'js/recipeimport.js',
  'js/recommend.js',
  'js/scanner.js',
  'js/vendor/zxing.min.js',
  'js/views/pantry.js',
  'js/views/review.js',
  'js/views/orderreview.js',
  'js/views/recipes.js',
  'js/views/recipeedit.js',
  'js/views/cookmode.js',
  'js/views/plan.js',
  'js/views/shopping.js',
  'js/views/track.js',
  'js/views/insights.js',
  'js/views/generate.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:'reload' bypasses the HTTP cache so a new SW version always
      // precaches genuinely fresh files.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Navigations: network-first so the shell stays fresh; cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./').then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const fetched = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await fetched) || Response.error();
    })()
  );
});
