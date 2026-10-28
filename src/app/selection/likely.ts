/**
 * The most likely action on what is shown (#216): code decides it from the object's facts, and
 * the Aktionen menu puts it beside itself as the primary button. Pure, so a test walks it.
 */
import type { SelectKind } from './model.js';

export interface ReceiptFacts {
  /** Set aside as no receipt. */
  none: boolean;
  linked: boolean;
  /** A filed period holds it. */
  locked: boolean;
  /** Code found a payment that fits. */
  suggestion: boolean;
  /** Its text says it was paid in cash or privately (src/accounting/paid-how.ts). */
  paidPrivately: boolean;
  dated: boolean;
}

export type ReceiptLikely = 'mark' | 'accept' | 'private' | 'link' | 'edit' | 'openPayment' | undefined;

/**
 * A receipt set aside: «Ist ein Beleg». One without a payment: the payment code found, else
 * «Privat bezahlt buchen» when its words say it was paid in cash or privately, else the link
 * dialog; without a date, «Angaben» first (no payment fits a receipt without its day). A linked
 * or filed one: its payment.
 */
export function likelyReceipt(f: ReceiptFacts): ReceiptLikely {
  if (f.none) return 'mark';
  if (f.linked) return 'openPayment';
  if (f.locked) return undefined;
  if (f.suggestion) return 'accept';
  if (f.paidPrivately) return 'private';
  if (!f.dated) return 'edit';
  return 'link';
}

export interface PaymentFacts { unbooked: boolean; needsReceipt: boolean; locked: boolean; booked: boolean }
export type PaymentLikely = 'book' | 'findReceipt' | 'openEntry' | undefined;

/** A payment without a booking: «Buchen»; one that waits for its receipt: «Beleg suchen»; a booked one: its entry. */
export function likelyPayment(f: PaymentFacts): PaymentLikely {
  if (f.locked) return f.booked ? 'openEntry' : undefined;
  if (f.needsReceipt) return 'findReceipt';
  if (f.unbooked) return 'book';
  return f.booked ? 'openEntry' : undefined;
}

export interface EntryFacts { locked: boolean; yearClose: boolean }
export type EntryLikely = 'edit' | 'correct' | undefined;

/** An open entry: «Ändern»; a filed one: its correction in the open period; the year-end revaluation: nothing by hand. */
export function likelyEntry(f: EntryFacts): EntryLikely {
  if (f.yearClose) return undefined;
  return f.locked ? 'correct' : 'edit';
}

/**
 * A selection: what most of its rows want. Receipts mostly without a payment: «Zahlung suchen»;
 * payments mostly without a booking: «Buchen …», mostly waiting for a receipt: «Braucht keinen
 * Beleg»; entries: «Konto ändern …».
 */
export function likelySelection(kind: SelectKind, counts: { n: number; open: number; unbooked: number; noReceipt: number }): 'findPayment' | 'book' | 'noReceiptNeeded' | 'account' | undefined {
  const most = (x: number) => x > 0 && x * 2 >= counts.n;
  switch (kind) {
    case 'receipt': return most(counts.open) ? 'findPayment' : undefined;
    case 'payment': return most(counts.unbooked) ? 'book' : most(counts.noReceipt) ? 'noReceiptNeeded' : undefined;
    case 'entry': return 'account';
  }
}
