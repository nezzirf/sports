/* Service worker : jeu utilisable hors ligne. Change VERSION pour forcer une mise à jour du cache. */
const VERSION = 'stc-v3', EXT = 'stc-ext-v3', MAX_EXT = 700;
const SHELL = ['./', 'index.html', 'athletes-data.js', 'tailwind.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png', 'logo1.png', 'booster.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== EXT).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const url = new URL(r.url);
  // Serveur PvP : temps réel, jamais de cache (sinon les requêtes Socket.IO remplissent le cache des photos).
  if (url.pathname.startsWith('/socket.io/')) return;
  if (url.origin === location.origin) {
    // Fichiers du jeu : réseau d'abord (les mises à jour GitHub arrivent tout de suite), cache en secours hors ligne.
    e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)); } return res; })
      .catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
    return;
  }
  // CDN, polices, photos Wikipédia : cache d'abord, mise à jour en arrière-plan.
  e.respondWith(caches.open(EXT).then(async c => {
    const m = await c.match(r);
    const net = fetch(r).then(async res => {
      if (res && (res.ok || res.type === 'opaque')) { await c.put(r, res.clone()); const ks = await c.keys(); if (ks.length > MAX_EXT) await c.delete(ks[0]); }
      return res; }).catch(() => m || Response.error());
    return m || net;
  }));
});
