// sw.js — service worker: makes the app installable and lets it open offline.
// Bump VERSION whenever the app files change so phones pick up the update.

const VERSION = 'v4';
const CACHE = `chat-${VERSION}`;
const LIB_CACHE = 'chat-libs'; // Firebase's versioned modules from gstatic — immutable, kept across versions
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './translate.js',
  './import.js',
  './speech.js',
  './voice.js',
  './voice-config.js',
  './talk.js',
  './talk.html',
  './talk.webmanifest',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ?v= makes GitHub Pages' CDN and the browser hand over fresh files (they otherwise
      // keep copies for ten minutes); cache: 'reload' skips the browser's HTTP cache too.
      .then((cache) => Promise.all(SHELL.map(async (url) => {
        const res = await fetch(`${url}?v=${VERSION}`, { cache: 'reload' });
        if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status}`);
        await cache.put(url, res);
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LIB_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isFirebaseLib = (url) => url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase's own modules: versioned and immutable, so cache them for offline opens.
  if (isFirebaseLib(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Firestore traffic, the translator and everything else cross-origin go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Same-origin app files: serve from cache, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return cache.match('./index.html');
    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});

// Tapping a message notification brings the chat to the front (or opens it).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = clients.find((c) => 'focus' in c);
    if (open) return open.focus();
    return self.clients.openWindow('./');
  })());
});
