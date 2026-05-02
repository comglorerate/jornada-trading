// Service Worker — Jornada de Trading
// Estrategia: cache-first para los assets propios; passthrough para resto
// (Firebase, CDN, etc.). Cualquier cambio aquí debe subir CACHE_VERSION para
// invalidar el caché de versiones anteriores.

const CACHE_VERSION = 'v14';
const CACHE_NAME = `jornada-trading-${CACHE_VERSION}`;

// Assets propios que queremos disponibles offline
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './firebase-init.js'
];

// INSTALL: pre-cachea el app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
                            .catch((err) => console.warn('SW pre-cache error', err))
  );
  self.skipWaiting();
});

// ACTIVATE: limpia caches antiguos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// FETCH: estrategia segura por origen
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo gestionamos GET; POST/PUT/PATCH/DELETE pasan directo a la red.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Recursos cross-origin (Firebase, fonts.googleapis, gstatic, cdnjs, tailwind):
  // pasan directo a la red — no queremos servir versiones cacheadas estáticas.
  if (url.origin !== self.location.origin) return;

  // Mismo origen: cache-first con fallback a red.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Revalida en segundo plano para tener la última versión la próxima vez.
        fetch(req).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, fresh.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        // Sin red: para navegación, devolver el HTML cacheado como fallback.
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// Permite que el cliente fuerce skipWaiting tras un update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
