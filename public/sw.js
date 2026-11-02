// Offline app shell. Live data (radar, models, map tiles) always goes to the network.
const CACHE = 'nowcast-v6';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/radar.js', 'js/png.js', 'js/motion.js', 'js/nowcast.js',
  'js/nwp.js', 'js/blend.js', 'js/util.js', 'js/format.js', 'js/charts.js', 'js/map.js', 'js/worker.js', 'js/scorecard.js', 'js/ai.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // old app-shell caches only; the forecast worker's data cache (nowcast-data-*) is kept
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith('nowcast-data-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // relays and AI model files are live data, cached by the forecast worker itself (never stored here)
  if (/\/(api|ai)\//.test(url.pathname)) return;
  // network first so updates arrive immediately; cache as the offline fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((cs) => (cs.length ? cs[0].focus() : self.clients.openWindow('./'))),
  );
});
