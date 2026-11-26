/**
 * iPad 版离线缓存。
 *
 * 首次打开先联网加载应用和 OCR；已经看过的词库分片、OCR 模型和其页面资源
 * 会被缓存。之后再次打开，即使暂时没网也能继续使用已缓存内容。
 */
const CACHE = 'snap-vocab-ipad-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './standalone.js',
  './favicon.svg',
  './icon-256.png',
  './manifest.webmanifest',
  './data/catalog.json',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
