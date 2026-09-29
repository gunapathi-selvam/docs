// Offline support. The app shell is tiny and changes often, so it is
// network-first. The MediaPipe runtime and the ~8MB hand model are large,
// immutable and version-pinned, so they are cache-first — which is what makes
// a second visit work with no network at all.

const SHELL = 'gs-shell-v1';
const VENDOR = 'gs-vendor-v1';

const CDN_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'storage.googleapis.com',
]);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll([
        './',
        './index.html',
        './src/styles.css',
        './src/js/main.js',
        './src/js/particles.js',
        './src/js/glrenderer.js',
        './src/js/shapes.js',
        './src/js/gestures.js',
        './src/js/handTracker.js',
        './src/js/audio.js',
      ]))
      .catch(() => { /* a missing file must not block activation */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== VENDOR).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req) {
  const cache = await caches.open(VENDOR);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (CDN_HOSTS.has(url.hostname)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  }
});
