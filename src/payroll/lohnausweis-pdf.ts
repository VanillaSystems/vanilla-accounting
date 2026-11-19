/**
 * The Lohnausweis as a PDF (docs/specs/payroll.md §21 decision 6): the form's letters and numbered fields
 * in the module's order and words, printed on white paper as the Wegleitung allows (Rz 75), the person's
 * address placed for a window envelope with nothing confidential in the window (Rz 11), the employer's
 * address, place and date (Rz 12; no signature on a fully automated statement). Drawn with pdf-lib.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { PayrollData } from '../core/modules/schema.js';
import type { Address } from '../invoices/model.js';
import type { LohnausweisData } from './documents.js';
import type { PayrollLanguage } from './model.js';

export interface LohnausweisSheet {
  data: LohnausweisData;
  language: PayrollLanguage;
  person: { name: string; address?: Address; socialSecurityNumber?: string; birthDate?: string };
  firm: { name: string; address?: Address; contact?: { name?: string; phone?: string } };
  boxes: { F?: boolean; G?: boolean };
  remarks?: string;
  /** The place and the day it is issued; the PDF's dates are this day's, so the same statement prints the same bytes. */
  place: string;
  day: string;
  /** A replacement or a correction of an earlier statement: printed above the title. */
  note?: string;
}

const INK = rgb(0.08, 0.08, 0.08);
const MUTED = rgb(0.4, 0.4, 0.4);
/** `s` cut into lines no wider than `width` at `size`, at spaces. */
function wrap(font: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(safe(font, next), size) > width) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

const safe = (font: PDFFont, s: string) => [...s.replace(/ | /g, ' ')].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');

export async function lohnausweisPdf(sheet: LohnausweisSheet, payroll: PayrollData): Promise<Buffer> {
  const form = payroll.lohnausweis;
  if (!form) throw new Error('the jurisdiction has no wage statement');
  const lang = sheet.language;
  const money = (x: number) => new Intl.NumberFormat(`${lang}-CH`, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(x));
  const day = (d: string) => new Intl.DateTimeFormat(`${lang}-CH`, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const L = (l: Record<string, string>) => l[lang] ?? l.de;
  const doc = await PDFDocument.create();
  const at = new Date(`${sheet.day}T12:00:00Z`);
  doc.setCreationDate(at); doc.setModificationDate(at);
  doc.setTitle(`${L(form.title)} ${sheet.data.year}`); doc.setProducer('Vanilla Accounting'); doc.setCreator('Vanilla Accounting');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const left = 48; const right = 547;
  const text = (s: string, x: number, y: number, size = 9, font = regular, color = INK) => page.drawText(safe(font, s), { x, y, size, font, color });
  const rightText = (s: string, x: number, y: number, size = 9, font = regular) => { const t = safe(font, s); page.drawText(t, { x: x - font.widthOfTextAtSize(t, size), y, size, font, color: INK }); };
  const box = (x: number, y: number, on: boolean) => {
    page.drawRectangle({ x, y, width: 8, height: 8, borderColor: INK, borderWidth: 0.6 });
    if (on) text('X', x + 1.5, y + 1.2, 7, bold);
  };
  // A or B: the kind of statement; C: the number and the date of birth; D: the year; E: the days; F and G: the boxes.
  // All on the left; the right is the envelope's window, which shows the address alone (Rz 11).
  let y = 800;
  if (sheet.note) text(sheet.note, left, y + 14, 8, bold, MUTED);
  box(left, y, true); text(`A  ${L(form.title)}`, left + 14, y, 11, bold);
  if (form.letters.B) { y -= 14; box(left, y, false); text(`B  ${L(form.letters.B)}`, left + 14, y, 9, regular, MUTED); }
  y -= 22;
  text(`C  ${L(form.letters.C)}`, left, y, 8, regular, MUTED); text(sheet.person.socialSecurityNumber ?? '', left + 80, y, 9);
  if (sheet.person.birthDate) { y -= 13; text(L(form.letters.born ?? form.letters.C), left + 14, y, 8, regular, MUTED); text(day(sheet.person.birthDate), left + 80, y, 9); }
  y -= 16;
  text(`D  ${L(form.letters.D)}`, left, y, 8, regular, MUTED); text(sheet.data.year, left + 80, y, 9);
  y -= 13;
  text(`E  ${L(form.letters.E)}`, left, y, 8, regular, MUTED);
  if (sheet.data.from && sheet.data.to) text(`${day(sheet.data.from)} – ${day(sheet.data.to)}`, left + 80, y, 9);
  y -= 16;
  box(left, y, !!sheet.boxes.F); text(`F  ${L(form.letters.F)}`, left + 14, y, 8);
  y -= 13;
  box(left, y, !!sheet.boxes.G); text(`G  ${L(form.letters.G)}`, left + 14, y, 8);
  // H: the person's address where a right-hand window envelope shows it (about 45 to 70 mm from the top).
  let hy = 700;
  text(sheet.person.name, 340, hy, 10.5);
  const a = sheet.person.address;
  for (const line of a ? [[a.street, a.number].filter(Boolean).join(' '), [a.postcode, a.town].filter(Boolean).join(' ')] : []) { hy -= 13; if (line.trim()) text(line, 340, hy, 10.5); }

  y = 600;
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.6, color: INK });
  for (const f of form.fields) {
    const strong = !!f.sum;
    text(f.key, left, y, 8.5, strong ? bold : regular, MUTED);
    text(L(f.label), left + 34, y, 8.5, strong ? bold : regular);
    if (f.remark) {
      const said = [sheet.remarks, ...sheet.data.remarks.map((r) => `${r.label} ${money(r.amount)}`)].filter(Boolean).join('; ');
      // Wrapped onto as many lines as it takes: a remark is never cut.
      for (const line of wrap(regular, said, 8, right - left - 34)) { y -= 11; text(line, left + 34, y, 8); }
    } else {
      const v = sheet.data.fields[f.key];
      if (v !== undefined && v !== 0) rightText(`${f.deduction && f.key !== '12' ? '– ' : ''}${money(v)}`, right, y, 9, strong ? bold : regular);
    }
    y -= 15;
    if (strong) page.drawLine({ start: { x: left, y: y + 11 }, end: { x: right, y: y + 11 }, thickness: 0.3, color: MUTED });
  }
  // I: place and date, the employer's exact address, the person responsible and a phone number.
  y -= 10;
  text(`I  ${L(form.letters.I)}: ${[sheet.place, day(sheet.day)].filter(Boolean).join(", ")}`, left, y, 8.5);
  y -= 13;
  const fa = sheet.firm.address;
  text([sheet.firm.name, fa ? [[fa.street, fa.number].filter(Boolean).join(' '), [fa.postcode, fa.town].join(' ')].filter((l) => l.trim()).join(', ') : ''].filter(Boolean).join(', '), left, y, 8.5);
  if (sheet.firm.contact?.name || sheet.firm.contact?.phone) { y -= 12; text([sheet.firm.contact.name, sheet.firm.contact.phone].filter(Boolean).join(', '), left, y, 8.5); }
  text(safe(regular, (payroll.documents.disclaimer[lang] ?? payroll.documents.disclaimer.de).replace('{year}', sheet.data.year)), left, 30, 7, regular, MUTED);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
