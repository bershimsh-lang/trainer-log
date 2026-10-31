// שכבת נתונים: IndexedDB עם מטמון בזיכרון.
// כל כתיבה מתבצעת קודם במסד (טרנזקציה), ורק אחרי הצלחה מתעדכן המטמון.

const DB_NAME = 'trainer-log';
const DB_VERSION = 1;
const STORES = ['providers', 'workoutTypes', 'workouts', 'meta'];

let db = null;
export const cache = { providers: [], workoutTypes: [], workouts: [], meta: {} };

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

const nowISO = () => new Date().toISOString();

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = (ev) => rej(ev.target?.error || tx.error || new Error('שגיאת כתיבה למסד'));
    tx.onabort = () => rej(tx.error || new Error('הפעולה בוטלה'));
  });
}

export async function openDB() {
  db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('providers')) d.createObjectStore('providers', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('workoutTypes')) {
        const s = d.createObjectStore('workoutTypes', { keyPath: 'id' });
        s.createIndex('provider_id', 'provider_id');
      }
      if (!d.objectStoreNames.contains('workouts')) {
        const s = d.createObjectStore('workouts', { keyPath: 'id' });
        // הגנה נוספת ברמת המסד: אין שני אימונים באותו תאריך ושעת התחלה.
        s.createIndex('slot', ['workout_date', 'start_time'], { unique: true });
        s.createIndex('workout_date', 'workout_date');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('המסד חסום – סגרי לשוניות אחרות של האפליקציה'));
  });
  await loadAll();
  // בקשה מהדפדפן לא למחוק את הנתונים בעת מחסור במקום.
  try { await navigator.storage?.persist?.(); } catch { /* לא נתמך */ }
  return db;
}

async function loadAll() {
  const tx = db.transaction(STORES, 'readonly');
  const [p, t, w, m] = await Promise.all(STORES.map((s) => req(tx.objectStore(s).getAll())));
  cache.providers = p;
  cache.workoutTypes = t;
  cache.workouts = w;
  cache.meta = Object.fromEntries(m.map((x) => [x.key, x.value]));
}

async function put(store, value) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
}

function upsertCache(store, value) {
  const list = cache[store];
  const i = list.findIndex((x) => x.id === value.id);
  if (i >= 0) list[i] = value; else list.push(value);
}

// ---------- meta ----------
export async function setMeta(key, value) {
  await put('meta', { key, value });
  cache.meta[key] = value;
}

// ---------- providers ----------
export async function addProvider(name) {
  name = name.trim();
  if (!name) throw new Error('יש להזין שם ספק');
  if (cache.providers.some((p) => p.name.trim() === name)) throw new Error('ספק בשם הזה כבר קיים');
  const p = { id: uid(), name, is_active: true, created_at: nowISO() };
  await put('providers', p);
  upsertCache('providers', p);
  return p;
}

export async function updateProvider(id, changes) {
  const cur = cache.providers.find((p) => p.id === id);
  if (!cur) throw new Error('ספק לא נמצא');
  if (changes.name !== undefined) {
    changes.name = changes.name.trim();
    if (!changes.name) throw new Error('יש להזין שם ספק');
    if (cache.providers.some((p) => p.id !== id && p.name.trim() === changes.name)) throw new Error('ספק בשם הזה כבר קיים');
  }
  const p = { ...cur, ...changes };
  await put('providers', p);
  upsertCache('providers', p);
  return p;
}

export const providerInUse = (id) => cache.workouts.some((w) => w.provider_id === id);

/** מחיקה פיזית רק לספק שלא נעשה בו שימוש. אחרת – השבתה בלבד. */
export async function deleteProvider(id) {
  if (providerInUse(id)) throw new Error('לספק יש אימונים רשומים – ניתן רק להשבית אותו');
  const tx = db.transaction(['providers', 'workoutTypes'], 'readwrite');
  tx.objectStore('providers').delete(id);
  for (const t of cache.workoutTypes.filter((t) => t.provider_id === id)) tx.objectStore('workoutTypes').delete(t.id);
  await txDone(tx);
  cache.providers = cache.providers.filter((p) => p.id !== id);
  cache.workoutTypes = cache.workoutTypes.filter((t) => t.provider_id !== id);
}

// ---------- workout types ----------
export async function addType(providerId, name) {
  name = name.trim();
  if (!name) throw new Error('יש להזין שם סוג אימון');
  if (!cache.providers.some((p) => p.id === providerId)) throw new Error('ספק לא נמצא');
  if (cache.workoutTypes.some((t) => t.provider_id === providerId && t.name.trim() === name)) throw new Error('סוג אימון בשם הזה כבר קיים אצל הספק');
  const t = { id: uid(), provider_id: providerId, name, is_active: true, created_at: nowISO() };
  await put('workoutTypes', t);
  upsertCache('workoutTypes', t);
  return t;
}

export async function updateType(id, changes) {
  const cur = cache.workoutTypes.find((t) => t.id === id);
  if (!cur) throw new Error('סוג אימון לא נמצא');
  if (changes.name !== undefined) {
    changes.name = changes.name.trim();
    if (!changes.name) throw new Error('יש להזין שם סוג אימון');
    if (cache.workoutTypes.some((t) => t.id !== id && t.provider_id === cur.provider_id && t.name.trim() === changes.name)) throw new Error('סוג אימון בשם הזה כבר קיים אצל הספק');
  }
  const t = { ...cur, ...changes, provider_id: cur.provider_id };
  await put('workoutTypes', t);
  upsertCache('workoutTypes', t);
  return t;
}

export const typeInUse = (id) => cache.workouts.some((w) => w.workout_type_id === id);

export async function deleteType(id) {
  if (typeInUse(id)) throw new Error('לסוג האימון יש אימונים רשומים – ניתן רק להשבית אותו');
  const tx = db.transaction('workoutTypes', 'readwrite');
  tx.objectStore('workoutTypes').delete(id);
  await txDone(tx);
  cache.workoutTypes = cache.workoutTypes.filter((t) => t.id !== id);
}

// ---------- workouts ----------
/** שומר אימון חדש או קיים. הוולידציה (כולל התנגשויות) מתבצעת בשכבת הלוגיקה לפני הקריאה. */
export async function saveWorkout(w) {
  const isNew = !w.id;
  const rec = {
    id: w.id || uid(),
    workout_date: w.workout_date,
    start_time: w.start_time,
    end_time: w.end_time,
    provider_id: w.provider_id,
    workout_type_id: w.workout_type_id,
    performed_by: w.performed_by,
    substitute_name: w.performed_by === 'substitute' ? w.substitute_name.trim() : null,
    created_at: isNew ? nowISO() : (cache.workouts.find((x) => x.id === w.id)?.created_at ?? nowISO()),
    updated_at: nowISO(),
  };
  try {
    await put('workouts', rec);
  } catch (e) {
    if (e?.name === 'ConstraintError') throw new Error('קיים כבר אימון בתאריך ובשעה האלה');
    throw e;
  }
  upsertCache('workouts', rec);
  return rec;
}

export async function deleteWorkout(id) {
  const tx = db.transaction('workouts', 'readwrite');
  tx.objectStore('workouts').delete(id);
  await txDone(tx);
  cache.workouts = cache.workouts.filter((w) => w.id !== id);
}

// ---------- backup ----------
export function exportData() {
  return {
    app: 'trainer-log',
    version: 1,
    exported_at: nowISO(),
    data: {
      providers: cache.providers,
      workoutTypes: cache.workoutTypes,
      workouts: cache.workouts,
      meta: cache.meta,
    },
  };
}

/** החלפה מלאה של כל הנתונים בטרנזקציה אחת – או שהכול מצליח או ששום דבר לא משתנה. */
export async function replaceAll({ providers, workoutTypes, workouts, meta }) {
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  providers.forEach((p) => tx.objectStore('providers').put(p));
  workoutTypes.forEach((t) => tx.objectStore('workoutTypes').put(t));
  workouts.forEach((w) => tx.objectStore('workouts').put(w));
  Object.entries(meta || {}).forEach(([key, value]) => tx.objectStore('meta').put({ key, value }));
  await txDone(tx);
  await loadAll();
}
