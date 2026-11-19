/**
 * The payslip as a PDF (docs/specs/payroll.md §5.6, OR Art. 323b): the firm, the person's address for a
 * window envelope, the month, every line with base × rate = amount in its group, the totals and the
 * payout's account, the employer's contributions for information, and the disclaimer in small print.
 * Drawn with pdf-lib and a standard font, so it needs no browser and the same payslip gives the same
 * bytes (its dates are the close's). Every word comes from the module's `documents` and the Lohnart
 * labels in the person's language.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PayrollData } from '../core/modules/schema.js';
import type { Address } from '../invoices/model.js';
import { ratePercent, rateShown, type WageType } from './catalogue.js';
import type { PayrollLanguage, PayslipLine } from './model.js';

export interface PayslipSheet {
  month: string;
  payday: string;
  language: PayrollLanguage;
  lines: readonly PayslipLine[];
  gross: number; deductions: number; net: number; payout: number; employer: number;
  person: { name: string; address?: Address; iban?: string };
  firm: { name: string; address?: Address };
  /** Printed on the payslip only (AHVG Art. 153c: its use for social insurance); never in a file name or password. */
  socialSecurityNumber?: string;
  text?: string;
  /** Per line (same order as `lines`), where its rate comes from in the person's language (src/payroll/sources.ts); undefined: nothing printed. */
  sources?: ReadonlyArray<string | undefined>;
  /** The holiday balance in days at the month's end (B1), where the holidays are taken. */
  holidays?: { earned: number; taken: number; balance: number };
  /** The time the PDF names as made: the close's, so the same payslip prints the same bytes. */
  at: string;
}

const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);

const locale = (lang: PayrollLanguage) => `${lang}-CH`;
const money = (lang: PayrollLanguage, x: number) => new Intl.NumberFormat(locale(lang), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
const num = (lang: PayrollLanguage, x: number) => new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 4 }).format(x);
/** A rate in percent as the page shows it: two decimals at least («0.90 %», §22 decision 122). */
const pct2 = (lang: PayrollLanguage, x: number) => new Intl.NumberFormat(locale(lang), { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(x);
const dayText = (lang: PayrollLanguage, day: string) => new Intl.DateTimeFormat(locale(lang), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const monthText = (lang: PayrollLanguage, month: string) => new Intl.DateTimeFormat(locale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

/** Characters the standard font cannot draw are replaced, never left to throw (a name in another script). */
const safe = (font: PDFFont, s: string): string => [...s.replace(/ | /g, ' ')].map((ch) => {
  try { font.encodeText(ch); return ch; } catch { return '?'; }
}).join('');

export async function payslipPdf(sheet: PayslipSheet, data: PayrollData, types: ReadonlyMap<string, WageType>): Promise<Buffer> {
  const lang = sheet.language;
  const words = (k: keyof PayrollData['documents']) => data.documents[k][lang] ?? data.documents[k].de;
  const doc = await PDFDocument.create();
  const at = new Date(sheet.at);
  doc.setCreationDate(at); doc.setModificationDate(at);
  doc.setTitle(`${words('payslip')} ${sheet.month}`); doc.setProducer('Vanilla Accounting'); doc.setCreator('Vanilla Accounting');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - 56;
  const left = 56; const right = A4[0] - 56;
  const text = (s: string, x: number, size = 9.5, font = regular, color = INK) => page.drawText(safe(font, s), { x, y, size, font, color });
  const rightText = (s: string, x: number, size = 9.5, font = regular, color = INK) => {
    const t = safe(font, s);
    page.drawText(t, { x: x - font.widthOfTextAtSize(t, size), y, size, font, color });
  };
  const next = (dy = 13) => {
    y -= dy;
    if (y < 72) { page = doc.addPage(A4); y = A4[1] - 56; }
  };
  const addressLines = (a?: Address) => (a ? [[a.street, a.number].filter(Boolean).join(' '), [a.postcode, a.town].filter(Boolean).join(' ')].filter((l) => l.trim()) : []);

  // The firm, top left; the person's address in the window on the right (Form 11 Rz 11 likewise).
  text(sheet.firm.name, left, 10, bold);
  const firmLines = addressLines(sheet.firm.address);
  firmLines.forEach((l) => { next(12); text(l, left, 9, regular, MUTED); });
  y = A4[1] - 140;
  text(sheet.person.name, 330, 10.5);
  for (const l of addressLines(sheet.person.address)) { next(13); text(l, 330, 10.5); }
  y = A4[1] - 230;
  text(`${words('payslip')} ${monthText(lang, sheet.month)}`, left, 14, bold);
  next(16);
  text(`${words('payday')}: ${dayText(lang, sheet.payday)}${sheet.socialSecurityNumber ? `   ${words('socialSecurityNumber')} ${sheet.socialSecurityNumber}` : ''}`, left, 9, regular, MUTED);
  next(22);

  const colBase = 360; const colRate = 430; const colAmount = right;
  const header = () => {
    rightText(words('base'), colBase, 8, bold, MUTED); rightText(words('rate'), colRate, 8, bold, MUTED); rightText(words('amount'), colAmount, 8, bold, MUTED);
    next(4);
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: MUTED });
    next(12);
  };
  header();
  /** A line's source in small print under it, where it has one. */
  const sourceOf = (l: PayslipLine) => sheet.sources?.[sheet.lines.indexOf(l)];
  const sourceRow = (l: PayslipLine) => {
    const s = sourceOf(l);
    if (!s) return;
    y += 3;
    text(s, left + 8, 7, regular, MUTED);
    next(10);
  };
  const row = (l: PayslipLine) => {
    const w = types.get(l.wageType);
    const minus = w?.sign === '-' && w.stage !== 'employer';
    const label = l.corrects ? `${words('correction')} ${monthText(lang, l.corrects.slice(0, 7))}: ${l.label}` : l.label;
    text(l.text ? `${label} (${l.text})` : label, left, 9.5);
    if (l.quantity !== undefined && l.rate !== undefined && l.base === undefined) {
      // A rate in percent (a car's 0.9 % a month) prints as such; the line computed with the fraction.
      rightText(num(lang, l.quantity), colBase, 9.5); rightText(ratePercent(w) ? `${pct2(lang, rateShown(w, l.rate))} %` : num(lang, l.rate), colRate, 9.5);
    } else {
      if (l.base !== undefined) rightText(money(lang, l.base), colBase, 9.5);
      if (l.rate !== undefined) rightText(`${num(lang, l.rate)} %`, colRate, 9.5);
    }
    rightText(money(lang, minus ? -l.amount : l.amount), colAmount, 9.5);
    next();
    sourceRow(l);
  };
  const total = (label: string, amount: number, strong = false) => {
    page.drawLine({ start: { x: colBase - 60, y: y + 9 }, end: { x: right, y: y + 9 }, thickness: 0.4, color: MUTED });
    text(label, left, 9.5, strong ? bold : regular);
    rightText(money(lang, amount), colAmount, 9.5, strong ? bold : regular);
    next(16);
  };
  const ofStage = (stage: WageType['stage']) => sheet.lines.filter((l) => types.get(l.wageType)?.stage === stage);
  ofStage('gross').forEach(row);
  total(data.totals.gross[lang], sheet.gross, true);
  ofStage('deduction').forEach(row);
  total(data.totals.net[lang], sheet.net, true);
  const after = ofStage('after');
  if (after.length) {
    after.forEach(row);
  }
  const noCash = ofStage('gross').filter((l) => types.get(l.wageType)?.cash === false);
  for (const l of noCash) {
    text(l.label, left, 9.5); rightText(money(lang, -l.amount), colAmount, 9.5); next();
  }
  total(data.totals.payout[lang], sheet.payout, true);
  if (sheet.person.iban) { text(`${words('payTo')} ${sheet.person.iban}`, left, 9, regular, MUTED); next(18); }
  if (sheet.text) { text(sheet.text, left, 9.5); next(18); }
  if (sheet.holidays) {
    const h = sheet.holidays;
    text(words('holidays').replace('{balance}', num(lang, h.balance)).replace('{earned}', num(lang, h.earned)).replace('{taken}', num(lang, h.taken)), left, 9, regular, MUTED);
    next(18);
  }

  const employer = ofStage('employer');
  if (employer.length) {
    next(6);
    text(words('employer'), left, 9, bold, MUTED); next(14);
    for (const l of employer) {
      text(l.corrects ? `${words('correction')}: ${l.label}` : l.label, left, 8.5, regular, MUTED);
      if (l.base !== undefined) rightText(money(lang, l.base), colBase, 8.5, regular, MUTED);
      if (l.rate !== undefined) rightText(`${num(lang, l.rate)} %`, colRate, 8.5, regular, MUTED);
      // An employer line that deducts (the commission on the tax at source) prints its minus.
      rightText(money(lang, types.get(l.wageType)?.sign === '-' ? -l.amount : l.amount), colAmount, 8.5, regular, MUTED);
      next(12);
      sourceRow(l);
    }
    total(data.totals.employer[lang], sheet.employer);
  }
  for (const p of doc.getPages()) p.drawText(safe(regular, words('disclaimer').replace('{year}', sheet.month.slice(0, 4))), { x: left, y: 36, size: 7, font: regular, color: MUTED });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
