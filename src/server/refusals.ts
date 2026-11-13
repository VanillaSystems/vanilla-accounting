/**
 * The open payments a run left unbooked, with why (#470): read from the run log, which travels with
 * the books (src/workflows/runlog.ts), for the payments that still have no booking. The one source of
 * that reason for the payment's page, the lists, the drop and the AI's facts.
 */
import { readLog } from '../workflows/runlog.js';
import { refusalsOf, type PaymentRefusal } from '../workflows/history.js';
import type { Workspace } from '../workspace/workspace.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';

export function paymentRefusals(ws: Pick<Workspace, 'paths'>, books: { transactions: readonly BankTransaction[]; journalEntries: readonly JournalEntry[] }): PaymentRefusal[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const open = new Set(books.transactions.filter((t) => t.amount !== 0 && !booked.has(t.ref)).map((t) => t.ref));
  return open.size ? refusalsOf(readLog(ws), open) : [];
}
