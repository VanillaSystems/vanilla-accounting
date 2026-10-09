/**
 * POST /api/journal-entries/classify/:txRef — the UI's re-classify of one transaction: its
 * entries are replaced by what the classifier books now. A transaction or entry in a closed
 * period throws ClosedPeriodError, which api.ts's error handler answers with 403.
 */
import { Router } from 'express';
import { ask } from '../../llm/ask.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { classifyTransactions, loadClassifyContext } from '../../booking/classify.js';
import type { Books } from '../../books/store.js';
import { WS, assertOpen, readBooks, refDates, withBooks, RequestError } from '../books.js';

export const router = Router();

function openTransaction(books: Books, txRef: string) {
  const tx = books.transactions.find((t) => t.ref === txRef);
  if (!tx) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, txRef), 'editEntry');
  return tx;
}

// The classifier books into a scratch copy while the model answers; its entries then replace the
// transaction's in books loaded after the answer came, so an edit made meanwhile survives.
router.post('/api/journal-entries/classify/:txRef', async (req, res) => {
  const { txRef } = req.params;
  const scratch = readBooks();
  const tx = openTransaction(scratch, txRef);
  scratch.journalEntries = scratch.journalEntries.filter((je) => je.transactionRef !== txRef);
  const { failed } = await classifyTransactions(scratch, [tx], { ask, fx: loadFxResolver(), context: loadClassifyContext(WS) });
  if (failed.length) throw new RequestError(500, failed.map((f) => f.reason).join('; '));
  const entries = scratch.journalEntries.filter((je) => je.transactionRef === txRef);

  withBooks(res, (books) => {
    openTransaction(books, txRef);
    books.journalEntries = [...books.journalEntries.filter((je) => je.transactionRef !== txRef), ...entries];
    return { ok: true, count: entries.length };
  });
});
