/**
 * Step 4 of the inbox processing (`npm run classify`): every open-period transaction without an
 * entry is booked through the classifier (src/booking/classify.ts). The classifier books into a
 * scratch copy; after each wave of model calls its entries go into books loaded then, for the
 * transactions that are still there, still open and still without an entry.
 * `force` first removes the entries classify itself booked in the open period (see
 * entriesForceMayRemove) and books those transactions again. Last, every customer payment booked
 * without VAT and without an invoice becomes a question to the owner (src/intake/sale-questions.ts).
 */
import { loadFxResolver } from '../accounting/fx-rates.js';
import { entriesForceMayRemove, entriesWithoutTheirReceipts } from '../accounting/classify-force.js';
import { BATCH_SIZE, CONCURRENCY, bookImportVatDeductions, classifyTransactions, loadClassifyContext, type ClassifyContext } from '../booking/classify.js';
import { answerSettles, receiptKnowledge, receiptWaitOf } from '../booking/receipt-wait.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { periodLock, type Books } from '../books/store.js';
import { heldByReconciliation } from '../books/reconcile.js';
import type { JournalEntry } from '../types/index.js';
import { askSalesWithoutVat, closeSaleQuestionsHeld } from './sale-questions.js';
import { bookPayoutReports } from './sales-report-import.js';
import type { Workspace } from '../workspace/workspace.js';
import type { BooksPort, IntakeNote, StepRun } from './pipeline.js';

/** The note for the sales without VAT asked about now; a payment asked about before is not asked again. */
function askSales(ws: Workspace, books: BooksPort, log: (line: string) => void): IntakeNote[] {
  const asked = askSalesWithoutVat(ws, books.read());
  if (asked.length) log(`  Asked     : ${asked.length} customer payment(s) without an invoice: with VAT, abroad, or no sale?`);
  return asked.length ? [{ code: 'saleAsked', count: asked.length }] : [];
}

/**
 * The open payments without a booking, less those waiting for a person: a booking deleted on purpose
 * (r10h-5), or a movement of an account's reconciliation that waits (#254, src/books/reconcile.ts).
 */
const unbooked = (books: Books) => {
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((je) => je.transactionRef));
  const held = heldByReconciliation(books);
  return books.transactions.filter((tx) => !booked.has(tx.ref) && !lock.isClosed(tx.date) && !tx.waitsForPerson && !held.has(tx.ref));
};

/** The open payments that need a receipt and have none, and those whose receipt could not be read (src/booking/receipt-wait.ts). */
function needReceipts(ws: Workspace, books: Books, context: ClassifyContext, fx: FxResolver): { need: Set<string>; unread: Set<string> } {
  const known = receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root));
  const need = new Set<string>();
  const unread = new Set<string>();
  for (const tx of unbooked(books)) {
    const w = receiptWaitOf(books, tx, context, known, fx);
    if (w.wait) (w.unread ? unread : need).add(tx.ref);
  }
  return { need, unread };
}

/**
 * Marks the payments that wait for their receipt, and those whose receipt could not be read
 * (`unread`), and takes the mark off every other open payment (a receipt came, it was booked, a
 * person marked it as needing none). `decided`: the waiting payments a run with a model judged.
 */
function markWaiting(books: BooksPort, waiting: ReadonlySet<string>, decided: ReadonlySet<string>, unread: ReadonlySet<string>): void {
  const since = new Date().toISOString();
  const open = (index: Books) => { const lock = periodLock(index); return index.transactions.filter((tx) => !lock.isClosed(tx.date)); };
  const stale = (tx: Books['transactions'][number]) => !!tx.waitsForReceipt !== (waiting.has(tx.ref) || unread.has(tx.ref))
    || !!tx.waitsForReceipt?.unread !== unread.has(tx.ref) || (waiting.has(tx.ref) && !!tx.waitsForReceipt?.decided !== decided.has(tx.ref));
  if (!open(books.read()).some(stale)) return;
  books.update((index) => {
    for (const tx of open(index)) {
      if (!stale(tx)) continue;
      if (unread.has(tx.ref)) tx.waitsForReceipt = { since, unread: true };
      else if (waiting.has(tx.ref)) tx.waitsForReceipt = { since: tx.waitsForReceipt?.since ?? since, ...(decided.has(tx.ref) && { decided: true as const }) };
      else delete tx.waitsForReceipt;
    }
  });
}

export function classifyStep({ force = false } = {}): StepRun {
  return async ({ ws, books, ask, progress, log, hold, release }) => {
    // Without a model nothing could be booked again: --force removes nothing then.
    if (force && ask) {
      const removed = books.update((index) => {
        const remove = new Set(entriesForceMayRemove(index.journalEntries, new Set(index.transactions.map((tx) => tx.ref)), periodLock(index).closedThrough));
        index.journalEntries = index.journalEntries.filter((je) => !remove.has(je));
        return remove.size;
      });
      log(`--force: removed ${removed} entries classify booked in the open period, to book their transactions again. Kept: closed periods, corrections, entries without a bank transaction, payouts an earlier tool split per order.\n`);
    }

    // A receipt linked after its payment was booked: the booking is made again, with what the receipt says.
    if (!force && ask) {
      const again = books.update((index) => {
        const remove = new Set(entriesWithoutTheirReceipts(index.journalEntries, index.mappings, new Set(index.transactions.map((tx) => tx.ref)), periodLock(index).closedThrough));
        index.journalEntries = index.journalEntries.filter((je) => !remove.has(je));
        return new Set([...remove].map((je) => je.transactionRef)).size;
      });
      if (again) log(`${again} payment(s) got a receipt after they were booked: booking them again.\n`);
    }

    const scratch = books.read();
    const lock = periodLock(scratch);
    const lockedCount = scratch.transactions.filter((tx) => lock.isClosed(tx.date) && !scratch.journalEntries.some((je) => je.transactionRef === tx.ref)).length;
    if (lockedCount > 0) {
      log(`Skipping ${lockedCount} unclassified transaction(s) dated on or before ${lock.closedThrough} (Periode geschlossen — Korrekturen als neue Buchung in der offenen Periode).`);
    }
    const context = loadClassifyContext(ws);
    const fx = loadFxResolver();
    // A payment that needs a receipt waits for it. One no run with a model has judged yet goes to the model once:
    // an answer that only settles (the owner's outlays paid back, a card's bill) is booked, any other waits (issue #90),
    // a supplier's payment the model puts on the owner's account too (issue #201).
    // Without a model it waits too, and the next run with one judges it (issue #110).
    // A payment whose receipt could not be read waits for the person's word, without a guess (issue #57).
    const { need, unread } = needReceipts(ws, scratch, context, fx);
    const judged = new Set(scratch.transactions.filter((tx) => tx.waitsForReceipt?.decided).map((tx) => tx.ref));
    const probe = new Set(ask ? [...need].filter((ref) => !judged.has(ref)) : []);
    const waiting = new Set([...need].filter((ref) => !probe.has(ref)));
    const txOf = new Map(scratch.transactions.map((tx) => [tx.ref, tx]));
    const keeps = (ref: string) => !probe.has(ref) || answerSettles(txOf.get(ref)!, scratch.journalEntries.filter((je) => je.transactionRef === ref), context);
    const done = (notes: IntakeNote[]) => {
      // A customs assessment that came after its import VAT was booked brings the deduction (issue #197).
      // Saved whenever it books or marks an assessment as used: a mark lost would let a deduction a person took back come again.
      const would = bookImportVatDeductions(structuredClone(books.read()), context);
      const deducted = would.booked + would.marked ? books.update((index) => bookImportVatDeductions(index, context)).booked : 0;
      if (deducted) log(`Customs   : ${deducted} import VAT deduction(s) booked from customs assessments.`);
      // A provider's payout report read at the match step books its sales and fees onto the provider's clearing account (#203).
      const reports = books.update((index) => bookPayoutReports(ws, index, fx));
      if (reports) log(`Reports   : ${reports} payout report(s) of a payment provider booked onto its clearing account.`);
      // A probe the model gave no answer for (it failed) waits unjudged, and the next run asks again.
      const decided = new Set([...waiting].filter((ref) => judged.has(ref)));
      for (const ref of probe) {
        const answered = scratch.journalEntries.some((je) => je.transactionRef === ref);
        if (answered && keeps(ref)) continue;
        waiting.add(ref);
        if (answered) decided.add(ref);
      }
      markWaiting(books, waiting, decided, unread);
      if (waiting.size) log(`Waiting   : ${waiting.size} payment(s) need a receipt that has not come: booked once it is linked.`);
      if (unread.size) log(`Unread    : ${unread.size} payment(s) have a receipt whose VAT could not be read: the person is asked.`);
      return { notes: [...notes, ...(waiting.size ? [{ code: 'waitingReceipt' as const, count: waiting.size }] : []), ...(unread.size ? [{ code: 'receiptUnread' as const, count: unread.size }] : []), ...askSales(ws, books, log)] };
    };
    const todo = unbooked(scratch).filter((tx) => !waiting.has(tx.ref) && !unread.has(tx.ref));
    if (todo.length === 0) {
      log('All transactions are already classified.');
      return done([]);
    }
    progress(0, todo.length);
    log(`Classifying ${todo.length} transactions in ${Math.ceil(todo.length / BATCH_SIZE)} batches of ${BATCH_SIZE} (${CONCURRENCY} concurrent)...\n`);
    const applied = new Set<JournalEntry>();
    const flush = () => {
      const fresh = scratch.journalEntries.filter((je) => !applied.has(je));
      fresh.forEach((je) => applied.add(je));
      books.update((index) => {
        const open = new Set(unbooked(index).map((tx) => tx.ref));
        index.journalEntries.push(...fresh.filter((je) => open.has(je.transactionRef) && keeps(je.transactionRef)));
      });
    };
    scratch.journalEntries.forEach((je) => applied.add(je));
    const todoRefs = new Set(todo.map((tx) => tx.ref));
    const { classified, failed, asked, unasked } = await classifyTransactions(scratch, todo, {
      ask,
      proposeAsked: false,
      fx,
      context,
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
    log(`  Asked     : ${asked.length}`);
    const held = [...asked.map((a) => a.ref), ...unasked];
    if (held.length) hold?.(held);
    const booked = classified.filter(keeps);
    if (booked.length) release?.(booked);
    // A payment a rule holds has its question under Aufgaben; the app's own VAT question about it would ask twice (r7h-27).
    closeSaleQuestionsHeld(ws, asked.map((a) => a.ref), scratch.config.closedThrough);
    const notes: IntakeNote[] = [
      ...(unasked.length ? [{ code: 'noModel' as const, waiting: unasked.length }] : []),
      ...(failed.length ? [{ code: 'failed' as const, count: failed.length, detail: failed[0].reason.slice(0, 300) }] : []),
      ...(asked.length ? [{ code: 'asked' as const, count: asked.length }] : []),
    ];
    return done(notes);
  };
}
