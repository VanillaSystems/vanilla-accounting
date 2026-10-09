/**
 * npm run classify
 *
 * Books every unclassified open-period transaction through the classifier
 * (src/booking/classify.ts), saving after each wave of model calls.
 * --force first removes the entries classify itself booked in the open period (see
 * entriesForceMayRemove) and books those transactions again.
 */

import 'dotenv/config';
import { ask } from '../llm/ask.js';
import { reconcileVat } from '../reconcile/vat-consistency.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { entriesForceMayRemove } from '../accounting/classify-force.js';
import { BATCH_SIZE, CONCURRENCY, classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import { loadBooks, mutateJournal, periodLock, saveBooks, type Books } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();

async function main() {
  const index = loadBooks(ws);
  await mutateJournal(index, classifyOpen);
}

async function classifyOpen(index: Books) {
  const lock = periodLock(index);

  if (process.argv.includes('--force')) {
    const remove = new Set(entriesForceMayRemove(index.journalEntries, new Set(index.transactions.map((tx) => tx.ref)), lock.closedThrough));
    console.log(`--force: removing ${remove.size} entries classify booked in the open period, to book their transactions again. Kept: closed periods, corrections, entries without a bank transaction, rebook-shopify payouts.\n`);
    index.journalEntries = index.journalEntries.filter((je) => !remove.has(je));
  }

  const classifiedRefs = new Set(index.journalEntries.map((je) => je.transactionRef));
  const unclassified = index.transactions.filter((tx) => !classifiedRefs.has(tx.ref) && !lock.isClosed(tx.date));
  const lockedCount = index.transactions.filter((tx) => !classifiedRefs.has(tx.ref) && lock.isClosed(tx.date)).length;
  if (lockedCount > 0) {
    console.log(`Skipping ${lockedCount} unclassified transaction(s) dated on or before ${lock.closedThrough} (Periode geschlossen — Korrekturen als neue Buchung in der offenen Periode).`);
  }

  if (unclassified.length === 0) {
    console.log('All transactions are already classified.');
    reconcileVat(index);
    return;
  }

  console.log(`Classifying ${unclassified.length} transactions in ${Math.ceil(unclassified.length / BATCH_SIZE)} batches of ${BATCH_SIZE} (${CONCURRENCY} concurrent)...\n`);
  const { classified, failed } = await classifyTransactions(index, unclassified, {
    ask,
    fx: loadFxResolver(),
    context: loadClassifyContext(ws),
    log: console.log,
    afterWave: () => { saveBooks(ws, index); console.log(); },
  });

  console.log(`\nDone.`);
  console.log(`  Classified: ${classified.length}`);
  console.log(`  Failed    : ${failed.length}`);

  reconcileVat(index);
}

main().catch((err) => { console.error(err); process.exit(1); });
