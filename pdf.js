// כותב PDF מינימלי: כל עמוד הוא תמונת JPEG בגודל A4.
// כך העברית וה-RTL מוצגים בדיוק כפי שצוירו, בכל מכשיר וללא גופנים מוטמעים.

const enc = new TextEncoder();

export function buildPdfFromJpegs(pages, { pageWidth = 595.28, pageHeight = 841.89 } = {}) {
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    offset += b.length;
  };
  const obj = (num, body) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // מספור: 1 catalog, 2 pages, לכל עמוד: page, content, image
  const pageNum = (i) => 3 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageNum(i)} 0 R`).join(' ')}] >>`));

  pages.forEach((pg, i) => {
    const p = pageNum(i);
    const W = pageWidth.toFixed(2);
    const H = pageHeight.toFixed(2);
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(p + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(p + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      push(pg.bytes);
      push('\nendstream');
    });
  });

  const total = 3 + n * 3;
  const xref = offset;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

export function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
