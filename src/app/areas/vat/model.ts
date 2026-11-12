/**
 * MWST: one VAT return as the mockup shows it, a list of Ziffern and the entries or the sum behind
 * each. Every figure comes from the engine (vat().report, vat().vatLine) and entriesForReturn; this
 * file only arranges them.
 */
import { lockedThrough } from '../../../books/lock-line.js';
import type { Index, JournalEntry, QuarterKey, VatAdjustment } from '../../../types/index.js';
import { entriesForReturn } from '../../../accounting/index.js';
import { chfAmount } from '../../../accounting/ledger.js';
import { addDays, derivePeriod, localToday, parsePeriod, vatPeriodOf, type IsoDate, type Period, isFilingKey } from '../../../accounting/periods.js';
import { chart, vat, filing, registration } from '../../../engines/index.js';
import { taxOfRow, type ReturnFigures, type VatLine, type VatReport } from '../../../engines/return.js';
import type { BoxId, Formula, ReturnData } from '../../../core/modules/schema.js';

/** The four parts of the return, as the form groups its Ziffern. */
export const SECTIONS = ['turnover', 'tax', 'input', 'result'] as const;
export type Section = typeof SECTIONS[number];
export const sectionOf = (n: number): Section => (n < 300 ? 'turnover' : n < 400 ? 'tax' : n < 500 ? 'input' : 'result');

let sums: { form: unknown; parts: Record<string, string[]> } | undefined;

/** The derived Ziffern of the firm's form and the ones each is made of (from its formula); a minus subtracts. */
export function sumsOf(): Record<string, string[]> {
  const form = vat().form;
  if (sums?.form !== form) {
    const parts = (f: Formula | BoxId): string[] => typeof f === 'string' ? [f]
      : 'sum' in f ? f.sum
        : 'minus' in f ? [f.minus[0], `-${f.minus[1]}`]
          : 'positive' in f ? parts(f.positive)
            : 'signed' in f ? Object.entries(f.signed).map(([z, s]) => (s < 0 ? `-${z}` : z))
              : [...form.rateOrder].sort((a, b) => Number(a) - Number(b));
    sums = { form, parts: Object.fromEntries(Object.entries(form.derived).map(([z, d]) => [z, parts(d.formula)])) };
  }
  return sums.parts;
}

/** The gross turnover a firm not registered for VAT made in a calendar year: what its revenue accounts took in, in the books' currency. */
export function yearTurnover(entries: readonly JournalEntry[], year: string): number {
  let rappen = 0;
  for (const e of entries) {
    if (!e.date.startsWith(year)) continue;
    if (chart().typeOf(e.accountCredit) === 'revenue') rappen += Math.round(chfAmount(e) * 100);
    if (chart().typeOf(e.accountDebit) === 'revenue') rappen -= Math.round(chfAmount(e) * 100);
  }
  return rappen / 100;
}

export type ThresholdLevel = 'ok' | 'near' | 'passed';

/** A calendar year's turnover of a firm not registered for VAT against the registration threshold. */
export interface ThresholdWatch {
  year: string;
  threshold: number;
  turnover: number;
  /** Of the threshold, rounded. */
  percent: number;
  /** The year's turnover at the pace so far: the turnover scaled to the whole year; the turnover itself while the year is young or over. */
  projected: number;
  level: ThresholdLevel;
}

/** The warning starts at this share of the threshold, reached or projected. */
export const NEAR_SHARE = 0.9;
/** A projection needs a quarter of the year behind it: January's pace says nothing about the year. */
const PROJECT_FROM_DAY = 91;

const dayOfYear = (date: string): number => Math.round((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+date.slice(0, 4), 0, 1)) / 86400000) + 1;
const daysOfYear = (year: string): number => dayOfYear(`${year}-12-31`);

/**
 * Where `year`'s turnover stands against the threshold as of `today`: passed from the threshold
 * on; near from NEAR_SHARE of it reached, or projected at the year's pace once PROJECT_FROM_DAY
 * days have passed (r5f-9: 86 % reached in October passes the limit by December). Undefined when
 * the jurisdiction names no threshold.
 */
export function thresholdWatch(entries: readonly JournalEntry[], year: string, today: IsoDate): ThresholdWatch | undefined {
  const threshold = registration()?.turnoverThreshold;
  if (threshold === undefined) return undefined;
  const turnover = yearTurnover(entries, year);
  const elapsed = today < `${year}-01-01` ? 0 : today > `${year}-12-31` ? daysOfYear(year) : dayOfYear(today);
  const projected = elapsed >= PROJECT_FROM_DAY ? Math.round((turnover * daysOfYear(year)) / elapsed * 100) / 100 : turnover;
  const level: ThresholdLevel = turnover >= threshold ? 'passed' : Math.max(turnover, projected) >= threshold * NEAR_SHARE ? 'near' : 'ok';
  return { year, threshold, turnover, percent: Math.round((turnover / threshold) * 100), projected, level };
}

/** The years whose threshold still matters as of `today`: this year, and the one before until its year close (`closedThrough` at its 31.12.). */
export function thresholdYears(today: IsoDate, closedThrough: IsoDate | undefined): string[] {
  const year = today.slice(0, 4);
  const before = String(Number(year) - 1);
  return closedThrough && closedThrough >= `${before}-12-31` ? [year] : [before, year];
}

/** The pseudo-Ziffer of a filed quarter's Korrekturabrechnung (form 0535) in the list and the link. */
export const FORM_0535 = '0535';
/** The pseudo-Ziffer of a return not filed yet: what is still open in its period (`/vat/open`, #341). */
export const OPEN_ITEMS = 'open';

export interface EntryLine extends VatLine {
  entry: JournalEntry;
}

export type ReturnState =
  /** The period has not ended: no return yet, from the day after its end (r6f-33). */
  | { kind: 'running'; ends: IsoDate; from: IsoDate }
  /**
   * `before`: the period ended before anything in these books is dated (#345). The page then says what
   * the books hold («keine Zahlungen oder Buchungen in dieser Periode», and the day they begin, `first`,
   * absent for books with nothing dated), not «fällig seit»: whether its return was filed elsewhere the
   * books cannot know. The return can still be prepared: a firm whose first payment came in April owes a
   * nil return for Q1.
   */
  | { kind: 'open'; due: IsoDate; overdue: boolean; before?: { first?: IsoDate } }
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
  // The books' first dated day: a payment or a booking (books kept by hand have no payments).
  const first = [...books.transactions, ...entries].reduce<IsoDate | undefined>((m, x) => (x.date && (!m || x.date < m) ? x.date : m), undefined);
  const state: ReturnState = !quarter ? { kind: 'overview' }
    : closed && range.to <= closed ? { kind: 'filed' }
    : range.to >= today ? { kind: 'running', ends: range.to, from: addDays(range.to, 1) }
    : { kind: 'open', due, overdue: due < today, ...(!closed && !(first && first <= range.to) ? { before: first ? { first } : {} } : {}) };
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
    report: quarter ? vat().filedReport(entries, key as QuarterKey, all) : vat().report(entries, key, all),
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
    || (n in sumsOf() && (n === '500' ? v.report.toPay > 0 : n === '510' ? v.report.credit > 0 : true)));
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

/** Korrigiert minus filed tax: what the 0535 changes (positive: more to pay). */
export function correctionDiff(books: Index, filed: ReturnFigures): number {
  const corrected = vat().figures(books.journalEntries ?? [], filed.period, books.config?.vatAdjustments ?? []);
  return Math.round((corrected.payable - ((filed.ziffern['500'] ?? 0) - (filed.ziffern['510'] ?? 0))) * 100) / 100;
}

/**
 * The figure the page leads with: for a filed period the filed one, as the authority has it, with
 * today's books' figure beside it when a correction changed it (r6f-26); else today's figure.
 */
export function headline(v: VatReturn, filed: ReturnFigures | undefined, books: Index): { kind: 'toPay' | 'credit'; amount: number; filed: boolean; corrected?: { kind: 'toPay' | 'credit'; amount: number; diff: number }; rounding?: { ziffern: number } } {
  if (v.state.kind !== 'filed' || !filed) {
    // The figure the return will carry (the approval card's and the XML's): the tax on each rate's total, as the authority computes it (r9c-13).
    // The Ziffern below sum the entries' tax; when a Rappen differs, the page says so instead of showing two figures.
    const payable = isFilingKey(v.key, filing().length) ? vat().figures(books.journalEntries ?? [], v.key as QuarterKey, v.adjustments).payable : v.report.toPay - v.report.credit;
    const ziffern = Math.round((v.report.toPay - v.report.credit) * 100) / 100;
    return { kind: payable < 0 ? 'credit' : 'toPay', amount: Math.abs(payable), filed: false, ...(Math.round(payable * 100) !== Math.round(ziffern * 100) ? { rounding: { ziffern: Math.abs(ziffern) } } : {}) };
  }
  const payable = Math.round((((filed.ziffern['500'] ?? 0) - (filed.ziffern['510'] ?? 0)) * 100)) / 100;
  const diff = correctionDiff(books, filed);
  const now = Math.round((payable + diff) * 100) / 100;
  return {
    kind: payable < 0 ? 'credit' : 'toPay', amount: Math.abs(payable), filed: true,
    ...(diff !== 0 ? { corrected: { kind: now < 0 ? 'credit' : 'toPay', amount: Math.abs(now), diff } } : {}),
  };
}

/**
 * The boxes of the firm's correction form, from its return form: its turnover box and deduction
 * boxes, its input-tax boxes (none on the net tax rate method, whose section is left out, r6f-26)
 * and the derived totals it has. 205 (opted exempt supplies within 200) is a box of the effective
 * form the module does not model: it is listed and shown with a figure only.
 */
export function correctionBoxes(form: ReturnData): { turnover: string[]; turnoverTotals: string[]; taxTotals: string[]; inputTax: string[]; inputTaxTotals: string[]; settlement: string[]; otherFlows: string[] } {
  const derived = (...ns: string[]) => ns.filter((n) => form.derived[n]);
  return {
    turnover: [form.turnoverBox, '205', ...Object.keys(form.deductions)], turnoverTotals: derived('289', '299'),
    taxTotals: derived('399'),
    inputTax: Object.keys(form.inputTax), inputTaxTotals: derived('479'),
    settlement: derived('500', '510'),
    otherFlows: ['900', '910'],
  };
}

/**
 * True when the rate rows' taxes, each rounded, add up to a Rappen more or less than the rounded total
 * (src/engines/return.ts: the return rounds the total of the unrounded rows once). A period that files
 * nothing (a half year, a year) rounds nothing.
 */
export function ratesRoundedApart(v: VatReturn): boolean {
  if (v.state.kind === 'overview') return false;
  const taxes = v.report.rates.map((r) => taxOfRow(r.row, formAmount(v, r.row.ziffer)) * 100);
  return Math.round(taxes.reduce((s, x) => s + x, 0)) !== taxes.reduce((s, x) => s + Math.round(x), 0);
}

/** A return that is still worked on: its period ended or runs, and nothing of it is filed. */
export const notFiled = (v: VatReturn) => v.state.kind === 'open' || v.state.kind === 'running';

/**
 * Its figure is not final (#341): the return is still worked on, something of its period is open
 * (`open`: the count of periodIssues), and it is not approved. An approved return waits to be filed
 * with its books locked (lockedThrough): its figure stands, and so does what to do with it.
 */
export function isPending(v: VatReturn, books: Index, open: number): boolean {
  const locked = lockedThrough(books.config);
  return notFiled(v) && open > 0 && !(locked && locked >= v.period.to);
}

/**
 * The sentence under the result (Ziffer 500 or 510), as its key; undefined where the result's own
 * sentence stands (an amount that is final: transfer it, or it is paid back). Not final comes
 * first: a result of 0.00 while payments of the period are not booked is no «nothing owed». A
 * final zero says there is nothing to transfer, and for a period that ended, that its return is
 * still to be filed (#341).
 */
export function resultSentence(n: '500' | '510', amount: number, pending: boolean, state: VatReturn['state']['kind'], netRate: boolean): 'vat.xZeroPending' | 'vat.x510Pending' | 'vat.x500NetRatePending' | 'vat.x500Pending' | 'vat.x510None' | 'vat.x500NoneFile' | 'vat.x500None' | undefined {
  if (pending) return !amount ? 'vat.xZeroPending' : n === '510' ? 'vat.x510Pending' : netRate ? 'vat.x500NetRatePending' : 'vat.x500Pending';
  if (!amount) return n === '510' ? 'vat.x510None' : state === 'open' ? 'vat.x500NoneFile' : 'vat.x500None';
  return undefined;
}
