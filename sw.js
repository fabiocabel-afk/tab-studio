/* Tab Studio — service worker (offline). Troque CACHE a cada versão. */
const CACHE = 'tabstudio-v2.2.6';
const ASSETS = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/tabops.js', './js/store.js', './js/wake.js', './js/csel.js', './js/rep.js', './js/trackbar.js', './js/fretboard3d.js', './js/fretboard2d.js', './js/keyboard2d.js', './js/keyboard3d.js', './js/pianokeys.js', './js/drumkit.js', './js/drums2d.js', './js/drums3d.js', './js/drumlook.js',
  './vendor/alphaTab.min.js', './vendor/three.module.js', './vendor/three.core.js', './vendor/OrbitControls.js', './vendor/BufferGeometryUtils.js', './vendor/RoomEnvironment.js', './vendor/GLTFLoader.js', './vendor/SkeletonUtils.js', './models/lespaul.glb', './models/drums.glb',
  './font/Bravura.woff2', './font/Bravura.woff', './soundfont/sonivox.sf3',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];
self.addEventListener('install', e => {
  // cache: 'reload' = busca do servidor, nunca a cópia antiga guardada pelo navegador
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
