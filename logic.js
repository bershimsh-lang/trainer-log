// לוגיקה טהורה: תאריכים, שעות, ולידציה, התנגשויות וחישובי דוחות.
// ללא תלות ב-DOM או במסד הנתונים – ניתן לבדיקה ב-Node.

export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const WORKOUT_MINUTES = 60;

export const pad = (n) => String(n).padStart(2, '0');

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysISO(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return todayISO(d);
}

export function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const dayName = (iso) => DAYS[parseISO(iso).getDay()];
export const monthKeyOf = (iso) => iso.slice(0, 7);
export const currentMonthKey = (d = new Date()) => todayISO(d).slice(0, 7);
export const formatDM = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const formatDMY = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function isValidTime(t) {
  if (typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)) return false;
  const [h, m] = t.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** שעת סיום = שעת התחלה + שעה אחת בדיוק. אימון לא יכול לחצות חצות. */
export function endTimeFor(start) {
  if (!isValidTime(start)) throw new Error('שעת התחלה לא תקינה');
  const end = toMin(start) + WORKOUT_MINUTES;
  if (end > 24 * 60 - 1) throw new Error('אימון חייב להסתיים עד 23:59');
  return fromMin(end);
}

// מקף רגיל (ולא en-dash) כדי שהטווח יוצג משמאל לימין גם בהקשר RTL (כלל W4 באלגוריתם הדו-כיווני).
export const timeRange = (w) => `${w.start_time}-${w.end_time}`;
export const hoursOf = (w) => (toMin(w.end_time) - toMin(w.start_time)) / 60;

export function sortChrono(list) {
  return [...list].sort((a, b) =>
    a.workout_date === b.workout_date
      ? a.start_time.localeCompare(b.start_time)
      : a.workout_date.localeCompare(b.workout_date));
}

/**
 * מחזיר אימון קיים שחופף לאימון המבוקש (אותו תאריך, חלונות זמן חופפים), או null.
 * אימון מחזיק חלון של שעה, ולכן כל הפרש התחלה של פחות משעה הוא התנגשות.
 */
export function findConflict(workouts, { id, workout_date, start_time }) {
  if (!workout_date || !isValidTime(start_time)) return null;
  const s = toMin(start_time);
  return workouts.find((w) =>
    w.id !== id &&
    w.workout_date === workout_date &&
    Math.abs(toMin(w.start_time) - s) < WORKOUT_MINUTES) || null;
}

/**
 * ולידציה מלאה לפני שמירה. מחזיר מערך הודעות שגיאה (ריק = תקין).
 * original – האימון המקורי בעריכה (מאפשר לשמור ספק/סוג שהושבתו מאז).
 */
export function validateWorkout(w, { providers, types, workouts }, original = null) {
  const errors = [];
  if (!isValidISODate(w.workout_date)) errors.push('יש לבחור תאריך תקין');
  if (!isValidTime(w.start_time)) errors.push('יש לבחור שעת אימון');
  else {
    let expectedEnd = null;
    try { expectedEnd = endTimeFor(w.start_time); } catch (e) { errors.push(e.message); }
    if (expectedEnd && w.end_time !== expectedEnd) errors.push('משך אימון חייב להיות שעה אחת בדיוק');
  }
  const provider = providers.find((p) => p.id === w.provider_id);
  if (!provider) errors.push('יש לבחור ספק');
  else if (!provider.is_active && original?.provider_id !== provider.id) errors.push('הספק שנבחר מושבת');

  const type = types.find((t) => t.id === w.workout_type_id);
  if (!type) errors.push('יש לבחור סוג אימון');
  else {
    if (type.provider_id !== w.provider_id) errors.push('סוג האימון אינו שייך לספק שנבחר');
    if (!type.is_active && original?.workout_type_id !== type.id) errors.push('סוג האימון שנבחר מושבת');
  }

  if (w.performed_by !== 'self' && w.performed_by !== 'substitute') errors.push('יש לבחור מי ביצעה את האימון');
  if (w.performed_by === 'substitute' && !(w.substitute_name || '').trim()) errors.push('יש להזין את שם המאמנת המחליפה');
  if (w.performed_by === 'self' && w.substitute_name) errors.push('אימון אישי לא יכול לכלול שם מחליפה');

  if (errors.length === 0) {
    const c = findConflict(workouts, w);
    if (c) errors.push(`קיים כבר אימון בתאריך ${formatDMY(c.workout_date)} בשעה ${timeRange(c)}`);
  }
  return errors;
}

export function filterWorkouts(workouts, { month, providerId, typeId, performedBy } = {}) {
  return sortChrono(workouts.filter((w) =>
    (!month || monthKeyOf(w.workout_date) === month) &&
    (!providerId || w.provider_id === providerId) &&
    (!typeId || w.workout_type_id === typeId) &&
    (!performedBy || w.performed_by === performedBy)));
}

export function monthStats(workouts, month, providers) {
  const ws = workouts.filter((w) => monthKeyOf(w.workout_date) === month);
  const byProvider = new Map();
  for (const w of ws) {
    const e = byProvider.get(w.provider_id) || { self: 0, subs: 0, hours: 0 };
    if (w.performed_by === 'self') e.self++; else e.subs++;
    e.hours += hoursOf(w);
    byProvider.set(w.provider_id, e);
  }
  const rows = [...byProvider.entries()].map(([pid, e]) => ({
    provider: providers.find((p) => p.id === pid),
    ...e,
    total: e.self + e.subs,
  })).sort((a, b) => b.total - a.total);
  return {
    month,
    count: ws.length,
    hours: ws.reduce((s, w) => s + hoursOf(w), 0),
    self: ws.filter((w) => w.performed_by === 'self').length,
    subs: ws.filter((w) => w.performed_by === 'substitute').length,
    byProvider: rows,
  };
}

function summarizeByType(rows) {
  const map = new Map();
  for (const r of rows) {
    const e = map.get(r.typeName) || { typeName: r.typeName, count: 0, hours: 0 };
    e.count++;
    e.hours += r.hours;
    map.set(r.typeName, e);
  }
  const summary = [...map.values()].sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName, 'he'));
  return {
    summary,
    total: { count: rows.length, hours: rows.reduce((s, r) => s + r.hours, 0) },
  };
}

/** בונה את מבנה הדוח החודשי לספק אחד. אימונים אישיים ומחליפות מופרדים לחלוטין. */
export function buildProviderReport({ workouts, types }, provider, month, generatedAt = new Date()) {
  const typeName = (id) => types.find((t) => t.id === id)?.name ?? '(סוג לא ידוע)';
  const ws = filterWorkouts(workouts, { month, providerId: provider.id });
  const toRow = (w) => ({
    id: w.id,
    date: formatDM(w.workout_date),
    fullDate: formatDMY(w.workout_date),
    day: dayName(w.workout_date),
    time: timeRange(w),
    typeName: typeName(w.workout_type_id),
    substitute: w.substitute_name || '',
    hours: hoursOf(w),
  });
  const selfRows = ws.filter((w) => w.performed_by === 'self').map(toRow);
  const subRows = ws.filter((w) => w.performed_by === 'substitute').map(toRow);
  const self = { rows: selfRows, ...summarizeByType(selfRows) };
  const subs = { rows: subRows, ...summarizeByType(subRows) };

  const names = [...new Set([...selfRows, ...subRows].map((r) => r.typeName))];
  const byType = names.map((name) => {
    const s = selfRows.filter((r) => r.typeName === name).length;
    const b = subRows.filter((r) => r.typeName === name).length;
    return { typeName: name, self: s, subs: b, total: s + b };
  }).sort((a, b) => b.total - a.total);

  return {
    provider: { id: provider.id, name: provider.name },
    month,
    monthLabel: monthLabel(month),
    generatedAt: formatDMY(todayISO(generatedAt)),
    self,
    subs,
    byType,
    totals: {
      self: selfRows.length,
      subs: subRows.length,
      all: selfRows.length + subRows.length,
      selfHours: self.total.hours,
      subsHours: subs.total.hours,
      allHours: self.total.hours + subs.total.hours,
    },
  };
}

/** דוחות לכל הספקים שיש להם אימונים בחודש הנבחר (כולל ספקים מושבתים – לשמירת היסטוריה). */
export function buildAllReports(data, month, generatedAt = new Date()) {
  const ids = new Set(data.workouts.filter((w) => monthKeyOf(w.workout_date) === month).map((w) => w.provider_id));
  return data.providers
    .filter((p) => ids.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
    .map((p) => buildProviderReport(data, p, month, generatedAt));
}

/** רשימת חודשים שיש בהם נתונים + החודש הנוכחי, מהחדש לישן. */
export function availableMonths(workouts, now = new Date()) {
  const set = new Set(workouts.map((w) => monthKeyOf(w.workout_date)));
  set.add(currentMonthKey(now));
  return [...set].sort().reverse();
}

/** ולידציה של קובץ גיבוי לפני שחזור. זורק שגיאה בעברית אם הקובץ פגום. */
export function validateBackup(obj) {
  if (!obj || obj.app !== 'trainer-log' || !obj.data) throw new Error('הקובץ אינו גיבוי של האפליקציה');
  const { providers, workoutTypes, workouts } = obj.data;
  if (!Array.isArray(providers) || !Array.isArray(workoutTypes) || !Array.isArray(workouts)) throw new Error('קובץ הגיבוי חסר נתונים');
  const pIds = new Set(providers.map((p) => p.id));
  const tMap = new Map(workoutTypes.map((t) => [t.id, t]));
  for (const p of providers) if (!p.id || typeof p.name !== 'string') throw new Error('ספק לא תקין בגיבוי');
  for (const t of workoutTypes) if (!t.id || !pIds.has(t.provider_id)) throw new Error(`סוג אימון "${t.name}" משויך לספק שלא קיים`);
  for (const w of workouts) {
    if (!w.id || !isValidISODate(w.workout_date) || !isValidTime(w.start_time) || !isValidTime(w.end_time)) throw new Error('אימון לא תקין בגיבוי');
    if (!pIds.has(w.provider_id)) throw new Error('אימון משויך לספק שלא קיים');
    const t = tMap.get(w.workout_type_id);
    if (!t || t.provider_id !== w.provider_id) throw new Error('אימון משויך לסוג אימון לא תקין');
  }
  return { providers, workoutTypes, workouts, meta: obj.data.meta || {} };
}

// ---------- הודעת וואטסאפ ----------
const COUNT_WORDS = ['', 'אחד', 'שני', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה'];

/** "שיעור אחד", "שני שיעורים", "12 שיעורים" */
export function lessonsPhrase(n) {
  if (n === 1) return 'שיעור אחד';
  if (n <= 10) return `${COUNT_WORDS[n]} שיעורים`;
  return `${n} שיעורים`;
}

/** "בשיעור אחד", "בשני שיעורים", "ב-12 שיעורים" */
export function inLessonsPhrase(n) {
  return n <= 10 ? `ב${lessonsPhrase(n)}` : `ב-${n} שיעורים`;
}

/** 2026-08-05 → "5.8" */
export const shortDate = (iso) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;

/** "ב-5.8", "ב-5.8 וב-12.8", "ב-5.8, ב-12.8 וב-26.8" */
function datesPhrase(dates) {
  const parts = dates.map((d) => `ב-${shortDate(d)}`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} ו${parts[parts.length - 1]}`;
}

function joinHebrewList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ו${items[items.length - 1]}`;
}

/** משפטי החלפות: מאחד תאריכים שבהם בדיוק אותן מחליפות ואותן כמויות. */
export function substitutionLines(subWorkouts) {
  const byDate = new Map();
  for (const w of sortChrono(subWorkouts)) {
    const m = byDate.get(w.workout_date) || new Map();
    const name = (w.substitute_name || '').trim();
    m.set(name, (m.get(name) || 0) + 1);
    byDate.set(w.workout_date, m);
  }
  const groups = new Map(); // חתימה → { dates, parts }
  for (const [date, m] of byDate) {
    const parts = [...m.entries()].map(([name, count]) => ({ name, count }));
    const sig = parts.map((p) => `${p.name}:${p.count}`).join('|');
    const g = groups.get(sig) || { dates: [], parts };
    g.dates.push(date);
    groups.set(sig, g);
  }
  return [...groups.values()].map(({ dates, parts }) => {
    const [first, ...rest] = parts;
    const head = `${first.name} החליפה אותי ${inLessonsPhrase(first.count)}`;
    const tail = rest.map((p) => `${p.name} ${inLessonsPhrase(p.count)}`);
    return `${datesPhrase(dates)} ${joinHebrewList([head, ...tail])}`;
  });
}

/**
 * בונה הודעת טקסט לוואטסאפ.
 * selections: [{ providerId, typeIds: [...] }] – רק סוגי האימונים שנבחרו נכללים.
 * אימונים אישיים מפורטים לפי סוג ותאריך; "סה"כ" סופר רק אימונים אישיים; החלפות מסוכמות בסוף.
 */
export function buildWhatsAppText({ providers, types, workouts }, month, selections) {
  const [y, m] = month.split('-');
  const out = [`פירוט שיעורים לחודש ${MONTHS[Number(m) - 1]} ${y.slice(2)}`];
  for (const sel of selections) {
    const provider = providers.find((p) => p.id === sel.providerId);
    if (!provider) continue;
    const typeSet = new Set(sel.typeIds);
    const ws = filterWorkouts(workouts, { month, providerId: provider.id }).filter((w) => typeSet.has(w.workout_type_id));
    if (ws.length === 0) continue;
    const self = ws.filter((w) => w.performed_by === 'self');
    const subs = ws.filter((w) => w.performed_by === 'substitute');

    out.push('', `*${provider.name}*`);
    // סדר הסוגים לפי הופעה ראשונה בחודש
    const typeOrder = [...new Set(self.map((w) => w.workout_type_id))];
    for (const tid of typeOrder) {
      const name = types.find((t) => t.id === tid)?.name ?? 'אחר';
      const perDate = new Map();
      for (const w of self.filter((x) => x.workout_type_id === tid)) perDate.set(w.workout_date, (perDate.get(w.workout_date) || 0) + 1);
      out.push('', `${name}:`);
      for (const [date, n] of perDate) out.push(`${shortDate(date)} ${lessonsPhrase(n)}`);
    }
    out.push('', `סה"כ: ${self.length === 1 ? 'שיעור אחד' : `${self.length} שיעורים`}`);
    const lines = substitutionLines(subs);
    if (lines.length) out.push(...lines);
  }
  return out.join('\n');
}

/** תיבת שם קובץ בטוחה (שומרת עברית, מסירה תווים אסורים). */
export const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_');
