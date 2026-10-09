import type { JournalEntry, VatAdjustment } from '../types/index.js';
import { derivePeriod } from './periods.js';
import { entriesForReturn, reportRange } from './declarations.js';
import { toRappen, fromRappen } from './rappen.js';
import { chfAmount } from './ledger.js';
import { INPUT_TAX, SWISS_VAT_RATES, TAX_RATE_ROWS, TURNOVER_DEDUCTIONS, VARIOUS_DEDUCTION, rateLabel, type TaxRateRow } from './ziffern.js';

export interface VatReportZiffer {
  number: string;
  label: string;
  amount: number;
}

/** A tax-rate row of section II: its net turnover and the tax on it, summed per entry. */
export interface VatReportRate {
  row: TaxRateRow;
  base: number;
  tax: number;
}

export interface VatReport {
  ziffern: VatReportZiffer[];
  rates: VatReportRate[];
  toPay: number;
  credit: number;
}

export interface VatCodeInfo {
  code: string;
  rate: number;
  isNegative: boolean;
  revenueZiffer?: string;
  deductionZiffer?: string;
  inputTaxZiffer?: string;
  correctionZiffer?: string;
  acquisitionZiffer?: string;
  /**
   * What the entry's amount is. Banana's suffix on an input-tax code: none =
   * gross (VAT included), `-1` = net (VAT excluded), `-2` = the VAT amount
   * itself (single-leg corrections, docs/runbooks/booking-patterns.md).
   */
  amountIs: 'gross' | 'net' | 'tax';
}

export function parseVatCode(code: string): VatCodeInfo | null {
  if (!code) return null;

  const isNegative = code.startsWith('-');
  const unsigned = isNegative ? code.slice(1) : code;
  // Input-tax and Bezugsteuer codes may carry Banana's amount-type suffix; the rest of the code is unchanged.
  const suffix = /^[MIB]\d+-([12])$/.exec(unsigned)?.[1];
  const amountIs: VatCodeInfo['amountIs'] = suffix === '2' ? 'tax' : suffix === '1' ? 'net' : 'gross';
  const clean = suffix ? unsigned.slice(0, -2) : unsigned;
  const info = parseCleanCode(code, clean, isNegative);
  return info ? { ...info, amountIs } : null;
}

const rateCode = (rate: number) => String(Math.round(rate * 10));

/** Every code with a fixed Ziffer, built from the Ziffer model (src/accounting/ziffern.ts). */
const CODES = new Map<string, Omit<VatCodeInfo, 'code' | 'isNegative' | 'amountIs'>>([
  ...TAX_RATE_ROWS.map((row) => [row.vatCode, row.kind === 'supply'
    ? { rate: row.rate, revenueZiffer: row.ziffer }
    // Bezugsteuer (MWSTG Art. 45): owed in 382/383 and, for a business use, deductible again as
    // input tax in the same return (Art. 28 Abs. 1 lit. b), so one entry feeds both Ziffern.
    : { rate: row.rate, acquisitionZiffer: row.ziffer, inputTaxZiffer: '405' }] as const),
  ...[...TURNOVER_DEDUCTIONS.map(([ziffer, , , vatCode]) => ({ ziffer, vatCode })), VARIOUS_DEDUCTION]
    .flatMap(({ ziffer, vatCode }) => (vatCode ? [[vatCode, { rate: 0, deductionZiffer: ziffer }] as const] : [])),
  // Input tax: M = material and services (400), I = investments and other operating expense (405).
  ...[['M', '400'], ['I', '405']].flatMap(([letter, z]) => [
    [`${letter}0`, { rate: 0 }] as const,
    ...[...SWISS_VAT_RATES].map((rate) => [`${letter}${rateCode(rate)}`, { rate, inputTaxZiffer: z }] as const),
  ]),
]);

/** Corrections (K81-B = 8.1% into 415). The rate is encoded as rate×10, like I81/M81. */
const CORRECTION_ZIFFER: Record<string, string> = { A: '410', B: '415', C: '420' };

function parseCleanCode(code: string, clean: string, isNegative: boolean): Omit<VatCodeInfo, 'amountIs'> | null {
  const fixed = CODES.get(clean);
  if (fixed) return { code, isNegative, ...fixed };
  const k = /^K(\d*)-([ABC])$/.exec(clean);
  if (k) return { code, rate: (parseFloat(k[1]) || 0) / 10, isNegative, correctionZiffer: CORRECTION_ZIFFER[k[2]] };
  return null;
}

/**
 * The tax in an entry's amount, in rappen. The amount is gross unless the
 * code's suffix says it is net (-1) or the tax itself (-2).
 */
function extractTax(amountRappen: number, info: VatCodeInfo): number {
  if (info.rate === 0) return 0;
  if (info.amountIs === 'tax') return amountRappen;
  if (info.amountIs === 'net') return Math.round(amountRappen * info.rate / 100);
  return amountRappen - Math.round(amountRappen * 100 / (100 + info.rate));
}

/** The taxable base (net) in an entry's amount, in rappen. */
function extractTaxableBase(amountRappen: number, info: VatCodeInfo): number {
  if (info.rate === 0) return amountRappen;
  if (info.amountIs === 'tax') return Math.round(amountRappen * 100 / info.rate);
  if (info.amountIs === 'net') return amountRappen;
  return Math.round(amountRappen * 100 / (100 + info.rate));
}

/** One journal entry's contribution to a Ziffer, for the audit-trail / breakdown report. */
export interface VatLine {
  date: string;
  ref: string;
  description: string;
  code: string;
  gross: number; // signed CHF gross (VAT-inclusive)
  base: number;  // signed CHF taxable base (net)
  tax: number;   // signed CHF tax amount
}

/** An entry's VAT amounts, signed as they count in the return, or null when its code declares nothing. */
export function vatLine(entry: JournalEntry): VatLine | null {
  const info = entry.vatCode ? parseVatCode(entry.vatCode) : null;
  if (!info) return null;
  const grossRappen = toRappen(chfAmount(entry));
  const sign = info.isNegative ? -1 : 1;
  return {
    date: entry.date,
    ref: entry.transactionRef,
    description: entry.description ?? '',
    code: info.code,
    gross: fromRappen(grossRappen * sign),
    base: fromRappen(extractTaxableBase(grossRappen, info) * sign),
    tax: fromRappen(extractTax(grossRappen, info) * sign),
  };
}

/**
 * The declaration adjustments a report counts. An adjustment declares, in a later
 * return, the tax of entries from an earlier (filed) period. A report whose entries
 * already contain those entries counts them, so the adjustment is skipped there:
 * otherwise a year view would count the same tax twice.
 */
export function adjustmentsForReturn(adjustments: VatAdjustment[], entries: JournalEntry[], periodKey: string): VatAdjustment[] {
  const { from, to } = reportRange(periodKey);
  const declared = new Set(entriesForReturn(entries, periodKey).map((e) => e.id));
  return adjustments.filter((a) => {
    const p = derivePeriod(a.period);
    if (!p) throw new Error(`vatAdjustments ${a.id}: unknown period "${a.period}"`);
    if (p.from < from || p.to > to) return false;
    const inside = a.entryIds.filter((id) => declared.has(id)).length;
    if (inside === 0) return true;
    if (inside === a.entryIds.length) return false;
    throw new Error(`vatAdjustments ${a.id}: the report ${periodKey} contains only some of its entries`);
  });
}

/** The entries a report declares, grouped by each source Ziffer they feed. */
function entryLines(entries: JournalEntry[], periodKey: string, out: Record<string, VatLine[]> = {}): Record<string, VatLine[]> {
  const push = (z: string, line: VatLine) => { (out[z] ??= []).push(line); };
  for (const entry of entriesForReturn(entries, periodKey)) {
    const line = vatLine(entry);
    if (!line) continue;
    for (const z of sourceZiffern(parseVatCode(line.code)!)) push(z, line);
  }
  return out;
}

/** The source Ziffern an entry with this code feeds. A Bezugsteuer code feeds two (383 and 405). */
export function sourceZiffern(info: VatCodeInfo): string[] {
  return [
    info.revenueZiffer || info.deductionZiffer ? '200' : undefined,
    info.revenueZiffer,
    info.deductionZiffer,
    info.rate > 0 ? info.inputTaxZiffer : undefined,
    info.correctionZiffer,
    info.acquisitionZiffer,
  ].filter((z): z is string => !!z);
}

/**
 * The journal entries (and declaration adjustments) that make up each *source* Ziffer
 * (200/220/303/400/405/415/…) of computeVatReport(). Derived totals (289/299/399/479/…)
 * are computed from these, so they carry no lines. Lets a report show how each form
 * number is composed, transaction by transaction.
 */
export function computeVatReportLines(
  entries: JournalEntry[],
  periodKey: string,
  adjustments: VatAdjustment[],
): Record<string, VatLine[]> {
  const out: Record<string, VatLine[]> = {};
  for (const a of adjustmentsForReturn(adjustments, entries, periodKey)) {
    (out[a.ziffer] ??= []).push({ date: derivePeriod(a.period)!.to, ref: `adjustment:${a.id}`, description: a.reason, code: 'Nachdeklaration', gross: 0, base: 0, tax: a.amount });
  }
  return entryLines(entries, periodKey, out);
}

/**
 * The return for any report key (quarter, half year, year), with the tax summed per entry.
 * `npm run vat-xml` files the eCH way instead (figuresFromBooks): tax on each rate's total,
 * which can differ by a Rappen; the XML is authoritative.
 *
 * A supply row's amount (303, 313, …) is its net turnover, a Bezugsteuer row's (382, 383)
 * its tax; `rates` has both figures for every rate row.
 */
export function computeVatReport(
  entries: JournalEntry[],
  periodKey: string,
  adjustments: VatAdjustment[],
): VatReport {
  const lines = entryLines(entries, periodKey);
  const adjusted: Record<string, number> = {};
  for (const a of adjustmentsForReturn(adjustments, entries, periodKey)) adjusted[a.ziffer] = (adjusted[a.ziffer] ?? 0) + toRappen(a.amount);
  /** A Ziffer's figure in rappen. An adjustment declares an amount of whatever the Ziffer holds. */
  const sum = (z: string, field: 'gross' | 'base' | 'tax') =>
    (lines[z] ?? []).reduce((s, l) => s + toRappen(l[field]), 0) + (field === 'base' ? 0 : adjusted[z] ?? 0);

  const rates = TAX_RATE_ROWS.map((row) => ({ row, base: sum(row.ziffer, 'base'), tax: sum(row.ziffer, 'tax') }));
  const deductions = [...TURNOVER_DEDUCTIONS.map(([ziffer, , label]) => ({ ziffer, label })), VARIOUS_DEDUCTION]
    .map(({ ziffer, label }) => ({ number: ziffer, label, amount: sum(ziffer, 'gross') }));
  const inputTax = INPUT_TAX.map(([ziffer, , label, sign]) => ({ number: ziffer, label, sign, amount: sum(ziffer, 'tax') }));

  const z200 = (lines['200'] ?? []).reduce((s, l) => s + toRappen(l.gross), 0);
  const z289 = deductions.reduce((s, d) => s + d.amount, 0);
  const z399 = rates.reduce((s, r) => s + r.tax, 0);
  const z479 = inputTax.reduce((s, i) => s + i.sign * i.amount, 0);
  const z500 = Math.max(0, z399 - z479);
  const z510 = Math.max(0, z479 - z399);

  const ziffern = [
    { number: '200', label: 'Gesamtumsatz', amount: z200 },
    ...deductions,
    { number: '289', label: 'Total Abzüge', amount: z289 },
    { number: '299', label: 'Steuerbarer Umsatz', amount: z200 - z289 },
    ...rates.map((r) => ({ number: r.row.ziffer, label: rateLabel(r.row), amount: r.row.kind === 'supply' ? r.base : r.tax })),
    { number: '399', label: 'Total geschuldete Steuer', amount: z399 },
    ...inputTax.map(({ number, label, amount }) => ({ number, label, amount })),
    { number: '479', label: 'Total Vorsteuer', amount: z479 },
    { number: '500', label: 'Zu bezahlender Betrag', amount: z500 },
    { number: '510', label: 'Guthaben', amount: z510 },
  ].sort((a, b) => Number(a.number) - Number(b.number))
    .map((z): VatReportZiffer => ({ ...z, amount: fromRappen(z.amount) }));

  return {
    ziffern,
    rates: rates.map((r) => ({ row: r.row, base: fromRappen(r.base), tax: fromRappen(r.tax) })),
    toPay: fromRappen(z500),
    credit: fromRappen(z510),
  };
}
