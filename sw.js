// Service worker de la app instalable de Casa Dorada.
// - La página (index.html) se pide SIEMPRE primero a internet: así cada cambio publicado llega de una vez.
//   Solo si no hay conexión se abre la última copia guardada.
// - Íconos, logo y librerías de Firebase (versión fija) se guardan para abrir rápido.
// - Los datos NUNCA pasan por aquí: Firebase y las funciones van directo a internet.
const CACHE = 'casa-dorada-v1';
const BASICOS = ['./', 'index.html', 'manifest.webmanifest', 'f16eedaf-9536-4042-8efc-29e8c7a79821.jpeg', 'iconos/icono-192.png', 'iconos/icono-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const esFirebaseFijo = (url) => url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mismoSitio = url.origin === self.location.origin;
  if (!mismoSitio && !esFirebaseFijo(url)) return; // datos, fuentes, etc.: el navegador normal

  if (req.mode === 'navigate' || (mismoSitio && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put('index.html', copia)); }
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  if (mismoSitio && url.pathname.endsWith('/sw.js')) return;
  // Archivos que no cambian: primero la copia guardada, y se actualiza en segundo plano.
  e.respondWith(caches.match(req).then((guardado) => {
    const red = fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return res;
    }).catch(() => guardado);
    return guardado || red;
  }));
});
