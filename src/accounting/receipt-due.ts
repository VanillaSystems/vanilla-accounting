/**
 * When a payment that waits for its receipt (BankTransaction.waitsForReceipt, issue #29) becomes
 * the person's: a fixed number of days before its filing period's return is due. Until then the
 * waiting is the app's work; from then on the person is asked, with the ways out (find the
 * receipt, or book without input tax). Pure, so the screens and the books read the same days.
 */
import { baseCurrency, filing } from '../engines/index.js';
import { creditSigned } from './credit-signed.js';
import { addDays, derivePeriod, filingKeyOf, type IsoDate } from './periods.js';
import type { BankTransaction, Index, Receipt } from '../types/index.js';
import { isPurchaseDocument } from './evidence-check.js';

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
 * A receipt whose VAT the app tried to read and could not (issue #57): a scan too poor for its text
 * (needsVisionReview), or a reading that named no Swiss VAT either way. A person's facts are read.
 * Only a purchase document counts: a copy or a sales record decides no input tax.
 */
export function isUnreadable(r: Pick<Receipt, 'kind' | 'vatBy' | 'hasSwissVat' | 'vatSummary' | 'needsVisionReview' | 'vatExtractedAt'>): boolean {
  return isPurchaseDocument(r) && r.vatBy !== 'human' && r.hasSwissVat === undefined && !r.vatSummary?.length && (!!r.needsVisionReview || !!r.vatExtractedAt);
}

/**
 * What the receipts linked to a payment say: none, at least one readable, only purchase documents
 * whose VAT could not be read, or (`short`, given the payment `tx`) part of a set: two or more
 * receipts in the payment's currency that add up to less than it paid out, by more than a
 * centime per receipt. A set short of receipts waits for the rest like a payment without any: the
 * model would book the part they prove, which the payment's balance refuses, or the whole on
 * part of the proof.
 */
export type Linked = 'none' | 'read' | 'unread' | 'short';

export function linkedOf(receipts: readonly Receipt[], tx?: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>): Linked {
  const purchase = receipts.filter(isPurchaseDocument);
  if (!receipts.length) return 'none';
  if (purchase.length && purchase.every(isUnreadable)) return 'unread';
  return tx && shortOf(purchase, tx) ? 'short' : 'read';
}

const cents = (n: number) => Math.round(n * 100);

/**
 * What the payment `tx` paid out less what a set of its purchase receipts adds up to, in cents: two
 * or more receipts, each with an amount in the payment's currency (a credit note counts below
 * zero). Undefined for money in, a single receipt (it may cover several payments: instalments, a
 * part payment), or a receipt in another currency (comparable only at a rate).
 */
function gapOf(purchase: readonly Receipt[], tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>): number | undefined {
  if (tx.direction !== 'DBIT' || purchase.length < 2) return undefined;
  let owed = 0;
  for (const r of purchase) {
    const amount = creditSigned(r);
    if (amount === undefined || (r.currency ?? baseCurrency()) !== tx.currency) return undefined;
    owed += cents(amount);
  }
  return cents(Math.abs(tx.amount)) - owed;
}

function shortOf(purchase: readonly Receipt[], tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>): boolean {
  return (gapOf(purchase, tx) ?? 0) > purchase.length;
}

/**
 * How much a set of receipts linked to the payment `tx` adds up to beyond it, in its currency, by
 * more than a centime per receipt: one of them belongs to another payment. Undefined when the set
 * is not beyond it, or not comparable (gapOf). Code and the model link no receipt that makes a set
 * so (excessOfPayment); a person may, and the payment shows the excess as a fact.
 */
export function excessOf(receipts: readonly Receipt[], tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>): number | undefined {
  const purchase = receipts.filter(isPurchaseDocument);
  const gap = gapOf(purchase, tx);
  return gap !== undefined && -gap > purchase.length ? -gap / 100 : undefined;
}

/**
 * excessOf of the receipts linked to payment `ref`, with receipt `adding` as if linked too.
 * Undefined when a receipt of the set is linked to another payment as well (a card charge split
 * across balances, instalments): its amount is not this payment's alone.
 */
export function excessOfPayment(books: Pick<Index, 'transactions' | 'mappings' | 'receipts'>, ref: string, adding?: string): number | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return undefined;
  const ids = new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId));
  if (adding) ids.add(adding);
  if (books.mappings.some((m) => ids.has(m.receiptId) && m.transactionRef !== ref)) return undefined;
  return excessOf(books.receipts.filter((r) => ids.has(r.id) && r.kind !== 'duplicate'), tx);
}

/**
 * Where a payment the app holds stands today: `waits` for its receipt (the app's work, no one is
 * asked), `asks` for it (the person's, from askFrom on), or `unread`: its receipt came and its VAT
 * could not be read, which only the person can settle, at once. Undefined when it does not wait:
 * never held, booked meanwhile, marked as needing none, or the receipt it waited for is linked now
 * (the next run books it).
 */
export function receiptState(tx: Pick<BankTransaction, 'date' | 'waitsForReceipt' | 'noReceiptNeeded'>, linked: Linked, booked: boolean, today: IsoDate): { kind: 'waits' | 'asks' | 'unread'; due: IsoDate; askFrom: IsoDate } | undefined {
  if (!tx.waitsForReceipt || tx.noReceiptNeeded || booked) return undefined;
  const days = receiptDue(tx.date);
  if (linked === 'unread') return tx.waitsForReceipt.unread ? { kind: 'unread', ...days } : undefined;
  if (linked === 'read' || tx.waitsForReceipt.unread) return undefined;
  return { kind: today >= days.askFrom ? 'asks' : 'waits', ...days };
}

/** A payment the app holds, where it stands today (receiptState); `receipts` are its linked receipts. */
export interface WaitingPayment { tx: BankTransaction; kind: 'waits' | 'asks' | 'unread'; due: IsoDate; askFrom: IsoDate; receipts: Receipt[] }

/** The open payments that wait for their receipt or for the person's word on an unreadable one, oldest first; `isBooked` says whether the books hold its whole booking. */
export function waitingForReceipt(books: Pick<Index, 'transactions' | 'mappings' | 'receipts' | 'config'>, isBooked: (ref: string) => boolean, today: IsoDate): WaitingPayment[] {
  const closed = books.config?.closedThrough;
  const byId = new Map(books.receipts.filter((r) => r.kind !== 'duplicate').map((r) => [r.id, r]));
  const receiptsOf = (ref: string) => books.mappings.filter((m) => m.transactionRef === ref).flatMap((m) => { const r = byId.get(m.receiptId); return r ? [r] : []; });
  return books.transactions
    .filter((tx) => tx.waitsForReceipt && !(closed && tx.date <= closed))
    .flatMap((tx) => { const receipts = receiptsOf(tx.ref); const s = receiptState(tx, linkedOf(receipts, tx), isBooked(tx.ref), today); return s ? [{ tx, receipts, ...s }] : []; })
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.ref.localeCompare(b.tx.ref));
}
