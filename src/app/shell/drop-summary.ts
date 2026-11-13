/**
 * What came of a drop, said at its end (#341): the payments its statements brought (how many, from
 * when to when, how many are booked, how many wait and for what) and its receipts (read, linked to
 * a payment or not), and the period most of it landed in. Read from the books the page holds, never
 * stored; pure, so tests run it as it is.
 */
import type { BankTransaction, Index } from '../../types/index.js';
import type { DropRow } from '../../types/drop.js';
import type { Question } from '../../questions/model.js';
import type { Mapping, Receipt } from '../../types/index.js';
import { CORRECTION_LINK } from '../../booking/vat-corrections.js';
import { filingKeyOf, inPeriod, parsePeriod, type FilingLength, type IsoDate, type Period } from '../../accounting/periods.js';
import { waitsForReading } from '../../parsers/receipt-text.js';
import { isNoReceipt } from '../../books/discard.js';
import type { TwinWhy } from '../../types/index.js';

export interface DropSummary {
  /** The payments the drop's statements added to the books. */
  payments?: {
    n: number; from: IsoDate; to: IsoDate; booked: number;
    /** Not booked: held until their receipt comes or can be read (`held`, period-issues.ts receiptWaits). */
    waitReceipt: number;
    /** Not booked: an open question about them waits for an answer. */
    asked: number;
    /** Not booked for any other reason. */
    unbooked: number;
    /** The day of the oldest one not booked: its period holds what is open. */
    openFrom?: IsoDate;
  };
  /**
   * Every file of the drop in exactly one group of the closing lines (#384), as its row says it:
   * the counts add up to the files dropped. Absent while nothing was taken.
   */
  files?: ClosingCounts;
}

/**
 * Where one receipt of a drop is, the one answer its row and the closing sentence both give (#361):
 * linked to a payment; a document beside an invoice (an order confirmation, a delivery note, a
 * customs assessment: evidence, #384, never «kein Beleg»); no receipt at all (Belege's «kein
 * Beleg»); a possible copy of one in the books («schon da?»); waiting for its reading; read with its
 * date and amount, no payment yet; or with its date or amount missing, waiting for the person.
 */
export type ReceiptState = 'matched' | 'supporting' | 'none' | 'copy' | 'unread' | 'read' | 'incomplete';

export function receiptStateOf(r: Receipt, links: number, copy: boolean): ReceiptState {
  if (links > 0) return 'matched';
  if (r.kind === 'supporting') return 'supporting';
  if (isNoReceipt(r, links)) return 'none';
  if (copy) return 'copy';
  if (waitsForReading(r)) return 'unread';
  return r.date && r.amount ? 'read' : 'incomplete';
}

/**
 * What a receipt's links make of it (#406): a provider's fee bill that code linked to the booking of
 * its VAT (src/booking/vat-corrections.ts) has no payment and is said so; any other link is to a payment.
 */
export const linkedAs = (links: readonly Pick<Mapping, 'rule'>[]): 'feeBill' | 'matched' | undefined =>
  !links.length ? undefined : links.every((m) => m.rule === CORRECTION_LINK) ? 'feeBill' : 'matched';

/**
 * Where one taken file is, read from the books and its run: still in its step (said as Belege says
 * it, #218: «Sucht die Zahlung …», «Wartet (3 vor diesem)»), read, matched, waiting for a person,
 * its run stopped, or set aside by the run with the reason.
 */
export type FileState = { kind: 'working'; step?: string } | { kind: 'read' } | { kind: 'unread' } | { kind: 'matched' } | { kind: 'waits' } | { kind: 'orderPage'; provider: string } | { kind: 'feeBill'; provider: string } | { kind: 'stuck'; run: string } | { kind: 'statement' } | { kind: 'report' } | { kind: 'refused'; reason: string }
  | { kind: 'none'; why: string } | { kind: 'twin'; of: string; name: string; why: TwinWhy } | { kind: 'supporting'; why?: string; of?: { id: string; name: string } };

/**
 * The groups of a drop's closing lines (#384). Every row is in exactly one, in its own words: a
 * statement read in, a report booked, a provider's monthly fee bill whose VAT code booked without a
 * payment (#406: no payment, so never «einer Zahlung zugeordnet»), a receipt by its state (receiptStateOf), an order page, a run
 * that stopped, a file the books had already («nicht übernommen: schon da», «schon eingelesen»), one
 * that waits for an answer in its row (columns, a password, «was ist das?», «schon da?»), one set
 * aside or not saved, one taken back, and one still worked on.
 */
export const CLOSING_GROUPS = ['statement', 'report', 'matched', 'feeBill', 'read', 'supporting', 'beside', 'copy', 'incomplete', 'unread', 'orderPage', 'stuck', 'none', 'known', 'asks', 'aside', 'refused', 'undone', 'working'] as const;
export type ClosingGroup = typeof CLOSING_GROUPS[number];
export type ClosingCounts = Record<ClosingGroup, number>;

/** The group of one row: `x`, its FileState when taken (the row's own chip). */
export function closingGroupOf(r: DropRow, x: FileState | undefined): ClosingGroup {
  switch (r.state) {
    case 'take': return 'working';
    case 'undone': return 'undone';
    case 'refused': return 'refused';
    case 'locked': case 'unclear': case 'asks': return 'asks';
    case 'quarantine': return r.reason === 'not-receipt' ? 'none' : 'aside';
    case 'duplicate': return r.reason === 'possible-duplicate' ? 'asks' : 'known';
    case 'taken': break;
  }
  if (r.readAs) return 'known';
  switch (x?.kind ?? 'working') {
    case 'working': return 'working';
    case 'statement': return 'statement';
    case 'report': return 'report';
    case 'refused': return 'refused';
    case 'matched': return 'matched';
    case 'feeBill': return 'feeBill';
    case 'read': return 'read';
    case 'unread': return 'unread';
    case 'waits': return 'incomplete';
    case 'orderPage': return 'orderPage';
    case 'stuck': return 'stuck';
    case 'none': return 'none';
    case 'twin': return 'copy';
    case 'supporting': return x!.kind === 'supporting' && x.of ? 'supporting' : 'beside';
  }
}

/**
 * The receipts a drop read (#385's one «gelesen», `receiptRead`): linked to a payment, or read
 * without one, a possible copy and one that lacks its date or amount among the latter, said apart too.
 */
/**
 * What waits for her when a drop ends (#398): this drop's receipts that wait for her (their date or
 * amount, their reading, a possible copy, a run that stopped), and every open task of the books,
 * counted as the dock counts «Aufgaben» (`waiting`: tasksWaiting), not only this drop's.
 */
export function waitsAfterDrop(states: readonly FileState[], waiting: number): { receipts: number; tasks: number } {
  return { receipts: states.filter((x) => x.kind === 'waits' || x.kind === 'stuck' || x.kind === 'unread' || x.kind === 'twin').length, tasks: waiting };
}

export const readOf = (f: ClosingCounts) => ({ read: f.matched + f.read + f.copy + f.incomplete, matched: f.matched, unmatched: f.read + f.copy + f.incomplete });

/**
 * The closing lines' sentences (#384): the payments line holds the statements, the read line the
 * receipts linked or read (`readOf`); every other group has its sentence, in this order, the
 * receipts' first, then the files that brought nothing new or wait in their row. A record over the
 * groups, so a new group without its sentence does not compile (tests/drop-landed.test.ts).
 */
export const CLOSING_SENTENCE = {
  supporting: 'drop.sum.supporting', beside: 'drop.sum.beside', copy: 'drop.sum.copies', incomplete: 'drop.sum.incomplete', unread: 'drop.sum.unread',
  orderPage: 'drop.sum.orderPages', feeBill: 'drop.sum.feeBills', stuck: 'drop.sum.stuck', report: 'drop.sum.reports',
  none: 'drop.sum.none', known: 'drop.sum.known', asks: 'drop.sum.asks', aside: 'drop.sum.aside', refused: 'drop.sum.refused', undone: 'drop.sum.undone', working: 'drop.sum.working',
} as const satisfies Record<Exclude<ClosingGroup, 'statement' | 'matched' | 'read'>, string>;
/** The receipts' sentences after the read line, and the line of the files that are no receipt or brought nothing new. */
export const RECEIPT_SENTENCES = ['feeBill', 'supporting', 'beside', 'copy', 'incomplete', 'unread', 'orderPage', 'stuck', 'report'] as const;
export const OTHER_SENTENCES = ['none', 'known', 'asks', 'aside', 'refused', 'undone', 'working'] as const;

/** How many rows are in each group: their sum is the number of rows. */
export function closingCounts(rows: readonly DropRow[], groupOf: (r: DropRow) => ClosingGroup): ClosingCounts {
  const counts = Object.fromEntries(CLOSING_GROUPS.map((g) => [g, 0])) as ClosingCounts;
  for (const r of rows) counts[groupOf(r)]++;
  return counts;
}

/**
 * Whether a receipt was read: linked to its payment, or its text read by code or a model (not waiting
 * for its reading). What it lacks (a date, an amount) or that it may be a copy is a state of its own,
 * not «not read». The one «gelesen» of the dock, Automatisierung and the drop (#385 review).
 */
export const receiptRead = (r: Receipt, links: number): boolean => links > 0 || (!isNoReceipt(r, links) && !waitsForReading(r));

/** The dates a taken row put into the books: a statement's payments (its last day while they are not loaded), a receipt's own date. */
export type DatesOf = (r: DropRow) => readonly IsoDate[];

/**
 * A receipt's date when the receipt shows one. The day a phone took a photo (`dateSource:
 * 'captured'`) is no date of the receipt: it must not decide where the page goes.
 */
export const ownDate = (r: { date?: IsoDate; dateSource?: 'captured' } | undefined): IsoDate | undefined => (r?.date && r.dateSource !== 'captured' ? r.date : undefined);

/** `datesOf` for these books; `receiptOf` names the receipt a row became. */
export function datesIn(books: Pick<Index, 'transactions'>, receiptOf: (r: DropRow) => { date?: IsoDate; dateSource?: 'captured' } | undefined): DatesOf {
  const byRef = new Map(books.transactions.map((t) => [t.ref, t.date]));
  return (r) => {
    if (r.statement) {
      const days = r.statement.refs.flatMap((ref) => byRef.get(ref) ?? []);
      return days.length ? days : r.facts?.to ? [r.facts.to] : [];
    }
    if (r.report) return [];
    const d = ownDate(receiptOf(r));
    return d ? [d] : [];
  };
}

/**
 * The filing period that holds most of what the taken rows brought: each payment of a statement and
 * each receipt with a date of its own counts once; of two periods with as many, the later. A date
 * after today counts as today. Undefined while nothing of them is dated.
 */
export function majorityPeriod(rows: readonly DropRow[], datesOf: DatesOf, today: IsoDate, length: FilingLength): Period | undefined {
  const count = new Map<string, number>();
  for (const r of rows) {
    if (r.state !== 'taken') continue;
    for (const d of datesOf(r)) {
      const key = filingKeyOf(d < today ? d : today, length);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  for (const [key, n] of count) if (!best || n > count.get(best)! || (n === count.get(best) && key > best)) best = key;
  return best ? parsePeriod(best, today) ?? undefined : undefined;
}

/**
 * Where a drop's files landed: the period most of them landed in (majorityPeriod), unless the period
 * on screen holds it already. One file dated elsewhere, or a receipt the app could only date by the
 * day it came, does not move the page (#341); before, the newest date among the files decided.
 */
export function landedPeriod(rows: readonly DropRow[], datesOf: DatesOf, current: Period, today: IsoDate, length: FilingLength): Period | undefined {
  const p = majorityPeriod(rows, datesOf, today, length);
  return !p || (inPeriod(current, p.from) && inPeriod(current, p.to)) ? undefined : p;
}

/**
 * The summary of a session's rows. `isUnbooked`: the books' own answer (bank/model.ts); `held`: the
 * payments that wait for their receipt (receiptWaits); `questions`: the open ones; `groupOf`: each
 * row's closing group, from the state its row shows (closingGroupOf).
 */
export function dropSummary(
  rows: readonly DropRow[], books: Pick<Index, 'transactions'>, isUnbooked: (t: BankTransaction) => boolean,
  held: ReadonlySet<string>, questions: readonly Question[], groupOf: (r: DropRow) => ClosingGroup,
): DropSummary {
  const taken = rows.filter((r) => r.state === 'taken');
  const refs = new Set(taken.flatMap((r) => r.statement?.refs ?? []));
  const pays = books.transactions.filter((t) => refs.has(t.ref)).sort((a, b) => a.date.localeCompare(b.date));
  const asked = new Set(questions.filter((q) => q.status === 'open' && q.on.kind === 'payment').map((q) => q.on.id));
  const open = pays.filter(isUnbooked);
  const waitReceipt = open.filter((t) => !asked.has(t.ref) && held.has(t.ref)).length;
  const askedN = open.filter((t) => asked.has(t.ref)).length;
  return {
    ...(pays.length ? { payments: { n: pays.length, from: pays[0].date, to: pays[pays.length - 1].date, booked: pays.length - open.length, waitReceipt, asked: askedN, unbooked: open.length - waitReceipt - askedN, ...(open[0] ? { openFrom: open[0].date } : {}) } } : {}),
    ...(rows.length ? { files: closingCounts(rows, groupOf) } : {}),
  };
}

/**
 * How far a drop's taken files are, 0–100: a file at rest counts whole, one still worked on by the
 * part of its run that is behind it (`doneOf`, 0–1). Before, only files at rest counted, and files
 * that share one run come to rest together: the bar stood, then jumped (#341).
 */
export function dropProgress(doneOf: readonly number[]): number {
  if (!doneOf.length) return 0;
  return Math.round((doneOf.reduce((s, x) => s + Math.min(1, Math.max(0, x)), 0) / doneOf.length) * 100);
}
