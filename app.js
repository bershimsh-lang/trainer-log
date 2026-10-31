// ממשק המשתמש: ניתוב, מסכים ואירועים.
import * as DB from './db.js';
import {
  todayISO, addDaysISO, dayName, formatDMY, formatDM, monthLabel, monthKeyOf, currentMonthKey, shiftMonth,
  endTimeFor, isValidTime, pad, timeRange, findConflict, validateWorkout, filterWorkouts, monthStats,
  buildProviderReport, buildAllReports, availableMonths, validateBackup, safeFileName, sortChrono, MONTHS,
  buildWhatsAppText, reminderDue, reminderTitle, todayLoggedText, DEFAULT_REMINDER, DAYS,
} from './logic.js';
import { reportToPdf, reportsToXlsx } from './reports.js';

const { cache } = DB;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- state ----------
const HOURS = Array.from({ length: 18 }, (_, i) => i + 5); // 05..22
const MINUTES = ['00', '15', '30', '45'];

const state = {
  view: 'home',
  form: null,
  saving: false,
  formErrors: [],
  editReturn: 'list',
  filters: { month: currentMonthKey(), providerId: '', typeId: '', performedBy: '' },
  reportMonth: currentMonthKey(),
  openReport: null,
  openProvider: null,
};

const providerById = (id) => cache.providers.find((p) => p.id === id);
const typeById = (id) => cache.workoutTypes.find((t) => t.id === id);
const activeProviders = () => cache.providers.filter((p) => p.is_active).sort((a, b) => a.created_at.localeCompare(b.created_at));
const typesOf = (pid, { activeOnly = true } = {}) => cache.workoutTypes
  .filter((t) => t.provider_id === pid && (!activeOnly || t.is_active))
  .sort((a, b) => a.created_at.localeCompare(b.created_at));
const trainerName = () => (cache.meta.trainerName || '').trim();
const performerName = (w) => (w.performed_by === 'self' ? (trainerName() || 'אני') : w.substitute_name);

function newForm(keep = {}) {
  const lastP = cache.meta.lastProviderId;
  const providerOk = lastP && providerById(lastP)?.is_active;
  return {
    id: null,
    workout_date: keep.workout_date || todayISO(),
    dateTouched: !!keep.dateTouched,
    hour: null,
    minute: '00',
    start_time: null,
    provider_id: keep.provider_id ?? (providerOk ? lastP : null),
    workout_type_id: null,
    performed_by: 'self',
    substitute_name: '',
    customTime: false,
    addingProvider: false,
    addingType: false,
  };
}

// ---------- toast & modal ----------
let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function openModal(html, onAction) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-back" data-close="1"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = root.firstElementChild;
  return new Promise((resolve) => {
    const close = (val) => { root.innerHTML = ''; resolve(val); };
    back.addEventListener('click', (e) => {
      if (e.target === back) return close(null);
      const b = e.target.closest('[data-m]');
      if (!b) return;
      const res = onAction ? onAction(b.dataset.m, back, b) : b.dataset.m;
      if (res !== undefined) close(res);
    });
    back.addEventListener('submit', (e) => {
      e.preventDefault();
      const res = onAction ? onAction('ok', back) : 'ok';
      if (res !== undefined) close(res);
    });
    const inp = back.querySelector('input');
    if (inp) setTimeout(() => inp.focus(), 50);
  });
}

const confirmModal = (title, text, okLabel = 'אישור', danger = false) => openModal(`
  <h3>${esc(title)}</h3><div>${text}</div>
  <div class="actions">
    <button class="btn ${danger ? 'danger' : 'primary'}" data-m="ok">${esc(okLabel)}</button>
    <button class="btn" data-m="cancel">ביטול</button>
  </div>`).then((r) => r === 'ok');

const promptModal = (title, value = '', placeholder = '') => openModal(`
  <form><h3>${esc(title)}</h3>
  <input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
  <div class="actions">
    <button class="btn primary" type="submit">שמירה</button>
    <button class="btn" type="button" data-m="cancel">ביטול</button>
  </div></form>`, (act, back) => {
  if (act === 'cancel') return null;
  const v = back.querySelector('input').value.trim();
  return v || undefined;
});

// ---------- routing ----------
const VIEWS = { home: renderHome, add: renderAdd, list: renderList, reports: renderReports, manage: renderManage, onboarding: renderOnboarding };
const TITLES = { home: 'יומן אימונים', add: 'הוספת אימון', list: 'אימונים', reports: 'דוחות חודשיים', manage: 'ניהול והגדרות', onboarding: 'ברוכה הבאה' };

function go(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else route();
}

function route() {
  let v = location.hash.slice(1) || 'home';
  if (!VIEWS[v]) v = 'home';
  if (!cache.meta.onboarded) v = 'onboarding';
  if (v === 'add' && state.view !== 'add' && !state.form?.id) state.form = state.form && !state.form.id ? state.form : newForm();
  if (v !== 'add' && state.form?.id) state.form = null; // יציאה מעריכה
  state.view = v;
  render();
  window.scrollTo(0, 0);
}

function render() {
  const v = state.view;
  $('#topTitle').textContent = TITLES[v];
  $('#topSub').textContent = v === 'home' ? monthLabel(currentMonthKey()) : '';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  $('#nav').classList.toggle('hidden', v === 'onboarding');
  main.innerHTML = VIEWS[v]();
}

// ---------- shared fragments ----------
function workoutItem(w) {
  const p = providerById(w.provider_id);
  const t = typeById(w.workout_type_id);
  const sub = w.performed_by === 'substitute';
  return `<button class="item" data-act="detail" data-id="${w.id}">
    <div class="when"><div class="d">${formatDM(w.workout_date)}</div><div class="t">${w.start_time}-${w.end_time}</div></div>
    <div class="what"><div class="p">${esc(p?.name)}</div><div class="s">${esc(dayName(w.workout_date))} · ${esc(t?.name)}</div></div>
    <span class="badge ${sub ? 'sub' : ''}">${esc(sub ? w.substitute_name : (trainerName() || 'אני'))}</span>
  </button>`;
}

// ---------- onboarding ----------
function renderOnboarding() {
  return `<div class="card">
    <h2>ברוכה הבאה ליומן האימונים 👋</h2>
    <p class="muted">כמה פרטים קצרים כדי להתחיל. אפשר לשנות הכול אחר כך במסך הניהול.</p>
    <form id="onbForm">
      <div class="field"><label for="onbName">השם שלך (יופיע בדוחות)</label>
        <input class="input" id="onbName" name="name" autocomplete="name" placeholder="לדוגמה: נועה כהן"></div>
      <div class="field"><div class="label">הספקים שלך</div>
        ${[1, 2, 3, 4, 5].map((i) => `<input class="input" style="margin-bottom:8px" name="p${i}" placeholder="שם ספק ${i}">`).join('')}
        <div class="hint">אפשר להשאיר שדות ריקים ולהוסיף ספקים בהמשך.</div></div>
      <button class="save-btn" type="submit">התחלה</button>
    </form></div>`;
}

// ---------- home ----------
function renderHome() {
  const month = currentMonthKey();
  const st = monthStats(cache.workouts, month, cache.providers);
  const recent = [...cache.workouts].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 5);
  const pending = cache.meta.pendingReportMonth;
  const lastBackup = cache.meta.lastBackupAt;
  const needBackup = cache.workouts.length > 0 && (!lastBackup || Date.now() - new Date(lastBackup).getTime() > 30 * 864e5);
  const remind = reminderDue(cache.meta);
  return `
  ${remind ? `<div class="banner remind"><b>${esc(reminderTitle(trainerName()))}</b>
    <div class="small muted" style="margin-top:4px">${esc(todayLoggedText(cache.workouts))}</div>
    <div class="row"><button class="btn primary" data-act="remind-go">להוספת אימון</button>
    <button class="btn ghost" data-act="remind-dismiss">הכול מעודכן ✓</button></div></div>` : ''}
  ${pending ? `<div class="banner"><b>חודש ${esc(monthLabel(pending))} הסתיים.</b> זה הזמן להפיק את הדוחות החודשיים לספקים.
    <div class="row"><button class="btn primary" data-act="pending-report">הפקת דוחות ${esc(monthLabel(pending))}</button>
    <button class="btn ghost" data-act="pending-dismiss">אחר כך</button></div></div>` : ''}
  ${needBackup ? `<div class="banner warn">${lastBackup ? 'עבר יותר מחודש מהגיבוי האחרון.' : 'עדיין לא נשמר גיבוי של הנתונים.'} מומלץ לשמור גיבוי מחוץ לטלפון.
    <div class="row"><button class="btn sub" data-act="backup">שמירת גיבוי עכשיו</button></div></div>` : ''}
  <div class="card">
    <h2>${trainerName() ? `שלום ${esc(trainerName())}, ` : ''}תמונת מצב – ${esc(monthLabel(month))}</h2>
    <div class="stats">
      <div class="stat"><div class="num">${st.count}</div><div class="lbl">אימונים בחודש</div></div>
      <div class="stat neutral"><div class="num">${st.hours}</div><div class="lbl">שעות אימון</div></div>
      <div class="stat"><div class="num">${st.self}</div><div class="lbl">בוצעו אישית</div></div>
      <div class="stat sub"><div class="num">${st.subs}</div><div class="lbl">בוצעו ע"י מחליפות</div></div>
    </div>
    ${st.byProvider.length ? `<div class="section-title">לפי ספק</div>
      ${st.byProvider.map((r) => `<div class="prov-row"><span>${esc(r.provider?.name)}</span>
        <span><b>${r.total}</b> <span class="muted small">(${r.self} אישי${r.subs ? ` · ${r.subs} מחליפות` : ''})</span></span></div>`).join('')}` : ''}
  </div>
  <div class="bigbtns">
    <a class="bigbtn primary" href="#add"><span class="ico">＋</span>הוספת אימון</a>
    <a class="bigbtn" href="#list"><span class="ico">☰</span>צפייה באימונים</a>
    <a class="bigbtn" href="#reports"><span class="ico">▤</span>הפקת דוחות</a>
    <a class="bigbtn" href="#manage" style="grid-column:1/-1"><span class="ico">⚙</span>ניהול ספקים וסוגי אימונים</a>
  </div>
  <div class="card"><h3>אימונים אחרונים שנרשמו</h3>
    ${recent.length ? `<div class="list">${recent.map(workoutItem).join('')}</div>` : '<div class="empty">עדיין לא נרשמו אימונים</div>'}
  </div>`;
}

// ---------- add / edit ----------
function computeStart(f) {
  if (f.customTime) return f.start_time;
  return f.hour === null ? null : `${pad(f.hour)}:${f.minute}`;
}

function frequentTimes() {
  const count = new Map();
  for (const w of cache.workouts) count.set(w.start_time, (count.get(w.start_time) || 0) + 1);
  return [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t).sort();
}

function renderAdd() {
  const f = state.form || (state.form = newForm());
  f.start_time = computeStart(f);
  const editing = !!f.id;
  const original = editing ? cache.workouts.find((w) => w.id === f.id) : null;
  const end = f.start_time && isValidTime(f.start_time) ? (() => { try { return endTimeFor(f.start_time); } catch { return null; } })() : null;
  const conflict = f.start_time ? findConflict(cache.workouts, { id: f.id, workout_date: f.workout_date, start_time: f.start_time }) : null;
  const today = todayISO();

  const providers = activeProviders();
  if (original && !providers.some((p) => p.id === original.provider_id)) providers.push(providerById(original.provider_id));
  let types = f.provider_id ? typesOf(f.provider_id) : [];
  if (original && f.provider_id === original.provider_id && !types.some((t) => t.id === original.workout_type_id)) types = [...types, typeById(original.workout_type_id)];

  const freq = frequentTimes();
  const busyAt = (h) => !!findConflict(cache.workouts, { id: f.id, workout_date: f.workout_date, start_time: `${pad(h)}:${f.minute}` });
  const subNames = [...new Set(cache.workouts.filter((w) => w.substitute_name).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((w) => w.substitute_name))].slice(0, 6);
  const canSave = !state.saving && !conflict && f.start_time && end && f.provider_id && f.workout_type_id
    && (f.performed_by === 'self' || f.substitute_name.trim());

  return `<form id="workoutForm" autocomplete="off">
  ${editing ? `<div class="banner">עריכת אימון קיים <button type="button" class="btn ghost" data-act="cancel-edit">ביטול עריכה</button></div>` : ''}
  ${state.formErrors.length ? `<ul class="errors">${state.formErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}

  <div class="card">
    <div class="field">
      <div class="label">תאריך</div>
      <div class="chips" style="margin-bottom:8px">
        <button type="button" class="chip ${f.workout_date === today ? 'on' : ''}" data-act="date" data-v="${today}">היום</button>
        <button type="button" class="chip ${f.workout_date === addDaysISO(today, -1) ? 'on' : ''}" data-act="date" data-v="${addDaysISO(today, -1)}">אתמול</button>
        <button type="button" class="chip ${f.workout_date === addDaysISO(today, -2) ? 'on' : ''}" data-act="date" data-v="${addDaysISO(today, -2)}">שלשום</button>
      </div>
      <input class="input" type="date" id="fDate" value="${f.workout_date}" max="${addDaysISO(today, 366)}">
      <div class="hint">יום ${esc(dayName(f.workout_date))}, ${formatDMY(f.workout_date)} · ישויך לדוח ${esc(monthLabel(monthKeyOf(f.workout_date)))}</div>
    </div>

    <div class="field">
      <div class="label">שעת האימון (שעה אחת)</div>
      <div class="timebox ${end ? '' : 'empty'}" id="timeBox">${end ? `${f.start_time} – ${end}` : 'בחרי שעת התחלה'}</div>
      ${freq.length && !f.customTime ? `<div class="chips" style="margin-bottom:10px">${freq.map((t) => `<button type="button" class="chip ${f.start_time === t ? 'on' : ''}" data-act="freq" data-v="${t}" style="direction:ltr">${t}</button>`).join('')}</div>` : ''}
      ${f.customTime ? `
        <input class="input" type="time" id="fTime" value="${f.start_time || ''}" step="300" style="direction:ltr">
        <button type="button" class="btn ghost" data-act="custom-time-off">חזרה לבחירה מהירה</button>` : `
        <div class="hint" style="margin:0 0 6px">שעה</div>
        <div class="chips grid6">${HOURS.map((h) => `<button type="button" class="chip ${f.hour === h ? 'on' : ''} ${busyAt(h) ? 'busy' : ''}" data-act="hour" data-v="${h}">${pad(h)}</button>`).join('')}</div>
        <div class="hint" style="margin:10px 0 6px">דקות</div>
        <div class="chips grid4">${MINUTES.map((m) => `<button type="button" class="chip ${f.minute === m ? 'on' : ''}" data-act="minute" data-v="${m}">:${m}</button>`).join('')}</div>
        <button type="button" class="btn ghost" data-act="custom-time-on">שעה אחרת…</button>`}
    </div>
    ${conflict ? `<div class="alert">⚠ כבר רשום אימון בתאריך הזה בשעה ${timeRange(conflict)} (${esc(providerById(conflict.provider_id)?.name)} · ${esc(typeById(conflict.workout_type_id)?.name)}). לא ניתן לרשום שני אימונים חופפים.
      <div><button type="button" class="btn danger" data-act="detail" data-id="${conflict.id}">הצגת האימון הקיים</button></div></div>` : ''}
  </div>

  <div class="card">
    <div class="field">
      <div class="label">ספק</div>
      <div class="chips">
        ${providers.map((p) => `<button type="button" class="chip ${f.provider_id === p.id ? 'on' : ''}" data-act="provider" data-v="${p.id}">${esc(p.name)}</button>`).join('')}
        <button type="button" class="chip add" data-act="add-provider-open">＋ ספק חדש</button>
      </div>
      ${f.addingProvider ? `<div class="inline-add"><input class="input" id="newProvider" placeholder="שם הספק החדש"><button type="button" class="btn primary" data-act="add-provider">הוספה</button></div>` : ''}
      ${providers.length === 0 && !f.addingProvider ? '<div class="hint">עדיין אין ספקים – הוסיפי ספק ראשון.</div>' : ''}
    </div>

    <div class="field" style="margin-bottom:4px">
      <div class="label">סוג אימון</div>
      ${!f.provider_id ? '<div class="hint">בחרי ספק כדי לראות את סוגי האימונים שלו.</div>' : `
      <div class="chips">
        ${types.map((t) => `<button type="button" class="chip ${f.workout_type_id === t.id ? 'on' : ''}" data-act="type" data-v="${t.id}">${esc(t.name)}</button>`).join('')}
        <button type="button" class="chip add" data-act="add-type-open">＋ סוג חדש</button>
      </div>
      ${f.addingType || types.length === 0 ? `<div class="inline-add"><input class="input" id="newType" placeholder="שם סוג אימון חדש ל${esc(providerById(f.provider_id)?.name)}"><button type="button" class="btn primary" data-act="add-type">הוספה</button></div>` : ''}`}
    </div>
  </div>

  <div class="card">
    <div class="field" style="margin-bottom:4px">
      <div class="label">מי ביצעה את האימון?</div>
      <div class="seg">
        <button type="button" class="chip ${f.performed_by === 'self' ? 'on' : ''}" data-act="performer" data-v="self">אני ביצעתי את האימון</button>
        <button type="button" class="chip sub ${f.performed_by === 'substitute' ? 'on' : ''}" data-act="performer" data-v="substitute">מאמנת אחרת החליפה אותי</button>
      </div>
      ${f.performed_by === 'substitute' ? `
        <div style="margin-top:12px">
          <label for="fSub" class="label" style="display:block;font-weight:700;margin-bottom:6px">שם המאמנת המחליפה <span style="color:var(--danger)">*</span></label>
          <input class="input" id="fSub" value="${esc(f.substitute_name)}" placeholder="שם המאמנת" required>
          ${subNames.length ? `<div class="chips" style="margin-top:8px">${subNames.map((n) => `<button type="button" class="chip ${f.substitute_name === n ? 'on' : ''}" data-act="sub-name" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
        </div>` : ''}
    </div>
  </div>

  <div class="save-bar"><button class="save-btn" type="submit" id="saveBtn" ${canSave ? '' : 'disabled'}>${state.saving ? 'שומר…' : (editing ? 'שמירת שינויים' : 'שמור אימון')}</button></div>
  </form>`;
}

async function submitWorkout() {
  if (state.saving) return; // מניעת שמירה כפולה
  const f = state.form;
  f.start_time = computeStart(f);
  let end = null;
  try { end = endTimeFor(f.start_time); } catch { /* validation will report */ }
  const w = {
    id: f.id || undefined,
    workout_date: f.workout_date,
    start_time: f.start_time,
    end_time: end,
    provider_id: f.provider_id,
    workout_type_id: f.workout_type_id,
    performed_by: f.performed_by,
    substitute_name: f.performed_by === 'substitute' ? f.substitute_name.trim() : null,
  };
  const original = f.id ? cache.workouts.find((x) => x.id === f.id) : null;
  const errors = validateWorkout(w, { providers: cache.providers, types: cache.workoutTypes, workouts: cache.workouts }, original);
  if (errors.length) { state.formErrors = errors; render(); toast(errors[0], 'err'); return; }

  state.saving = true;
  render();
  try {
    await DB.saveWorkout(w);
    await DB.setMeta('lastProviderId', w.provider_id);
    state.formErrors = [];
    if (f.id) {
      toast('השינויים נשמרו ✓');
      state.form = null;
      state.saving = false;
      go(state.editReturn || 'list');
      return;
    }
    toast(`האימון נשמר ✓ ${formatDM(w.workout_date)} ${w.start_time}`);
    state.form = newForm({ workout_date: f.workout_date, dateTouched: f.dateTouched, provider_id: f.provider_id });
  } catch (e) {
    state.formErrors = [e.message];
    toast(e.message, 'err');
  } finally {
    state.saving = false;
    if (state.view === 'add') render();
  }
}

function startEdit(id, from) {
  const w = cache.workouts.find((x) => x.id === id);
  if (!w) return;
  const [h, m] = w.start_time.split(':');
  const quick = MINUTES.includes(m) && HOURS.includes(Number(h));
  state.form = {
    ...newForm(),
    id: w.id,
    workout_date: w.workout_date,
    dateTouched: true,
    hour: quick ? Number(h) : null,
    minute: quick ? m : '00',
    customTime: !quick,
    start_time: w.start_time,
    provider_id: w.provider_id,
    workout_type_id: w.workout_type_id,
    performed_by: w.performed_by,
    substitute_name: w.substitute_name || '',
  };
  state.formErrors = [];
  state.editReturn = from;
  state.view = 'add';
  if (location.hash !== '#add') history.replaceState(null, '', '#add');
  render();
  window.scrollTo(0, 0);
}

async function showDetail(id) {
  const w = cache.workouts.find((x) => x.id === id);
  if (!w) return;
  const p = providerById(w.provider_id);
  const t = typeById(w.workout_type_id);
  const res = await openModal(`
    <h3>פרטי אימון</h3>
    <div class="kv"><span>תאריך</span><b>${formatDMY(w.workout_date)} (יום ${esc(dayName(w.workout_date))})</b></div>
    <div class="kv"><span>שעה</span><b class="ltr">${timeRange(w)}</b></div>
    <div class="kv"><span>ספק</span><b>${esc(p?.name)}${p && !p.is_active ? ' <span class="badge off">מושבת</span>' : ''}</b></div>
    <div class="kv"><span>סוג אימון</span><b>${esc(t?.name)}</b></div>
    <div class="kv"><span>בוצע על ידי</span><b>${w.performed_by === 'self' ? esc(trainerName() || 'אני') : `<span class="badge sub">מחליפה</span> ${esc(w.substitute_name)}`}</b></div>
    <div class="kv small muted"><span>נרשם</span><span>${new Date(w.created_at).toLocaleString('he-IL')}</span></div>
    <div class="actions">
      <button class="btn primary" data-m="edit">עריכה</button>
      <button class="btn danger" data-m="delete">מחיקה</button>
      <button class="btn" data-m="close">סגירה</button>
    </div>`);
  if (res === 'edit') startEdit(id, state.view === 'add' ? 'add' : state.view);
  if (res === 'delete') {
    const ok = await confirmModal('מחיקת אימון', `למחוק את האימון מתאריך <b>${formatDMY(w.workout_date)}</b> בשעה <b class="ltr">${timeRange(w)}</b> (${esc(p?.name)})?<br><span class="muted small">לא ניתן לבטל פעולה זו.</span>`, 'מחיקה', true);
    if (ok) {
      await DB.deleteWorkout(id);
      if (state.form?.id === id) state.form = null;
      toast('האימון נמחק');
      render();
    }
  }
}

// ---------- list ----------
function renderList() {
  const fl = state.filters;
  const months = availableMonths(cache.workouts);
  if (!months.includes(fl.month)) months.push(fl.month);
  const list = filterWorkouts(cache.workouts, fl);
  const types = fl.providerId ? typesOf(fl.providerId, { activeOnly: false }) : [];
  const groups = [];
  for (const w of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === w.workout_date) g.items.push(w); else groups.push({ date: w.workout_date, items: [w] });
  }
  const self = list.filter((w) => w.performed_by === 'self').length;
  return `<div class="card">
    <div class="filters">
      <select class="input full" id="flMonth">${months.sort().reverse().map((m) => `<option value="${m}" ${m === fl.month ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}<option value="" ${fl.month === '' ? 'selected' : ''}>כל החודשים</option></select>
      <select class="input" id="flProvider"><option value="">כל הספקים</option>${[...cache.providers].sort((a, b) => a.name.localeCompare(b.name, 'he')).map((p) => `<option value="${p.id}" ${p.id === fl.providerId ? 'selected' : ''}>${esc(p.name)}${p.is_active ? '' : ' (מושבת)'}</option>`).join('')}</select>
      <select class="input" id="flType" ${fl.providerId ? '' : 'disabled'}><option value="">${fl.providerId ? 'כל הסוגים' : 'בחרי ספק לסינון סוג'}</option>${types.map((t) => `<option value="${t.id}" ${t.id === fl.typeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <div class="seg three full">
        <button class="chip ${fl.performedBy === '' ? 'on' : ''}" data-act="fl-perf" data-v="">הכל</button>
        <button class="chip ${fl.performedBy === 'self' ? 'on' : ''}" data-act="fl-perf" data-v="self">שלי</button>
        <button class="chip sub ${fl.performedBy === 'substitute' ? 'on' : ''}" data-act="fl-perf" data-v="substitute">מחליפות</button>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="row small muted" style="margin-bottom:6px"><span><b>${list.length}</b> אימונים · ${self} אישיים · ${list.length - self} מחליפות</span></div>
    ${groups.length ? groups.map((g) => `<div class="date-head">יום ${esc(dayName(g.date))} · ${formatDMY(g.date)}</div>
      <div class="list">${g.items.map(workoutItem).join('')}</div>`).join('') : '<div class="empty">אין אימונים התואמים לסינון</div>'}
  </div>`;
}

// ---------- reports ----------
function reportTableHtml(r) {
  const typeSum = (part) => `<table><tr><th>סוג אימון</th><th>כמות</th><th>שעות</th></tr>
    ${part.summary.map((s) => `<tr><td>${esc(s.typeName)}</td><td>${s.count}</td><td>${s.hours}</td></tr>`).join('')}
    <tr class="total"><td>סה"כ</td><td>${part.total.count}</td><td>${part.total.hours}</td></tr></table>`;
  return `
    <h4>אימונים שבוצעו על ידי ${esc(trainerName() || 'המאמנת')}</h4>
    ${r.self.rows.length ? `<table><tr><th>תאריך</th><th>יום</th><th>שעה</th><th>סוג אימון</th></tr>
      ${r.self.rows.map((x) => `<tr><td>${x.date}</td><td>${esc(x.day)}</td><td class="ltr">${x.time}</td><td>${esc(x.typeName)}</td></tr>`).join('')}</table>
      ${typeSum(r.self)}` : '<div class="muted small">אין אימונים אישיים</div>'}
    <div class="subs"><h4 class="subs">אימונים שבוצעו על ידי מאמנות מחליפות</h4>
    ${r.subs.rows.length ? `<table><tr><th>תאריך</th><th>שעה</th><th>סוג אימון</th><th>מחליפה</th></tr>
      ${r.subs.rows.map((x) => `<tr><td>${x.date}</td><td class="ltr">${x.time}</td><td>${esc(x.typeName)}</td><td>${esc(x.substitute)}</td></tr>`).join('')}</table>
      ${typeSum(r.subs)}` : '<div class="muted small">אין אימונים של מחליפות</div>'}</div>`;
}

function renderReports() {
  const month = state.reportMonth;
  const months = availableMonths(cache.workouts);
  const prev = shiftMonth(currentMonthKey(), -1);
  if (!months.includes(prev)) months.push(prev);
  if (!months.includes(month)) months.push(month);
  const reports = buildAllReports({ providers: cache.providers, workouts: cache.workouts, types: cache.workoutTypes }, month);
  const canShare = !!navigator.canShare;
  return `<div class="card">
    <div class="field" style="margin-bottom:10px"><div class="label">חודש הדוח</div>
      <div class="chips" style="margin-bottom:8px">
        <button class="chip ${month === currentMonthKey() ? 'on' : ''}" data-act="rep-month" data-v="${currentMonthKey()}">החודש</button>
        <button class="chip ${month === prev ? 'on' : ''}" data-act="rep-month" data-v="${prev}">החודש הקודם</button>
      </div>
      <select class="input" id="repMonth">${months.sort().reverse().map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select>
    </div>
    ${reports.length ? `
      <div class="row wrap">
        <button class="btn primary" data-act="xlsx">Excel מרוכז לכל הספקים</button>
        <button class="btn" data-act="pdf-all">כל קובצי ה-PDF</button>
        <button class="btn wa" data-act="wa-open" data-v="">${WA_ICON} שליחה בוואטסאפ</button>
      </div>
      <div class="hint">${canShare ? 'הקבצים ייפתחו לשיתוף (וואטסאפ, מייל, שמירה לקבצים).' : 'הקבצים יורדו למכשיר.'}</div>` : ''}
  </div>
  ${reports.length ? reports.map((r) => `<div class="card rep">
      <div class="row"><h3 class="spacer">${esc(r.provider.name)}</h3></div>
      <div class="row wrap small" style="margin-bottom:10px">
        <span class="badge">${r.totals.self} אישי</span><span class="badge sub">${r.totals.subs} מחליפות</span>
        <span class="badge off">סה"כ ${r.totals.all} אימונים · ${r.totals.allHours} שעות</span></div>
      <div class="row wrap">
        <button class="btn primary" data-act="pdf" data-v="${r.provider.id}">PDF</button>
        <button class="btn wa" data-act="wa-open" data-v="${r.provider.id}">${WA_ICON} וואטסאפ</button>
        <button class="btn" data-act="toggle-rep" data-v="${r.provider.id}">${state.openReport === r.provider.id ? 'הסתרת פירוט' : 'הצגת פירוט'}</button>
      </div>
      ${state.openReport === r.provider.id ? reportTableHtml(r) : ''}
    </div>`).join('') : `<div class="card empty">לא נרשמו אימונים ב${esc(monthLabel(month))}</div>`}`;
}

async function deliverFiles(files) {
  const fileObjs = files.map((f) => new File([f.data], f.name, { type: f.type }));
  if (navigator.canShare && navigator.canShare({ files: fileObjs })) {
    try {
      await navigator.share({ files: fileObjs, title: files.length === 1 ? files[0].name : 'דוחות חודשיים' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      // אם השיתוף נכשל – ממשיכים להורדה רגילה
    }
  }
  for (const f of fileObjs) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const reportData = () => ({ providers: cache.providers, workouts: cache.workouts, types: cache.workoutTypes });
const pdfName = (r) => `${safeFileName(`דוח_${r.provider.name}_${MONTHS[Number(r.month.slice(5)) - 1]}_${r.month.slice(0, 4)}`)}.pdf`;

async function withBusy(label, fn) {
  toast(label, 'ok');
  await new Promise((r) => setTimeout(r, 30));
  try { await fn(); } catch (e) { console.error(e); toast(`שגיאה: ${e.message}`, 'err'); }
}

// ---------- WhatsApp ----------
const WA_ICON = '<svg class="wa-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM6.6 11a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0zM10.6 11a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0zM14.6 11a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0z"/></svg>';

const wa = { month: null, selected: new Map(), text: '', edited: false };

function waProviders() {
  return buildAllReports(reportData(), wa.month).map((r) => providerById(r.provider.id)).filter(Boolean);
}

/** סוגי אימונים שיש להם אימונים אצל הספק בחודש הנבחר */
function waTypesFor(pid) {
  const ids = new Set(cache.workouts.filter((w) => w.provider_id === pid && monthKeyOf(w.workout_date) === wa.month).map((w) => w.workout_type_id));
  return cache.workoutTypes.filter((t) => ids.has(t.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function waBuildText() {
  const selections = waProviders().filter((p) => wa.selected.has(p.id) && wa.selected.get(p.id).size)
    .map((p) => ({ providerId: p.id, typeIds: [...wa.selected.get(p.id)] }));
  return selections.length ? buildWhatsAppText(reportData(), wa.month, selections) : '';
}

function renderWaModal() {
  const provs = waProviders();
  if (!wa.edited) wa.text = waBuildText();
  return `<div class="modal-back" id="waBack"><div class="modal" role="dialog" aria-modal="true">
    <h3>${WA_ICON} שליחת פירוט בוואטסאפ</h3>
    <div class="muted small" style="margin-bottom:10px">${esc(monthLabel(wa.month))} · בחרי ספקים וסוגי אימונים</div>
    ${provs.map((p) => {
      const on = wa.selected.has(p.id);
      const types = waTypesFor(p.id);
      const sel = wa.selected.get(p.id);
      return `<div class="wa-prov ${on ? 'on' : ''}">
        <button type="button" class="wa-check" data-wa="prov" data-v="${p.id}"><span class="box">${on ? '✓' : ''}</span>${esc(p.name)}</button>
        ${on ? `<div class="chips" style="margin-top:8px">
          <button type="button" class="chip ${sel.size === types.length ? 'on' : ''}" data-wa="all" data-v="${p.id}">כל הסוגים</button>
          ${types.map((t) => `<button type="button" class="chip ${sel.has(t.id) ? 'on' : ''}" data-wa="type" data-p="${p.id}" data-v="${t.id}">${esc(t.name)}</button>`).join('')}
        </div>` : ''}
      </div>`;
    }).join('')}
    <div class="row" style="margin:14px 0 6px"><b class="spacer">תצוגה מקדימה</b>
      ${wa.edited ? '<button type="button" class="btn ghost" data-wa="reset">שחזור הטקסט האוטומטי</button>' : '<span class="muted small">אפשר לערוך לפני השליחה</span>'}</div>
    <textarea class="input wa-text" id="waText" dir="rtl">${esc(wa.text)}</textarea>
    <div class="actions">
      <button type="button" class="btn wa" data-wa="send" ${wa.text.trim() ? '' : 'disabled'}>${WA_ICON} פתיחה בוואטסאפ</button>
      <button type="button" class="btn" data-wa="copy" ${wa.text.trim() ? '' : 'disabled'}>העתקה</button>
      <button type="button" class="btn" data-wa="close">סגירה</button>
    </div>
    <div class="hint">בוואטסאפ תבחרי את איש הקשר שאליו נשלחת ההודעה.</div>
  </div></div>`;
}

function waRender() {
  const root = $('#modalRoot');
  const scroll = root.querySelector('.modal')?.scrollTop || 0;
  root.innerHTML = renderWaModal();
  root.querySelector('.modal').scrollTop = scroll;
}

function openWhatsAppComposer(providerId) {
  wa.month = state.reportMonth;
  wa.selected = new Map();
  wa.edited = false;
  const provs = waProviders();
  const initial = providerId ? provs.filter((p) => p.id === providerId) : provs;
  for (const p of initial) wa.selected.set(p.id, new Set(waTypesFor(p.id).map((t) => t.id)));
  waRender();
}

$('#modalRoot').addEventListener('click', async (e) => {
  if (!$('#waBack')) return;
  if (e.target.id === 'waBack') { $('#modalRoot').innerHTML = ''; return; }
  const b = e.target.closest('[data-wa]');
  if (!b) return;
  const { v } = b.dataset;
  switch (b.dataset.wa) {
    case 'prov':
      if (wa.selected.has(v)) wa.selected.delete(v); else wa.selected.set(v, new Set(waTypesFor(v).map((t) => t.id)));
      wa.edited = false; return waRender();
    case 'all': {
      const all = waTypesFor(v).map((t) => t.id);
      const cur = wa.selected.get(v);
      wa.selected.set(v, cur.size === all.length ? new Set() : new Set(all));
      wa.edited = false; return waRender();
    }
    case 'type': {
      const set = wa.selected.get(b.dataset.p);
      if (set.has(v)) set.delete(v); else set.add(v);
      wa.edited = false; return waRender();
    }
    case 'reset': wa.edited = false; return waRender();
    case 'copy':
      try { await navigator.clipboard.writeText(wa.text); toast('הטקסט הועתק ✓'); } catch { toast('לא ניתן להעתיק – סמני את הטקסט והעתיקי ידנית', 'err'); }
      return;
    case 'send': {
      const a = document.createElement('a');
      a.href = `https://wa.me/?text=${encodeURIComponent(wa.text)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    case 'close': $('#modalRoot').innerHTML = ''; return;
    default:
  }
});

$('#modalRoot').addEventListener('input', (e) => {
  if (e.target.id !== 'waText') return;
  wa.text = e.target.value;
  if (!wa.edited) {
    wa.edited = true;
    // מציג את כפתור "שחזור" בלי לאבד פוקוס בשדה
    const hint = e.target.previousElementSibling.querySelector('.muted');
    if (hint) hint.outerHTML = '<button type="button" class="btn ghost" data-wa="reset">שחזור הטקסט האוטומטי</button>';
  }
  const empty = !wa.text.trim();
  document.querySelectorAll('[data-wa=send],[data-wa=copy]').forEach((btn) => { btn.disabled = empty; });
});

// ---------- daily reminder ----------
const remCfg = () => ({
  enabled: cache.meta.reminderEnabled !== false,
  time: cache.meta.reminderTime || DEFAULT_REMINDER.time,
  days: cache.meta.reminderDays || DEFAULT_REMINDER.days,
});
const notifPerm = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

function renderReminderCard() {
  const c = remCfg();
  const perm = notifPerm();
  return `<div class="card">
    <h2>תזכורת יומית</h2>
    <div class="seg" style="margin-bottom:12px">
      <button class="chip ${c.enabled ? 'on' : ''}" data-act="rem-toggle" data-v="1">פעילה</button>
      <button class="chip ${c.enabled ? '' : 'on'}" data-act="rem-toggle" data-v="0">כבויה</button>
    </div>
    ${c.enabled ? `
    <div class="field"><label for="remTime">שעת התזכורת</label>
      <input class="input" type="time" id="remTime" value="${c.time}" style="direction:ltr"></div>
    <div class="field"><div class="label">ימים</div>
      <div class="chips grid7">${['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'].map((d, i) => `<button class="chip ${c.days.includes(i) ? 'on' : ''}" data-act="rem-day" data-v="${i}" title="${DAYS[i]}">${d}</button>`).join('')}</div></div>
    <div class="kv small"><span>התראות בטלפון</span><b id="remPerm">${perm === 'granted' ? 'מאושרות ✓' : perm === 'denied' ? 'חסומות' : perm === 'unsupported' ? 'לא נתמך במכשיר' : 'עדיין לא אושרו'}</b></div>
    <div class="kv small"><span>בדיקה ברקע</span><b id="remBg">בודק…</b></div>
    <div class="row wrap" style="margin-top:12px">
      ${perm === 'default' ? '<button class="btn primary" data-act="rem-perm">הפעלת התראות</button>' : ''}
      ${perm === 'granted' ? '<button class="btn" data-act="rem-test">שליחת התראת בדיקה</button>' : ''}
    </div>
    ${perm === 'denied' ? '<div class="hint">ההתראות נחסמו. כדי לאפשר: הגדרות הטלפון ← אפליקציות ← Chrome (או יומן אימונים) ← התראות.</div>' : ''}
    <div class="hint">בכל יום פעיל, בשעה שנקבעה, תופיע התראה שתשאל אם הכנסת את כל האימונים של היום. מערכת אנדרואיד קובעת מתי בדיוק להעיר את האפליקציה, ולכן ההתראה עלולה להגיע באיחור. אם פותחים את האפליקציה אחרי השעה שנקבעה, התזכורת תופיע גם במסך הבית.</div>
    ` : ''}
  </div>`;
}

async function swReg() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}

/** רישום להשכמה תקופתית ברקע (Chrome באנדרואיד, אפליקציה מותקנת בלבד). מחזיר טקסט סטטוס. */
async function setupBackgroundReminder() {
  const reg = await swReg();
  if (!reg || !('periodicSync' in reg)) return 'לא נתמך במכשיר';
  if (!remCfg().enabled) {
    try { await reg.periodicSync.unregister('daily-reminder'); } catch { /* ignore */ }
    return 'כבויה';
  }
  try {
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return 'זמינה רק אחרי התקנה במסך הבית';
    await reg.periodicSync.register('daily-reminder', { minInterval: 60 * 60 * 1000 });
    return 'פעילה ✓';
  } catch { return 'לא זמינה'; }
}

async function refreshReminderStatus() {
  const el = $('#remBg');
  if (el) el.textContent = await setupBackgroundReminder();
}

/** נקרא כל דקה: באפליקציה פתוחה – באנר; כשהיא ברקע – התראת מערכת. */
async function checkReminder() {
  if (!reminderDue(cache.meta)) return;
  if (document.hidden) {
    if (notifPerm() === 'granted') (await swReg())?.active?.postMessage({ type: 'check-reminder' });
  } else if (state.view === 'home' && !$('.banner.remind')) render();
}

navigator.serviceWorker?.addEventListener('message', async (e) => {
  if (e.data?.type === 'go') {
    await DB.setMeta('lastReminderDate', todayISO());
    go(e.data.view);
  }
});

// ---------- manage ----------
function renderManage() {
  const provs = [...cache.providers].sort((a, b) => (b.is_active - a.is_active) || a.created_at.localeCompare(b.created_at));
  const lastBackup = cache.meta.lastBackupAt;
  return `
  <div class="card">
    <h2>ספקים וסוגי אימונים</h2>
    <div class="inline-add" style="margin:0 0 14px"><input class="input" id="mNewProvider" placeholder="שם ספק חדש"><button class="btn primary" data-act="m-add-provider">הוספת ספק</button></div>
    ${provs.length ? provs.map((p) => {
      const types = typesOf(p.id, { activeOnly: false });
      const used = DB.providerInUse(p.id);
      const open = state.openProvider === p.id;
      return `<div class="prov-card ${p.is_active ? '' : 'off'}">
        <div class="prov-head">
          <span class="name">${esc(p.name)}</span>
          ${p.is_active ? '' : '<span class="badge off">מושבת</span>'}
          <button class="icon-btn" data-act="m-open" data-v="${p.id}">${types.length} סוגים ${open ? '▲' : '▼'}</button>
        </div>
        <div class="row wrap" style="margin-top:8px">
          <button class="btn" data-act="m-rename-p" data-v="${p.id}">עריכת שם</button>
          <button class="btn" data-act="m-toggle-p" data-v="${p.id}">${p.is_active ? 'השבתה' : 'הפעלה'}</button>
          ${used ? '' : `<button class="btn danger" data-act="m-del-p" data-v="${p.id}">מחיקה</button>`}
        </div>
        ${open ? `<div class="types">
          ${types.map((t) => `<div class="type-row ${t.is_active ? '' : 'off'}"><span class="name">${esc(t.name)}</span>
            <button class="icon-btn" data-act="m-rename-t" data-v="${t.id}" title="עריכת שם">✎</button>
            <button class="icon-btn" data-act="m-toggle-t" data-v="${t.id}">${t.is_active ? 'השבתה' : 'הפעלה'}</button>
            ${DB.typeInUse(t.id) ? '' : `<button class="icon-btn" data-act="m-del-t" data-v="${t.id}" title="מחיקה">🗑</button>`}</div>`).join('') || '<div class="muted small">אין עדיין סוגי אימונים</div>'}
          <div class="inline-add"><input class="input" id="mNewType" placeholder="סוג אימון חדש"><button class="btn primary" data-act="m-add-type" data-v="${p.id}">הוספה</button></div>
        </div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">עדיין אין ספקים</div>'}
    <div class="hint">ספק או סוג אימון שכבר נרשמו עליהם אימונים ניתנים להשבתה בלבד, כדי לשמור על הדוחות הקודמים.</div>
  </div>

  <div class="card">
    <h2>הגדרות</h2>
    <div class="field"><label for="sName">השם שלך (מופיע בדוחות)</label>
      <div class="inline-add" style="margin:0"><input class="input" id="sName" value="${esc(trainerName())}"><button class="btn primary" data-act="save-name">שמירה</button></div></div>
  </div>

  ${renderReminderCard()}

  <div class="card">
    <h2>גיבוי ושחזור</h2>
    <p class="small muted" style="margin-top:0">הנתונים שמורים בטלפון בלבד. מומלץ לשמור גיבוי פעם בחודש (לדוגמה, לשלוח לעצמך במייל או לשמור ב-Drive).</p>
    <div class="kv small"><span>אימונים שמורים</span><b>${cache.workouts.length}</b></div>
    <div class="kv small"><span>גיבוי אחרון</span><b>${lastBackup ? new Date(lastBackup).toLocaleDateString('he-IL') : 'עדיין לא בוצע'}</b></div>
    <div class="kv small"><span>אחסון קבוע</span><b id="persistState">בודק…</b></div>
    <div class="row wrap" style="margin-top:12px">
      <button class="btn sub" data-act="backup">שמירת קובץ גיבוי</button>
      <label class="btn" for="restoreFile" style="display:inline-flex;align-items:center">שחזור מגיבוי</label>
      <input type="file" id="restoreFile" accept=".json,application/json" class="hidden">
    </div>
  </div>
  <div class="center small muted" style="padding:6px 0 20px">יומן אימונים · גרסה ${APP_VERSION}</div>`;
}

const APP_VERSION = '1.3.1';

async function doBackup() {
  const data = DB.exportData();
  const name = `גיבוי_יומן_אימונים_${todayISO()}.json`;
  await deliverFiles([{ name, type: 'application/json', data: JSON.stringify(data, null, 1) }]);
  await DB.setMeta('lastBackupAt', new Date().toISOString());
  toast('קובץ הגיבוי נוצר ✓');
  render();
}

async function doRestore(file) {
  try {
    const obj = JSON.parse(await file.text());
    const data = validateBackup(obj);
    const ok = await confirmModal('שחזור מגיבוי',
      `הגיבוי מתאריך <b>${new Date(obj.exported_at).toLocaleDateString('he-IL')}</b> כולל <b>${data.workouts.length}</b> אימונים ו-<b>${data.providers.length}</b> ספקים.<br><br>
       השחזור <b>יחליף</b> את כל הנתונים הנוכחיים (${cache.workouts.length} אימונים). מומלץ לשמור קודם גיבוי של המצב הנוכחי.`, 'שחזור', true);
    if (!ok) return;
    await DB.replaceAll(data);
    await DB.setMeta('onboarded', true);
    toast('הנתונים שוחזרו בהצלחה ✓');
    state.form = null;
    render();
  } catch (e) {
    toast(e instanceof SyntaxError ? 'הקובץ אינו קובץ גיבוי תקין' : e.message, 'err');
  }
}

// ---------- month change automation ----------
async function checkMonth() {
  const cm = currentMonthKey();
  const last = cache.meta.lastSeenMonth;
  if (last !== cm) {
    if (last && last < cm) {
      const prev = shiftMonth(cm, -1);
      if (cache.workouts.some((w) => monthKeyOf(w.workout_date) === prev)) await DB.setMeta('pendingReportMonth', prev);
    }
    await DB.setMeta('lastSeenMonth', cm);
    if (state.filters.month === last) state.filters.month = cm;
    if (state.reportMonth === last) state.reportMonth = cm;
    if (state.view === 'home' || state.view === 'list') render();
  }
  // תאריך ברירת מחדל מתעדכן ליום החדש אם המשתמשת לא שינתה אותו
  if (state.form && !state.form.id && !state.form.dateTouched && state.form.workout_date !== todayISO()) {
    state.form.workout_date = todayISO();
    if (state.view === 'add') render();
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const v = el.dataset.v;
  const f = state.form;
  const rerender = () => render();

  switch (act) {
    // add form
    case 'date': f.workout_date = v; f.dateTouched = v !== todayISO(); return rerender();
    case 'hour': f.hour = Number(v); f.customTime = false; state.formErrors = []; return rerender();
    case 'minute': f.minute = v; if (f.hour === null) return rerender(); return rerender();
    case 'freq': { const [h, m] = v.split(':'); if (MINUTES.includes(m) && HOURS.includes(Number(h))) { f.hour = Number(h); f.minute = m; f.customTime = false; } else { f.customTime = true; f.start_time = v; } return rerender(); }
    case 'custom-time-on': f.customTime = true; f.start_time = computeStart({ ...f, customTime: false }); return rerender();
    case 'custom-time-off': f.customTime = false; return rerender();
    case 'provider':
      if (f.provider_id !== v) { f.provider_id = v; f.workout_type_id = null; f.addingType = false; }
      return rerender();
    case 'type': f.workout_type_id = v; return rerender();
    case 'performer': f.performed_by = v; if (v === 'self') f.substitute_name = ''; rerender(); if (v === 'substitute') $('#fSub')?.focus(); return;
    case 'sub-name': f.substitute_name = v; return rerender();
    case 'add-provider-open': f.addingProvider = !f.addingProvider; rerender(); $('#newProvider')?.focus(); return;
    case 'add-type-open': f.addingType = !f.addingType; rerender(); $('#newType')?.focus(); return;
    case 'add-provider': {
      try {
        const p = await DB.addProvider($('#newProvider').value);
        f.provider_id = p.id; f.workout_type_id = null; f.addingProvider = false; f.addingType = true;
        toast(`הספק "${p.name}" נוסף`);
        rerender(); $('#newType')?.focus();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    case 'add-type': {
      try {
        const t = await DB.addType(f.provider_id, $('#newType').value);
        f.workout_type_id = t.id; f.addingType = false;
        toast(`סוג האימון "${t.name}" נוסף`);
        rerender();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    case 'cancel-edit': state.form = null; return go(state.editReturn || 'list');
    case 'detail': return showDetail(el.dataset.id);

    // home
    case 'pending-report': state.reportMonth = cache.meta.pendingReportMonth; await DB.setMeta('pendingReportMonth', null); return go('reports');
    case 'pending-dismiss': await DB.setMeta('pendingReportMonth', null); return rerender();
    case 'backup': return doBackup();

    // list
    case 'fl-perf': state.filters.performedBy = v; return rerender();

    // reports
    case 'rep-month': state.reportMonth = v; state.openReport = null; return rerender();
    case 'toggle-rep': state.openReport = state.openReport === v ? null : v; return rerender();
    case 'pdf': return withBusy('מפיק PDF…', async () => {
      const r = buildProviderReport(reportData(), providerById(v), state.reportMonth);
      await deliverFiles([{ name: pdfName(r), type: 'application/pdf', data: reportToPdf(r, { trainerName: trainerName() }) }]);
    });
    case 'pdf-all': return withBusy('מפיק קובצי PDF…', async () => {
      const reports = buildAllReports(reportData(), state.reportMonth);
      await deliverFiles(reports.map((r) => ({ name: pdfName(r), type: 'application/pdf', data: reportToPdf(r, { trainerName: trainerName() }) })));
    });
    case 'wa-open': return openWhatsAppComposer(v);
    case 'xlsx': return withBusy('מפיק Excel…', async () => {
      const m = state.reportMonth;
      const reports = buildAllReports(reportData(), m);
      const name = `${safeFileName(`דוח_שעות_${MONTHS[Number(m.slice(5)) - 1]}_${m.slice(0, 4)}`)}.xlsx`;
      await deliverFiles([{ name, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: reportsToXlsx(reports, m, { trainerName: trainerName() }) }]);
    });

    // manage
    case 'm-add-provider': try { const p = await DB.addProvider($('#mNewProvider').value); state.openProvider = p.id; toast('הספק נוסף'); rerender(); $('#mNewType')?.focus(); } catch (err) { toast(err.message, 'err'); } return;
    case 'm-open': state.openProvider = state.openProvider === v ? null : v; return rerender();
    case 'm-rename-p': { const p = providerById(v); const n = await promptModal('עריכת שם ספק', p.name); if (n) { try { await DB.updateProvider(v, { name: n }); toast('השם עודכן'); } catch (err) { toast(err.message, 'err'); } rerender(); } return; }
    case 'm-toggle-p': { const p = providerById(v); await DB.updateProvider(v, { is_active: !p.is_active }); toast(p.is_active ? 'הספק הושבת' : 'הספק הופעל'); return rerender(); }
    case 'm-del-p': { const p = providerById(v); if (await confirmModal('מחיקת ספק', `למחוק את הספק <b>${esc(p.name)}</b> ואת סוגי האימונים שלו?`, 'מחיקה', true)) { try { await DB.deleteProvider(v); toast('הספק נמחק'); } catch (err) { toast(err.message, 'err'); } rerender(); } return; }
    case 'm-add-type': try { await DB.addType(v, $('#mNewType').value); toast('סוג האימון נוסף'); rerender(); $('#mNewType')?.focus(); } catch (err) { toast(err.message, 'err'); } return;
    case 'm-rename-t': { const t = typeById(v); const n = await promptModal('עריכת שם סוג אימון', t.name); if (n) { try { await DB.updateType(v, { name: n }); toast('השם עודכן'); } catch (err) { toast(err.message, 'err'); } rerender(); } return; }
    case 'm-toggle-t': { const t = typeById(v); await DB.updateType(v, { is_active: !t.is_active }); toast(t.is_active ? 'סוג האימון הושבת' : 'סוג האימון הופעל'); return rerender(); }
    case 'm-del-t': { const t = typeById(v); if (await confirmModal('מחיקת סוג אימון', `למחוק את <b>${esc(t.name)}</b>?`, 'מחיקה', true)) { try { await DB.deleteType(v); toast('סוג האימון נמחק'); } catch (err) { toast(err.message, 'err'); } rerender(); } return; }
    case 'remind-go': await DB.setMeta('lastReminderDate', todayISO()); return go('add');
    case 'remind-dismiss': await DB.setMeta('lastReminderDate', todayISO()); return rerender();
    case 'rem-toggle': await DB.setMeta('reminderEnabled', v === '1'); rerender(); return refreshReminderStatus();
    case 'rem-day': {
      const days = new Set(remCfg().days);
      const d = Number(v);
      if (days.has(d)) days.delete(d); else days.add(d);
      await DB.setMeta('reminderDays', [...days].sort());
      return rerender();
    }
    case 'rem-perm': {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      rerender();
      await refreshReminderStatus();
      if (notifPerm() === 'granted') toast('ההתראות הופעלו ✓');
      return;
    }
    case 'rem-test': {
      const reg = await swReg();
      reg?.active?.postMessage({ type: 'test-reminder' });
      toast('נשלחה התראת בדיקה');
      return;
    }
    case 'save-name': await DB.setMeta('trainerName', $('#sName').value.trim()); toast('השם נשמר'); return rerender();
    default:
  }
});

document.addEventListener('change', (e) => {
  const id = e.target.id;
  const f = state.form;
  if (id === 'fDate' && e.target.value) { f.workout_date = e.target.value; f.dateTouched = e.target.value !== todayISO(); render(); }
  if (id === 'fTime') { f.start_time = e.target.value || null; render(); }
  if (id === 'flMonth') { state.filters.month = e.target.value; render(); }
  if (id === 'flProvider') { state.filters.providerId = e.target.value; state.filters.typeId = ''; render(); }
  if (id === 'flType') { state.filters.typeId = e.target.value; render(); }
  if (id === 'repMonth') { state.reportMonth = e.target.value; state.openReport = null; render(); }
  if (id === 'restoreFile' && e.target.files[0]) doRestore(e.target.files[0]);
  if (id === 'remTime' && e.target.value) DB.setMeta('reminderTime', e.target.value).then(() => toast(`התזכורת תופיע ב-${e.target.value}`));
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'fSub' && state.form) {
    state.form.substitute_name = e.target.value;
    const btn = $('#saveBtn');
    const f = state.form;
    const conflict = f.start_time && findConflict(cache.workouts, { id: f.id, workout_date: f.workout_date, start_time: f.start_time });
    if (btn) btn.disabled = !(f.start_time && f.provider_id && f.workout_type_id && !conflict && e.target.value.trim());
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const map = { newProvider: 'add-provider', newType: 'add-type', mNewProvider: 'm-add-provider', mNewType: 'm-add-type', sName: 'save-name' };
  const act = map[e.target.id];
  if (act) {
    e.preventDefault();
    document.querySelector(`[data-act="${act}"]`)?.click();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'workoutForm') { e.preventDefault(); return submitWorkout(); }
  if (e.target.id === 'onbForm') {
    e.preventDefault();
    const fd = new FormData(e.target);
    await DB.setMeta('trainerName', String(fd.get('name') || '').trim());
    for (let i = 1; i <= 5; i++) {
      const n = String(fd.get(`p${i}`) || '').trim();
      if (n && !cache.providers.some((p) => p.name === n)) await DB.addProvider(n);
    }
    await DB.setMeta('onboarded', true);
    await DB.setMeta('lastSeenMonth', currentMonthKey());
    toast('הכול מוכן! אפשר להתחיל לרשום אימונים');
    location.hash = cache.providers.length ? 'manage' : 'home';
    if (cache.providers.length) state.openProvider = activeProviders()[0]?.id;
    route();
  }
});

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkMonth(); });

async function showPersistState() {
  const el = $('#persistState');
  if (!el) return;
  try {
    const p = await navigator.storage?.persisted?.();
    el.textContent = p ? 'פעיל ✓' : 'לא אושר (מומלץ להתקין את האפליקציה במסך הבית)';
  } catch { el.textContent = 'לא ידוע'; }
}
new MutationObserver(() => { showPersistState(); refreshReminderStatus(); }).observe(main, { childList: true });

// ---------- boot ----------
(async function boot() {
  try {
    await DB.openDB();
  } catch (e) {
    main.innerHTML = `<div class="card alert">לא ניתן לפתוח את מאגר הנתונים: ${esc(e.message)}</div>`;
    return;
  }
  await checkMonth();
  route();
  setInterval(() => { checkMonth(); checkReminder(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminder(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // גרסה חדשה הותקנה – טעינה מחדש פעם אחת כדי להציג אותה
      if (hadController && !sessionStorage.getItem('reloaded')) { sessionStorage.setItem('reloaded', '1'); location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).then(() => setupBackgroundReminder()).catch(() => {});
  }
}());

// חשיפה לבדיקות אוטומטיות בלבד
window.__app = { state, cache, DB, sortChrono };
