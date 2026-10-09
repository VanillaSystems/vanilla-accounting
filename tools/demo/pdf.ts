/**
 * The smallest PDF that pdftotext and a browser both read: Helvetica, one line per string,
 * WinAnsi text, no metadata. Identical input gives identical bytes.
 */

const LINES_PER_PAGE = 54;

/** WinAnsi is Latin-1 except for a few slots; these are the ones the demo prints. */
const WIN_ANSI_EXTRA: Record<string, number> = { '€': 0x80, '–': 0x96, '’': 0x92 };

function winAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = WIN_ANSI_EXTRA[ch] ?? ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`pdf: "${ch}" has no WinAnsi code (in "${text}")`);
    const c = String.fromCharCode(code);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

function pageStream(lines: readonly string[]): string {
  const body = lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${winAnsi(l)}) Tj`).join('\n');
  return `BT\n/F1 10 Tf\n14 TL\n50 800 Td\n${body}\nET\n`;
}

export function textPdf(lines: readonly string[]): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, i) => {
    const stream = pageStream(page);
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
