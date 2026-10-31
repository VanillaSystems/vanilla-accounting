/**
 * What the bookings of a bank payment keep under cash-basis reporting (vat.reporting: received):
 * each carries the payment's date, so its VAT falls into the payment's quarter, except one on a
 * provider's clearing account, which takes the order's (src/booking/classify.ts); together they move
 * the bank account by what the bank paid. On the agreed basis a coded line on an open item carries
 * its document's date as well (src/accounting/tax-point.ts). The AI sidebar's changes keep both
 * (src/server/edits.ts applyAnswer).
 */
import type { Index, JournalEntry } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { accountOf } from '../workspace/money-accounts.js';
import { fromRappen, toRappen } from './rappen.js';

/**
 * The dates a booking may carry: its payment's. None when no payment holds its ref (a manual entry) or
 * it is on a provider's clearing account (`clearing`, src/booking/providers.ts clearingAccounts).
 */
export function paymentDates(books: Pick<Index, 'transactions'>, e: Pick<JournalEntry, 'transactionRef' | 'accountDebit' | 'accountCredit'>, clearing: ReadonlySet<string>): string[] {
  if (clearing.has(e.accountDebit) || clearing.has(e.accountCredit)) return [];
  return [...new Set(books.transactions.filter((t) => t.ref === e.transactionRef).map((t) => t.date))];
}

/** One bank account a payment moved: what the bank paid and what its bookings move, signed (in: +), in the account's currency. */
export interface PaymentSide { account: string; date: string; currency: string; paid: number; booked: number }

/** The bank sides of a payment; none for an account the manifest does not name. */
export function paymentSides(books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, accounts: readonly LedgerBankAccount[]): PaymentSide[] {
  const sides = new Map<string, PaymentSide>();
  for (const tx of books.transactions.filter((t) => t.ref === ref)) {
    const account = accountOf(tx, accounts)?.account;
    if (!account) continue;
    const side = sides.get(account) ?? { account, date: tx.date, currency: tx.currency, paid: 0, booked: 0 };
    side.paid += toRappen(tx.direction === 'CRDT' ? tx.amount : -tx.amount);
    sides.set(account, side);
  }
  for (const e of books.journalEntries ?? []) {
    if (e.transactionRef !== ref || e.origin === 'year-close') continue;
    const d = sides.get(e.accountDebit);
    if (d) d.booked += toRappen(e.amount);
    const c = sides.get(e.accountCredit);
    if (c) c.booked -= toRappen(e.amount);
  }
  return [...sides.values()].map((s) => ({ ...s, paid: fromRappen(s.paid), booked: fromRappen(s.booked) }));
}

/** Where a payment's booking stands: no entry, entries that do not add up to what the bank paid, or booked. */
export type BookedState = 'none' | 'partly' | 'booked';

/**
 * The one truth for «gebucht» (r9k-2): a payment is booked when its lines add up to what the bank
 * paid on every bank side; lines that fall short (one line of a split undone) leave it partly
 * booked, which Aufgaben, the bank list and the hand form treat as not booked. A payment on an
 * account the manifest does not name counts as booked once it has an entry (no side to add up).
 * A payment with no transaction (a private outlay gone) is booked by its entries alone.
 */
export function bookedState(books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, accounts: readonly LedgerBankAccount[]): BookedState {
  if (!(books.journalEntries ?? []).some((e) => e.transactionRef === ref)) return 'none';
  return paymentSides(books, ref, accounts).some((s) => s.booked !== s.paid) ? 'partly' : 'booked';
}

/** `bookedState` for many payments of the same books: the entries are grouped once. */
export function bookedStates(books: Pick<Index, 'transactions' | 'journalEntries'>, accounts: readonly LedgerBankAccount[]): (ref: string) => BookedState {
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) byRef.set(e.transactionRef, [...(byRef.get(e.transactionRef) ?? []), e]);
  const txByRef = new Map<string, typeof books.transactions>();
  for (const t of books.transactions) txByRef.set(t.ref, [...(txByRef.get(t.ref) ?? []), t]);
  return (ref) => {
    const entries = byRef.get(ref);
    if (!entries) return 'none';
    return bookedState({ transactions: txByRef.get(ref) ?? [], journalEntries: entries }, ref, accounts);
  };
}
