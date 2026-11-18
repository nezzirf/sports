/* Service worker : jeu utilisable hors ligne. Change VERSION pour forcer une mise à jour du cache. */
const VERSION = 'stc-v7', EXT = 'stc-ext-v3', MAX_EXT = 700, PHOTOS = 'stc-photos';
const SHELL = ['./', 'index.html', 'athletes-data.js', 'photos-data.js', 'tailwind.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png', 'logo1.png', 'booster.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== EXT && k !== PHOTOS).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const url = new URL(r.url);
  // Serveur PvP : temps réel, jamais de cache (sinon les requêtes Socket.IO remplissent le cache des photos).
  if (url.pathname.startsWith('/socket.io/')) return;
  // Photos des cartes hébergées avec le jeu : le nom de fichier change quand la photo change, donc cache d'abord.
  if (url.origin === location.origin && url.pathname.includes('/photos/')) {
    e.respondWith(caches.open(PHOTOS).then(async c => (await c.match(r)) || fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; })));
    return;
  }
  if (url.origin === location.origin) {
    // Fichiers du jeu : réseau d'abord, cache en secours hors ligne. On revalide toujours auprès de GitHub (réponse 304
    // rapide si rien n'a changé) : sinon le navigateur pouvait garder l'ancienne page jusqu'à 10 minutes et la mélanger
    // avec le nouveau fichier de styles (cartes avec tous les badges empilés en haut à gauche).
    let fresh = r;
    try { fresh = new Request(r, { cache: 'no-cache' }); } catch (err) { /* navigateur ancien : requête telle quelle */ }
    e.respondWith(fetch(fresh).then(res => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)); } return res; })
      .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('index.html'))));
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

// Préchargement demandé par la page : toutes les photos, 4 à la fois, sans retélécharger celles déjà là.
// Les photos qui ne servent plus (remplacées par une nouvelle version) sont supprimées.
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'precache-photos' || !Array.isArray(e.data.urls)) return;
  const urls = e.data.urls.map(u => new URL(u, self.location).href);
  e.waitUntil(caches.open(PHOTOS).then(async c => {
    const want = new Set(urls);
    for (const k of await c.keys()) if (!want.has(k.url)) await c.delete(k);
    const todo = [];
    for (const u of urls) if (!(await c.match(u))) todo.push(u);
    const work = async () => { while (todo.length) { const u = todo.shift(); try { const res = await fetch(u); if (res.ok) await c.put(u, res); } catch (err) { /* hors ligne : on réessaiera à la prochaine ouverture */ } } };
    await Promise.all([work(), work(), work(), work()]);
  }));
});
