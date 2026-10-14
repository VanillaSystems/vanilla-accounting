/**
 * MWST: one VAT return as the mockup shows it, a list of Ziffern and the entries or the sum behind
 * each. Every figure comes from the engine (vat().report, vat().vatLine) and entriesForReturn; this
 * file only arranges them.
 */
import type { Index, JournalEntry, QuarterKey, VatAdjustment } from '../../../types/index.js';
import { entriesForReturn } from '../../../accounting/index.js';
import { addDays, derivePeriod, localToday, parsePeriod, vatPeriodOf, type IsoDate, type Period, isFilingKey } from '../../../accounting/periods.js';
import { vat, filing } from '../../../engines/index.js';
import type { ReturnFigures, VatLine, VatReport } from '../../../engines/return.js';

/** The four parts of the return, as the form groups its Ziffern. */
export const SECTIONS = ['turnover', 'tax', 'input', 'result'] as const;
export type Section = typeof SECTIONS[number];
export const sectionOf = (n: number): Section => (n < 300 ? 'turnover' : n < 400 ? 'tax' : n < 500 ? 'input' : 'result');

/** The derived Ziffern and the ones they are made of; a minus subtracts. */
export const SUMS: Record<string, string[]> = {
  289: ['220', '221', '225', '230', '235', '280'],
  299: ['200', '-289'],
  399: ['302', '303', '312', '313', '342', '343', '382', '383'],
  479: ['400', '405', '410', '-415', '-420'],
  500: ['399', '-479'],
  510: ['479', '-399'],
};

/** The pseudo-Ziffer of a filed quarter's Korrekturabrechnung (form 0535) in the list and the link. */
export const FORM_0535 = '0535';

export interface EntryLine extends VatLine {
  entry: JournalEntry;
}

export type ReturnState =
  | { kind: 'open'; due: IsoDate; overdue: boolean }
  | { kind: 'filed' }
  /** A half year or a year: a sum of returns, no return of its own. */
  | { kind: 'overview' };

export interface VatReturn {
  key: string;
  period: Period;
  state: ReturnState;
  report: VatReport;
  /** The entries behind each source Ziffer, as the report counts them. */
  lines: Record<string, EntryLine[]>;
  adjustments: VatAdjustment[];
  /** Entries booked later in an open quarter that correct this one (`corrects`). */
  corrections: JournalEntry[];
}

/** The return a period shows: its own when it is an ESTV period, else the open quarter's. */
export function vatKeyOf(period: Period, open: Period): string {
  return vatPeriodOf(period, filing().length) ?? open.token;
}

export function vatReturn(books: Index, key: string, today: IsoDate = localToday()): VatReturn {
  const entries = books.journalEntries ?? [];
  const all = books.config?.vatAdjustments ?? [];
  const range = derivePeriod(key)!;
  const closed = books.config?.closedThrough;
  const quarter = isFilingKey(key, filing().length);
  const due = addDays(range.to, filing().dueDays);
  const state: ReturnState = !quarter ? { kind: 'overview' }
    : closed && range.to <= closed ? { kind: 'filed' }
    : { kind: 'open', due, overdue: due < today };
  const lines: Record<string, EntryLine[]> = {};
  for (const entry of entriesForReturn(entries, key, filing().length)) {
    const line = vat().vatLine(entry);
    if (!line) continue;
    for (const z of vat().codes.sourceBoxes(vat().codes.parse(line.code)!)) (lines[z] ??= []).push({ ...line, entry });
  }
  return {
    key,
    period: parsePeriod(key, today)!,
    state,
    report: vat().report(entries, key, all),
    lines,
    adjustments: vat().adjustmentsFor(all, entries, key),
    corrections: quarter ? entries.filter((e) => e.corrects === key) : [],
  };
}

export const amountOf = (v: VatReturn, n: string) => v.report.ziffern.find((z) => z.number === n)?.amount ?? 0;
export const rateOf = (v: VatReturn, n: string): VatReport['rates'][number] | undefined => v.report.rates.find((r) => r.row.ziffer === n);

/** A Ziffer's figure as the filed form holds it: a rate row is its turnover, with the tax for supplies, net for Bezugsteuer. */
export function formAmount(v: VatReturn, n: string): number {
  const r = rateOf(v, n);
  if (!r) return amountOf(v, n);
  return r.row.kind === 'supply' ? Math.round((r.base + r.tax) * 100) / 100 : r.base;
}

/** The filed figure when today's books differ from it by a Rappen or more. */
export function filedDiff(v: VatReturn, filed: ReturnFigures | undefined, n: string): number | undefined {
  const was = filed?.ziffern[n];
  return was != null && Math.abs(was - formAmount(v, n)) >= 0.005 ? was : undefined;
}

/**
 * The Ziffern the list shows, in form order: those with a figure, those filed with one, the sums,
 * 200 always, and the one result that applies (500 or 510). `all` shows every Ziffer.
 */
export function shownZiffern(v: VatReturn, filed: ReturnFigures | undefined, all: boolean): string[] {
  return v.report.ziffern.map((z) => z.number).filter((n) =>
    all || n === '200' || amountOf(v, n) !== 0 || !!filed?.ziffern[n]
    || (n in SUMS && (n === '500' ? v.report.toPay > 0 : n === '510' ? v.report.credit > 0 : true)));
}

/** The result row: Guthaben when the ESTV pays, else the amount to pay. */
export const resultZiffer = (v: VatReturn) => (v.report.credit > 0 ? '510' : '500');

/** A Ziffer's entries grouped by VAT code, the largest group first, each newest first. */
export function byCode(lines: EntryLine[]): Array<[code: string, lines: EntryLine[]]> {
  const m = new Map<string, EntryLine[]>();
  for (const l of lines) m.set(l.code, [...(m.get(l.code) ?? []), l]);
  return [...m].map(([c, ls]) => [c, ls.sort((a, b) => b.date.localeCompare(a.date))] as [string, EntryLine[]])
    .sort((a, b) => b[1].length - a[1].length);
}

/** The quarter a correction entry corrects, as a period for its label. */
export const correctedPeriod = (q: string) => parsePeriod(q, localToday())!;
