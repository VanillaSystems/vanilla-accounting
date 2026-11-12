/**
 * What came of a drop, said at its end (#341): the payments its statements brought (how many, from
 * when to when, how many are booked, how many wait and for what) and its receipts (read, linked to
 * a payment or not), and the period most of it landed in. Read from the books the page holds, never
 * stored; pure, so tests run it as it is.
 */
import type { BankTransaction, Index } from '../../types/index.js';
import type { DropRow } from '../../types/drop.js';
import type { Question } from '../../questions/model.js';
import type { Receipt } from '../../types/index.js';
import { filingKeyOf, inPeriod, parsePeriod, type FilingLength, type IsoDate, type Period } from '../../accounting/periods.js';
import { waitsForReading } from '../../parsers/receipt-text.js';
import { isNoReceipt } from '../../books/discard.js';

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
   * The receipts the drop brought into the books, as their rows and Belege say it (#361): read (its
   * text is there, a PDF's own or the model's), and of those linked to a payment or not; waiting for
   * the model's reading (`waitsForReading`, Belege's «warten aufs Lesen»); and the files the reading
   * found no receipt at all (`isNoReceipt`), set aside and counted apart.
   */
  receipts?: { n: number; read: number; matched: number; unmatched: number; unread: number; none: number };
}

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
 * The summary of a session's taken rows. `isUnbooked`: the books' own answer (bank/model.ts);
 * `held`: the payments that wait for their receipt (receiptWaits); `receiptOf`: the receipt a row
 * became, when the books hold it; `questions`: the open ones.
 */
export function dropSummary(
  rows: readonly DropRow[], books: Pick<Index, 'transactions' | 'mappings'>, isUnbooked: (t: BankTransaction) => boolean,
  held: ReadonlySet<string>, receiptOf: (r: DropRow) => Receipt | undefined, questions: readonly Question[],
): DropSummary {
  const taken = rows.filter((r) => r.state === 'taken');
  const refs = new Set(taken.flatMap((r) => r.statement?.refs ?? []));
  const pays = books.transactions.filter((t) => refs.has(t.ref)).sort((a, b) => a.date.localeCompare(b.date));
  const asked = new Set(questions.filter((q) => q.status === 'open' && q.on.kind === 'payment').map((q) => q.on.id));
  const open = pays.filter(isUnbooked);
  const waitReceipt = open.filter((t) => !asked.has(t.ref) && held.has(t.ref)).length;
  const askedN = open.filter((t) => asked.has(t.ref)).length;
  const files = taken.filter((r) => !r.statement && !r.report).flatMap((r) => receiptOf(r) ?? []);
  const links = (id: string) => books.mappings.filter((m) => m.receiptId === id).length;
  const none = files.filter((r) => isNoReceipt(r, links(r.id))).length;
  const receipts = files.filter((r) => !isNoReceipt(r, links(r.id)));
  const read = receipts.filter((r) => !waitsForReading(r));
  const matched = read.filter((r) => links(r.id) > 0).length;
  return {
    ...(pays.length ? { payments: { n: pays.length, from: pays[0].date, to: pays[pays.length - 1].date, booked: pays.length - open.length, waitReceipt, asked: askedN, unbooked: open.length - waitReceipt - askedN, ...(open[0] ? { openFrom: open[0].date } : {}) } } : {}),
    ...(files.length ? { receipts: { n: receipts.length, read: read.length, matched, unmatched: read.length - matched, unread: receipts.length - read.length, none } } : {}),
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
