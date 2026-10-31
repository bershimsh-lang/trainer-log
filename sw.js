// Service Worker: שומר את קובצי האפליקציה במטמון כך שהיא עובדת גם ללא אינטרנט.
// בכל עדכון גרסה יש לשנות את VERSION כדי שהטלפון יוריד את הקבצים החדשים.
const VERSION = 'trainer-log-v1.0.0';
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'db.js',
  'logic.js',
  'pdf.js',
  'xlsx.js',
  'reports.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// מטמון קודם; אם אין – רשת, ושמירה במטמון.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('index.html'))),
  );
});
