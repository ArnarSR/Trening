const CACHE = 'trener-v2-v1';
const SHELL = ['/Trener/', '/Trener/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell; ignore cross-origin (Worker API) requests.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname !== self.location.hostname) return;
  if (!url.pathname.startsWith('/Trener')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
