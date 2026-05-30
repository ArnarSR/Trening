const CACHE = 'trening-v1';
const APP_SHELL = ['/Trening/', '/Trening/index.html'];

// Install: precache app shell, take control immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete old caches, claim all clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for app shell, skip everything else (API calls)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only handle same-origin requests for the app shell
  if (url.hostname !== self.location.hostname) return;
  if (!url.pathname.startsWith('/Trening')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
