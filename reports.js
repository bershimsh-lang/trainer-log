// הפקת קבצי דוח: PDF לכל ספק (ציור על canvas) ו-Excel מרוכז.
import { buildPdfFromJpegs, dataUrlToBytes } from './pdf.js';
import { buildXlsx, STYLE } from './xlsx.js';
import { monthLabel, formatDMY, todayISO } from './logic.js';

const PAGE_W = 1240;
const PAGE_H = 1754; // A4 ב-150dpi
const M = 90;
const RIGHT = PAGE_W - M;
const CW = PAGE_W - 2 * M;
const FONT = 'system-ui, -apple-system, "Segoe UI", Arial, "Noto Sans Hebrew", "DejaVu Sans", sans-serif';
const C = {
  ink: '#1f2937', muted: '#6b7280', line: '#d0d7de', teal: '#0f766e', tealBg: '#e6f2f0',
  amber: '#b45309', amberBg: '#fdf3e7', head: '#0f4c5c', zebra: '#f8fafc', white: '#ffffff',
};

const performerLabel = (name) => (name ? `שבוצעו על ידי ${name}` : 'שבוצעו על ידי המאמנת');

class Painter {
  constructor(footerText) {
    this.pages = [];
    this.footerText = footerText;
    this.newPage();
  }

  newPage() {
    const cv = document.createElement('canvas');
    cv.width = PAGE_W;
    cv.height = PAGE_H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = C.white;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.direction = 'rtl';
    ctx.textBaseline = 'middle';
    this.pages.push(cv);
    this.ctx = ctx;
    this.y = M;
  }

  ensure(h) {
    if (this.y + h > PAGE_H - M - 30) { this.newPage(); return true; }
    return false;
  }

  font(size, weight = 400) { this.ctx.font = `${weight} ${size}px ${FONT}`; }

  fit(text, maxW) {
    const ctx = this.ctx;
    text = String(text ?? '');
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(`${text}…`).width > maxW) text = text.slice(0, -1);
    return `${text}…`;
  }

  /** טקסט מיושר לימין בנקודה x (קצה ימני). */
  text(str, x, y, { size = 24, weight = 400, color = C.ink, align = 'right', maxW = CW } = {}) {
    const ctx = this.ctx;
    this.font(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(this.fit(str, maxW), x, y);
  }

  header(r, trainerName) {
    const ctx = this.ctx;
    ctx.fillStyle = C.head;
    ctx.fillRect(0, 0, PAGE_W, 210);
    this.text('דוח שעות חודשי', RIGHT, 70, { size: 30, color: '#cde7ea' });
    this.text(r.provider.name, RIGHT, 130, { size: 52, weight: 700, color: C.white });
    this.text(`חודש דיווח: ${r.monthLabel}`, M, 70, { size: 26, color: C.white, align: 'left', maxW: 500 });
    this.text(`הופק בתאריך: ${r.generatedAt}`, M, 120, { size: 22, color: '#cde7ea', align: 'left', maxW: 500 });
    if (trainerName) this.text(`מאמנת: ${trainerName}`, M, 165, { size: 22, color: '#cde7ea', align: 'left', maxW: 500 });
    this.y = 260;
  }

  sectionTitle(title, color) {
    this.ensure(140);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(RIGHT - 10, this.y - 22, 10, 44);
    this.text(title, RIGHT - 26, this.y, { size: 32, weight: 700, color });
    this.y += 50;
  }

  note(str) {
    this.ensure(50);
    this.text(str, RIGHT, this.y, { size: 22, color: C.muted });
    this.y += 50;
  }

  /**
   * טבלה עם עמודות מימין לשמאל. columns: [{ label, w, ltr? }] (w = חלק יחסי).
   * footer: שורות סיכום מודגשות בסוף.
   */
  table(columns, rows, { color = C.teal, bg = C.tealBg, footer = [], rowH = 46 } = {}) {
    const totalW = columns.reduce((s, c) => s + c.w, 0);
    const widths = columns.map((c) => (c.w / totalW) * CW);
    const drawHeader = () => {
      const ctx = this.ctx;
      ctx.fillStyle = color;
      ctx.fillRect(M, this.y, CW, rowH);
      let x = RIGHT;
      columns.forEach((c, i) => {
        this.text(c.label, x - 14, this.y + rowH / 2, { size: 22, weight: 700, color: C.white, maxW: widths[i] - 20 });
        x -= widths[i];
      });
      this.y += rowH;
    };
    const drawRow = (cells, i, isFooter) => {
      if (this.ensure(rowH)) drawHeader();
      const ctx = this.ctx;
      ctx.fillStyle = isFooter ? bg : (i % 2 ? C.zebra : C.white);
      ctx.fillRect(M, this.y, CW, rowH);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M, this.y + rowH);
      ctx.lineTo(RIGHT, this.y + rowH);
      ctx.stroke();
      let x = RIGHT;
      columns.forEach((c, ci) => {
        const val = cells[ci] ?? '';
        if (c.ltr) {
          // שעה/מספר: ציור משמאל לימין, מיושר לימין בתא
          ctx.direction = 'ltr';
          this.text(val, x - 14, this.y + rowH / 2, { size: 22, weight: isFooter ? 700 : 400, maxW: widths[ci] - 20 });
          ctx.direction = 'rtl';
        } else {
          this.text(val, x - 14, this.y + rowH / 2, { size: 22, weight: isFooter ? 700 : 400, maxW: widths[ci] - 20 });
        }
        x -= widths[ci];
      });
      this.y += rowH;
    };
    this.ensure(rowH * 2);
    drawHeader();
    rows.forEach((r, i) => drawRow(r, i, false));
    footer.forEach((r) => drawRow(r, 0, true));
    this.y += 30;
  }

  statBoxes(items) {
    this.ensure(150);
    const gap = 24;
    const w = (CW - gap * (items.length - 1)) / items.length;
    let x = RIGHT;
    for (const it of items) {
      const ctx = this.ctx;
      ctx.fillStyle = it.bg;
      ctx.fillRect(x - w, this.y, w, 120);
      this.text(it.label, x - 20, this.y + 35, { size: 22, color: it.color, maxW: w - 40 });
      ctx.direction = 'ltr';
      this.text(String(it.value), x - 20, this.y + 82, { size: 40, weight: 700, color: it.color, maxW: w - 40 });
      ctx.direction = 'rtl';
      x -= w + gap;
    }
    this.y += 150;
  }

  finish() {
    const n = this.pages.length;
    this.pages.forEach((cv, i) => {
      const ctx = cv.getContext('2d');
      ctx.direction = 'rtl';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = C.line;
      ctx.beginPath();
      ctx.moveTo(M, PAGE_H - 70);
      ctx.lineTo(RIGHT, PAGE_H - 70);
      ctx.stroke();
      ctx.font = `400 18px ${FONT}`;
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'right';
      ctx.fillText(this.footerText, RIGHT, PAGE_H - 45);
      ctx.textAlign = 'left';
      ctx.fillText(`עמוד ${i + 1} מתוך ${n}`, M, PAGE_H - 45);
    });
    return this.pages;
  }
}

const typeSummaryFooter = (total) => [['סה"כ', String(total.count), String(total.hours)]];

/** מצייר את הדוח לעמודי canvas. */
export function paintReport(r, { trainerName = '' } = {}) {
  const p = new Painter(`${r.provider.name} · ${r.monthLabel}`);
  p.header(r, trainerName);

  p.statBoxes([
    { label: 'אימונים אישיים', value: r.totals.self, color: C.teal, bg: C.tealBg },
    { label: 'אימונים ע"י מחליפות', value: r.totals.subs, color: C.amber, bg: C.amberBg },
    { label: 'סה"כ אימונים / שעות', value: `${r.totals.all} / ${r.totals.allHours}`, color: C.head, bg: '#eef2f6' },
  ]);

  // חלק 1 – אישי
  p.sectionTitle(`אימונים ${performerLabel(trainerName)}`, C.teal);
  if (r.self.rows.length === 0) p.note('לא נרשמו אימונים אישיים בחודש זה.');
  else {
    p.table(
      [{ label: 'תאריך', w: 1.1, ltr: true }, { label: 'יום', w: 1.1 }, { label: 'שעה', w: 1.6, ltr: true }, { label: 'סוג אימון', w: 3 }],
      r.self.rows.map((x) => [x.date, x.day, x.time, x.typeName]),
    );
    p.text('סיכום לפי סוג אימון – אישי', RIGHT, p.y, { size: 24, weight: 700, color: C.teal });
    p.y += 36;
    p.table(
      [{ label: 'סוג אימון', w: 3 }, { label: 'כמות אימונים', w: 1.5, ltr: true }, { label: 'סך שעות', w: 1.5, ltr: true }],
      r.self.summary.map((s) => [s.typeName, String(s.count), String(s.hours)]),
      { footer: typeSummaryFooter(r.self.total) },
    );
  }

  // חלק 2 – מחליפות
  p.sectionTitle('אימונים שבוצעו על ידי מאמנות מחליפות', C.amber);
  if (r.subs.rows.length === 0) p.note('לא נרשמו אימונים של מאמנות מחליפות בחודש זה.');
  else {
    const opt = { color: C.amber, bg: C.amberBg };
    p.table(
      [{ label: 'תאריך', w: 1.1, ltr: true }, { label: 'יום', w: 1.1 }, { label: 'שעה', w: 1.6, ltr: true }, { label: 'סוג אימון', w: 2.2 }, { label: 'שם המאמנת המחליפה', w: 2.2 }],
      r.subs.rows.map((x) => [x.date, x.day, x.time, x.typeName, x.substitute]),
      opt,
    );
    p.text('סיכום לפי סוג אימון – מחליפות', RIGHT, p.y, { size: 24, weight: 700, color: C.amber });
    p.y += 36;
    p.table(
      [{ label: 'סוג אימון', w: 3 }, { label: 'כמות אימונים', w: 1.5, ltr: true }, { label: 'סך שעות', w: 1.5, ltr: true }],
      r.subs.summary.map((s) => [s.typeName, String(s.count), String(s.hours)]),
      { ...opt, footer: typeSummaryFooter(r.subs.total) },
    );
  }

  // סיכום חודשי
  p.sectionTitle('סיכום חודשי לספק', C.head);
  p.table(
    [{ label: 'סוג אימון', w: 3 }, { label: 'אישי', w: 1.2, ltr: true }, { label: 'מחליפות', w: 1.2, ltr: true }, { label: 'סה"כ', w: 1.2, ltr: true }],
    r.byType.map((b) => [b.typeName, String(b.self), String(b.subs), String(b.total)]),
    { color: C.head, bg: '#eef2f6', footer: [['סה"כ אימונים', String(r.totals.self), String(r.totals.subs), String(r.totals.all)]] },
  );

  return p.finish();
}

export function reportToPdf(r, opts) {
  const pages = paintReport(r, opts).map((cv) => ({
    bytes: dataUrlToBytes(cv.toDataURL('image/jpeg', 0.9)),
    width: cv.width,
    height: cv.height,
  }));
  return buildPdfFromJpegs(pages);
}

// ---------- Excel ----------
const h = (v) => ({ v, s: STYLE.header });
const hs = (v) => ({ v, s: STYLE.subHeader });
const t = (v) => ({ v, s: STYLE.total });

/** בונה את גיליונות ה-Excel: גיליון סיכום + גיליון לכל ספק. */
export function reportsToXlsxSheets(reports, month, { trainerName = '' } = {}) {
  const generated = formatDMY(todayISO());
  const summaryRows = [
    [{ v: `דוח שעות חודשי – ${monthLabel(month)}`, s: STYLE.title }],
    [{ v: `הופק בתאריך: ${generated}${trainerName ? ` · מאמנת: ${trainerName}` : ''}`, s: STYLE.muted }],
    [],
    [h('ספק'), h('אימונים אישיים'), h('שעות אישיות'), h('אימונים ע"י מחליפות'), h('שעות מחליפות'), h('סה"כ אימונים'), h('סה"כ שעות')],
    ...reports.map((r) => [r.provider.name, r.totals.self, r.totals.selfHours, r.totals.subs, r.totals.subsHours, r.totals.all, r.totals.allHours]),
    [t('סה"כ'),
      t(sum(reports, (r) => r.totals.self)), t(sum(reports, (r) => r.totals.selfHours)),
      t(sum(reports, (r) => r.totals.subs)), t(sum(reports, (r) => r.totals.subsHours)),
      t(sum(reports, (r) => r.totals.all)), t(sum(reports, (r) => r.totals.allHours))],
  ];
  if (reports.length === 0) summaryRows.push(['לא נרשמו אימונים בחודש זה.']);

  const sheets = [{ name: 'סיכום', rows: summaryRows, colWidths: [26, 16, 14, 20, 14, 14, 12] }];

  for (const r of reports) {
    const rows = [
      [{ v: r.provider.name, s: STYLE.title }],
      [{ v: `חודש דיווח: ${r.monthLabel} · הופק בתאריך: ${r.generatedAt}`, s: STYLE.muted }],
      [],
      [{ v: `אימונים ${performerLabel(trainerName)}`, s: STYLE.section }],
    ];
    if (r.self.rows.length) {
      rows.push([h('תאריך'), h('יום'), h('שעה'), h('סוג אימון')]);
      r.self.rows.forEach((x) => rows.push([x.fullDate, x.day, x.time, x.typeName]));
      rows.push([]);
      rows.push([h('סוג אימון'), h('כמות אימונים'), h('סך שעות')]);
      r.self.summary.forEach((s) => rows.push([s.typeName, s.count, s.hours]));
      rows.push([t('סה"כ'), t(r.self.total.count), t(r.self.total.hours)]);
    } else rows.push(['לא נרשמו אימונים אישיים בחודש זה.']);

    rows.push([], [{ v: 'אימונים שבוצעו על ידי מאמנות מחליפות', s: STYLE.section }]);
    if (r.subs.rows.length) {
      rows.push([hs('תאריך'), hs('יום'), hs('שעה'), hs('סוג אימון'), hs('שם המאמנת המחליפה')]);
      r.subs.rows.forEach((x) => rows.push([x.fullDate, x.day, x.time, x.typeName, x.substitute]));
      rows.push([]);
      rows.push([hs('סוג אימון'), hs('כמות אימונים'), hs('סך שעות')]);
      r.subs.summary.forEach((s) => rows.push([s.typeName, s.count, s.hours]));
      rows.push([t('סה"כ'), t(r.subs.total.count), t(r.subs.total.hours)]);
    } else rows.push(['לא נרשמו אימונים של מחליפות בחודש זה.']);

    rows.push([], [{ v: 'סיכום חודשי לספק', s: STYLE.section }]);
    rows.push([h('סוג אימון'), h('אישי'), h('מחליפות'), h('סה"כ')]);
    r.byType.forEach((b) => rows.push([b.typeName, b.self, b.subs, b.total]));
    rows.push([t('סה"כ אימונים'), t(r.totals.self), t(r.totals.subs), t(r.totals.all)]);
    rows.push([t('סה"כ שעות'), t(r.totals.selfHours), t(r.totals.subsHours), t(r.totals.allHours)]);

    sheets.push({ name: r.provider.name, rows, colWidths: [24, 14, 16, 24, 24] });
  }
  return sheets;
}

function sum(list, f) { return list.reduce((s, x) => s + f(x), 0); }

export function reportsToXlsx(reports, month, opts) {
  return buildXlsx(reportsToXlsxSheets(reports, month, opts));
}
