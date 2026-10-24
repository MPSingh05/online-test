// Service worker: keeps a copy of the app's own files so the installed app starts quickly and still opens
// without a connection (it then says it is offline). API requests always go to the network: they are
// personal and must be current, so they are never stored.
const CACHE = 'opt-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const shellUrls = new Set(SHELL.map((path) => new URL(path, self.location).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// Drops copies kept by earlier versions of this file.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a new version of the portal shows up straight away; the saved copy is only used offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  const shellKey = request.mode === 'navigate' ? new URL('./', self.location).href : url.origin + url.pathname;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && shellUrls.has(shellKey)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(shellKey, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(shellKey)) ?? Response.error()),
  );
});
