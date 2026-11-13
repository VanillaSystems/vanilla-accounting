/**
 * What the wages withheld and the firm still owes on their behalf (#426): the credit on the
 * deductions account (setup.yaml `wages.deductions`) at the end of a payment's day. Books that carry
 * wages gross credit it with each payslip's deductions; the payment of the contributions clears it.
 * A contribution bill states its totals by contribution, not by party, so only the books say how much
 * of a payment is the employees' share: the model is told this figure and the guide says how to use
 * it (booking.guide.yaml cls-social-insurance). Code books nothing by it.
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { balanceAt } from './providers.js';

type Books = { journalEntries: readonly JournalEntry[]; config?: { openingBalances?: Record<string, Record<string, number>> } };

/**
 * The credit `account` holds at the end of the payment's day, without the payment's own entries (a
 * payment booked again is told what was open before it); undefined for money in, without the
 * account, or when it holds no credit (wages booked net never touch it).
 */
export function withheldFor(books: Books, tx: Pick<BankTransaction, 'ref' | 'date' | 'direction'>, account: string | undefined): number | undefined {
  if (!account || tx.direction !== 'DBIT') return undefined;
  const others = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
  const credit = -balanceAt(others, account, tx.date, books.config?.openingBalances);
  return credit > 0 ? credit : undefined;
}
