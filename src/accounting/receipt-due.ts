/**
 * When a payment that waits for its receipt (BankTransaction.waitsForReceipt, issue #29) becomes
 * the person's: a fixed number of days before its filing period's return is due. Until then the
 * waiting is the app's work; from then on the person is asked, with the ways out (find the
 * receipt, or book without input tax). Pure, so the screens and the books read the same days.
 */
import { filing } from '../engines/index.js';
import { addDays, derivePeriod, filingKeyOf, type IsoDate } from './periods.js';
import type { BankTransaction, Index } from '../types/index.js';

/**
 * Two weeks before the return is due: time to find a receipt or ask the supplier for one, and
 * still a few days to review and file the return after the last answer.
 */
export const ASK_DAYS_BEFORE_DUE = 14;

/** The day the return of the payment's filing period is due, and the day from which the person is asked about the missing receipt. */
export function receiptDue(date: IsoDate): { due: IsoDate; askFrom: IsoDate } {
  const { length, dueDays } = filing();
  const due = addDays(derivePeriod(filingKeyOf(date, length))!.to, dueDays);
  return { due, askFrom: addDays(due, -ASK_DAYS_BEFORE_DUE) };
}

/**
 * Where a payment the app holds for its receipt stands today: `waits` (the app's work, no one is
 * asked) or `asks` (the person's, from askFrom on). Undefined when it does not wait: never held,
 * booked meanwhile, or a receipt is linked now (the next run books it).
 */
export function receiptState(tx: Pick<BankTransaction, 'date' | 'waitsForReceipt'>, linked: boolean, booked: boolean, today: IsoDate): { kind: 'waits' | 'asks'; due: IsoDate; askFrom: IsoDate } | undefined {
  if (!tx.waitsForReceipt || linked || booked) return undefined;
  const days = receiptDue(tx.date);
  return { kind: today >= days.askFrom ? 'asks' : 'waits', ...days };
}

/** A payment the app holds for its receipt, where it stands today (receiptState). */
export interface WaitingPayment { tx: BankTransaction; kind: 'waits' | 'asks'; due: IsoDate; askFrom: IsoDate }

/** The open payments that wait for their receipt, oldest first; `isBooked` says whether the books hold its whole booking. */
export function waitingForReceipt(books: Pick<Index, 'transactions' | 'mappings' | 'receipts' | 'config'>, isBooked: (ref: string) => boolean, today: IsoDate): WaitingPayment[] {
  const closed = books.config?.closedThrough;
  const duplicates = new Set(books.receipts.filter((r) => r.kind === 'duplicate').map((r) => r.id));
  const linked = new Set(books.mappings.filter((m) => !duplicates.has(m.receiptId)).map((m) => m.transactionRef));
  return books.transactions
    .filter((tx) => tx.waitsForReceipt && !(closed && tx.date <= closed))
    .flatMap((tx) => { const s = receiptState(tx, linked.has(tx.ref), isBooked(tx.ref), today); return s ? [{ tx, ...s }] : []; })
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.ref.localeCompare(b.tx.ref));
}
