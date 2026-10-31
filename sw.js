// Service Worker: שומר את קובצי האפליקציה במטמון כך שהיא עובדת גם ללא אינטרנט.
// בכל עדכון גרסה יש לשנות את VERSION כדי שהטלפון יוריד את הקבצים החדשים.
const VERSION = 'trainer-log-v1.3.1';
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

// ---------- תזכורת יומית ----------
// Chrome באנדרואיד מעיר את האפליקציה המותקנת מדי פעם (Periodic Background Sync).
// בכל השכמה בודקים: עברה השעה שנקבעה, יום פעיל, ועוד לא הוצגה היום.
const pad2 = (n) => String(n).padStart(2, '0');
const isoToday = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function openAppDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('trainer-log');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const getAllFrom = (db, store) => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const putMetaValue = (db, key, value) => new Promise((res, rej) => {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
});

async function maybeRemind({ test = false } = {}) {
  const db = await openAppDB();
  if (!db.objectStoreNames.contains('meta')) return;
  const meta = Object.fromEntries((await getAllFrom(db, 'meta')).map((x) => [x.key, x.value]));
  const now = new Date();
  const today = isoToday(now);
  if (!test) {
    if (!meta.onboarded || meta.reminderEnabled === false) return;
    const days = meta.reminderDays || [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(now.getDay())) return;
    if (`${pad2(now.getHours())}:${pad2(now.getMinutes())}` < (meta.reminderTime || '17:00')) return;
    if (meta.lastReminderDate === today) return;
    await putMetaValue(db, 'lastReminderDate', today);
  }
  const first = (meta.trainerName || '').trim().split(/\s+/)[0];
  const times = (await getAllFrom(db, 'workouts')).filter((w) => w.workout_date === today).map((w) => w.start_time).sort();
  const logged = times.length === 0 ? 'עוד לא נרשמו אימונים היום'
    : `${times.length === 1 ? 'נרשם היום אימון אחד' : `נרשמו היום ${times.length} אימונים`} (${times.join(', ')})`;
  await self.registration.showNotification(`היי${first ? ` ${first}` : ''}, האם הכנסת את כל האימונים של היום?`, {
    body: logged,
    requireInteraction: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'daily-reminder',
    dir: 'rtl',
    lang: 'he',
    actions: [{ action: 'update', title: 'להוספת אימון' }, { action: 'close', title: 'הכול מעודכן ✓' }],
  });
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'daily-reminder') e.waitUntil(maybeRemind());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'test-reminder') e.waitUntil(maybeRemind({ test: true }));
  if (e.data?.type === 'check-reminder') e.waitUntil(maybeRemind());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'close') return;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) {
        await c.focus();
        c.postMessage({ type: 'go', view: 'add' });
        return;
      }
    }
    await self.clients.openWindow('./index.html#add');
  })());
});
