/**
 * Step 4 of the inbox processing (`npm run classify`): every open-period transaction without an
 * entry is booked through the classifier (src/booking/classify.ts). The classifier books into a
 * scratch copy; after each wave of model calls its entries go into books loaded then, for the
 * transactions that are still there, still open and still without an entry.
 * `force` first removes the entries classify itself booked in the open period (see
 * entriesForceMayRemove) and books those transactions again.
 */
import { loadFxResolver } from '../accounting/fx-rates.js';
import { entriesForceMayRemove } from '../accounting/classify-force.js';
import { BATCH_SIZE, CONCURRENCY, classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import { periodLock, type Books } from '../books/store.js';
import type { JournalEntry } from '../types/index.js';
import type { IntakeNote, StepRun } from './pipeline.js';

const unbooked = (books: Books) => {
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((je) => je.transactionRef));
  return books.transactions.filter((tx) => !booked.has(tx.ref) && !lock.isClosed(tx.date));
};

export function classifyStep({ force = false } = {}): StepRun {
  return async ({ ws, books, ask, progress, log }) => {
    // Without a model nothing could be booked again: --force removes nothing then.
    if (force && ask) {
      const removed = books.update((index) => {
        const remove = new Set(entriesForceMayRemove(index.journalEntries, new Set(index.transactions.map((tx) => tx.ref)), periodLock(index).closedThrough));
        index.journalEntries = index.journalEntries.filter((je) => !remove.has(je));
        return remove.size;
      });
      log(`--force: removed ${removed} entries classify booked in the open period, to book their transactions again. Kept: closed periods, corrections, entries without a bank transaction, rebook-shopify payouts.\n`);
    }

    const scratch = books.read();
    const lock = periodLock(scratch);
    const lockedCount = scratch.transactions.filter((tx) => lock.isClosed(tx.date) && !scratch.journalEntries.some((je) => je.transactionRef === tx.ref)).length;
    if (lockedCount > 0) {
      log(`Skipping ${lockedCount} unclassified transaction(s) dated on or before ${lock.closedThrough} (Periode geschlossen — Korrekturen als neue Buchung in der offenen Periode).`);
    }
    const todo = unbooked(scratch);
    if (todo.length === 0) {
      log('All transactions are already classified.');
      return { notes: [] };
    }
    if (!ask) return { notes: [{ code: 'noModel', waiting: todo.length }] };

    progress(0, todo.length);
    log(`Classifying ${todo.length} transactions in ${Math.ceil(todo.length / BATCH_SIZE)} batches of ${BATCH_SIZE} (${CONCURRENCY} concurrent)...\n`);
    const applied = new Set<JournalEntry>();
    const flush = () => {
      const fresh = scratch.journalEntries.filter((je) => !applied.has(je));
      fresh.forEach((je) => applied.add(je));
      books.update((index) => {
        const open = new Set(unbooked(index).map((tx) => tx.ref));
        index.journalEntries.push(...fresh.filter((je) => open.has(je.transactionRef)));
      });
    };
    scratch.journalEntries.forEach((je) => applied.add(je));
    const todoRefs = new Set(todo.map((tx) => tx.ref));
    const { classified, failed } = await classifyTransactions(scratch, todo, {
      ask,
      fx: loadFxResolver(),
      context: loadClassifyContext(ws),
      log,
      afterWave: () => {
        flush();
        progress(new Set(scratch.journalEntries.filter((je) => todoRefs.has(je.transactionRef)).map((je) => je.transactionRef)).size, todo.length);
        log('');
      },
    });
    progress(todo.length, todo.length);

    log(`\nDone.`);
    log(`  Classified: ${classified.length}`);
    log(`  Failed    : ${failed.length}`);
    const notes: IntakeNote[] = failed.length ? [{ code: 'failed', count: failed.length, detail: failed[0].reason.slice(0, 300) }] : [];
    return { notes };
  };
}
