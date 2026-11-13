/**
 * Booking by the firm's rules and by code, without a model, through the write door (#396): a rule
 * kept books the payments it decides, «Automatisch buchen» for all books what the rules decide, and a
 * rule's question that finds its payment decided by a rule books it. Each payment's entries are the
 * classifier's, written only while the payment has no booking, is not in a closed period and is not
 * held by an account's reconciliation (#254). No run holds what is written so: a payment taken back
 * and decided again is booked again (a run's effect is applied once per payment, src/workflows/engine.ts).
 * A sale booked so without an invoice gets its question at once, as after the booking workflow.
 */
import { loadBooks, moduleActor, periodLock, updateSaved } from '../books/store.js';
import { reconciliationOf } from '../books/reconcile.js';
import { classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { askSalesWithoutVat } from '../intake/sale-questions.js';
import type { JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';

/** Who writes what a rule books outside a run: code, through the write door. */
export const RULES_ACTOR = moduleActor('rules');

/** Books these payments where a rule or code decides them; returns the entries written. */
export async function bookByRules(ws: Workspace, refs: readonly string[]): Promise<JournalEntry[]> {
  if (!refs.length) return [];
  const books = loadBooks(ws);
  const want = new Set(refs.filter((ref) => !reconciliationOf(books, ref)));
  if (!want.size) return [];
  const scratch = structuredClone(books);
  const before = scratch.journalEntries.length;
  await classifyTransactions(scratch, books.transactions.filter((t) => want.has(t.ref)), { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  const made = scratch.journalEntries.slice(before);
  const added = updateSaved(ws, RULES_ACTOR, (b) => {
    const lock = periodLock(b);
    const booked = new Set(b.journalEntries.map((e) => e.transactionRef));
    const add = made.filter((e) => !booked.has(e.transactionRef) && !lock.isClosed(e.date) && !reconciliationOf(b, e.transactionRef));
    b.journalEntries.push(...add);
    return add;
  });
  if (added.length) askSalesWithoutVat(ws, loadBooks(ws));
  return added;
}
