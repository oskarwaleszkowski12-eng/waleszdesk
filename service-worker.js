'use strict';

const CACHE    = 'waleszdesk-v1';
const PRECACHE = ['/', '/index.html', '/algo.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never intercept API calls or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) return;

  if (e.request.mode === 'navigate') {
    // Navigation: network first, cached shell as fallback
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }

  // Static assets: cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
