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
import { BATCH_SIZE, CONCURRENCY, classifyTransactions, loadClassifyContext, type ClassifyContext } from '../booking/classify.js';
import { onlySettles, receiptFree, receiptWaitOf, settlementAccount } from '../booking/receipt-wait.js';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { periodLock, type Books } from '../books/store.js';
import type { JournalEntry } from '../types/index.js';
import { askSalesWithoutVat, closeSaleQuestionsHeld } from './sale-questions.js';
import type { Workspace } from '../workspace/workspace.js';
import type { BooksPort, IntakeNote, StepRun } from './pipeline.js';

/** The note for the sales without VAT asked about now; a payment asked about before is not asked again. */
function askSales(ws: Workspace, books: BooksPort, log: (line: string) => void): IntakeNote[] {
  const asked = askSalesWithoutVat(ws, books.read());
  if (asked.length) log(`  Asked     : ${asked.length} customer payment(s) without an invoice: with VAT, abroad, or no sale?`);
  return asked.length ? [{ code: 'saleAsked', count: asked.length }] : [];
}

/** The open payments without a booking, less those waiting for a person (a booking deleted on purpose, r10h-5). */
const unbooked = (books: Books) => {
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((je) => je.transactionRef));
  return books.transactions.filter((tx) => !booked.has(tx.ref) && !lock.isClosed(tx.date) && !tx.waitsForPerson);
};

/** The open payments that need a receipt and have none (src/booking/receipt-wait.ts). */
function needReceipts(ws: Workspace, books: Books, context: ClassifyContext, fx: FxResolver): Set<string> {
  const free = receiptFree(loadKnowledge(APP_ROOT, ws.paths.root));
  return new Set(unbooked(books).filter((tx) => receiptWaitOf(books, tx, context, free, fx).wait).map((tx) => tx.ref));
}

/** Marks the payments that wait for their receipt, and takes the mark off every other open payment (a receipt came, it was booked, a person marked it as needing none). */
function markWaiting(books: BooksPort, waiting: ReadonlySet<string>): void {
  const since = new Date().toISOString();
  const open = (index: Books) => { const lock = periodLock(index); return index.transactions.filter((tx) => !lock.isClosed(tx.date)); };
  if (!open(books.read()).some((tx) => !!tx.waitsForReceipt !== waiting.has(tx.ref))) return;
  books.update((index) => {
    for (const tx of open(index)) {
      if (!waiting.has(tx.ref)) delete tx.waitsForReceipt;
      else tx.waitsForReceipt ??= { since };
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
      log(`--force: removed ${removed} entries classify booked in the open period, to book their transactions again. Kept: closed periods, corrections, entries without a bank transaction, payouts the retired rebook-shopify split per order.\n`);
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
    // A payment that needs a receipt waits for it. One not marked yet goes to the model once: an answer
    // that only settles (the owner's outlays paid back, a card's bill) is booked, any other waits (issue #90).
    const need = needReceipts(ws, scratch, context, fx);
    const probe = new Set(ask ? [...need].filter((ref) => !scratch.transactions.find((tx) => tx.ref === ref)?.waitsForReceipt) : []);
    const waiting = new Set([...need].filter((ref) => !probe.has(ref)));
    const settles = settlementAccount(context);
    const bankOf = new Map(scratch.transactions.map((tx) => [tx.ref, bankAccountFor(tx, context.bankAccounts)]));
    const keeps = (ref: string) => !probe.has(ref) || onlySettles(scratch.journalEntries.filter((je) => je.transactionRef === ref), bankOf.get(ref) ?? '', settles);
    const done = (notes: IntakeNote[]) => {
      for (const ref of probe) if (!keeps(ref) && scratch.journalEntries.some((je) => je.transactionRef === ref)) waiting.add(ref);
      markWaiting(books, waiting);
      if (waiting.size) log(`Waiting   : ${waiting.size} payment(s) need a receipt that has not come: booked once it is linked.`);
      return { notes: [...notes, ...(waiting.size ? [{ code: 'waitingReceipt' as const, count: waiting.size }] : []), ...askSales(ws, books, log)] };
    };
    const todo = unbooked(scratch).filter((tx) => !waiting.has(tx.ref));
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
    const { classified, failed, asked, unasked, held: heldPayouts } = await classifyTransactions(scratch, todo, {
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
    // A payout its orders hold is named in its own note with its reason, not counted as failed or asked by a rule.
    const byOrders = new Set(heldPayouts.map((h) => h.ref));
    const failedElse = failed.filter((f) => !byOrders.has(f.ref));
    const askedElse = asked.filter((a) => !byOrders.has(a.ref));
    const tx = new Map(todo.map((t) => [t.ref, t]));
    const payouts = heldPayouts.flatMap((h) => { const t = tx.get(h.ref); return t ? [{ date: t.date, amount: t.amount, currency: t.currency, hold: h.hold }] : []; });
    const notes: IntakeNote[] = [
      ...(unasked.length ? [{ code: 'noModel' as const, waiting: unasked.length }] : []),
      ...(failedElse.length ? [{ code: 'failed' as const, count: failedElse.length, detail: failedElse[0].reason.slice(0, 300) }] : []),
      ...(payouts.length ? [{ code: 'payoutsHeld' as const, payouts }] : []),
      ...(askedElse.length ? [{ code: 'asked' as const, count: askedElse.length }] : []),
    ];
    return done(notes);
  };
}
