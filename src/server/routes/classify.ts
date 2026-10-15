/**
 * POST /api/journal-entries/classify/:txRef — the UI's re-classify of one transaction: its
 * entries are replaced by what the classifier books now. A transaction or entry in a closed
 * period throws ClosedPeriodError, which api.ts's error handler answers with 403. A payment that
 * holds a person's booking (origin manual: by hand or by a wish in the AI sidebar) is booked anew
 * only when the body says `overwrite: true`; otherwise 409, and her booking stays. An answer that
 * would book the payment wrong (src/booking/classify.ts paymentRefusal) is refused with 422.
 */
import { Router } from 'express';
import { ask } from '../../llm/ask.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { classifyTransactions, loadClassifyContext } from '../../booking/classify.js';
import type { Books } from '../../books/store.js';
import { WS, assertOpen, readBooks, refDates, withBooks, RequestError } from '../books.js';

export const router = Router();

function openTransaction(books: Books, txRef: string, overwrite: boolean) {
  const tx = books.transactions.find((t) => t.ref === txRef);
  if (!tx) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, txRef), 'editEntry');
  const hers = books.journalEntries.filter((je) => je.transactionRef === txRef && je.origin === 'manual').length;
  if (hers && !overwrite) {
    throw new RequestError(409, `Die Zahlung ${txRef} hat ${hers} Buchung(en) von Hand: sie bleiben, solange nicht ausdrücklich neu gebucht wird (overwrite).`, { code: 'personsBooking', params: { entries: hers } });
  }
  return tx;
}

// The classifier books into a scratch copy while the model answers; its entries then replace the
// transaction's in books loaded after the answer came, so an edit made meanwhile survives.
router.post('/api/journal-entries/classify/:txRef', async (req, res) => {
  const { txRef } = req.params;
  const overwrite = req.body?.overwrite === true;
  const scratch = readBooks();
  const tx = openTransaction(scratch, txRef, overwrite);
  scratch.journalEntries = scratch.journalEntries.filter((je) => je.transactionRef !== txRef);
  const { failed } = await classifyTransactions(scratch, [tx], { ask, fx: loadFxResolver(), context: loadClassifyContext(WS) });
  const refused = failed.find((f) => f.refusal);
  if (refused) throw new RequestError(422, refused.reason, refused.refusal);
  if (failed.length) throw new RequestError(500, failed.map((f) => f.reason).join('; '));
  const entries = scratch.journalEntries.filter((je) => je.transactionRef === txRef);

  withBooks(res, (books) => {
    openTransaction(books, txRef, overwrite);
    books.journalEntries = [...books.journalEntries.filter((je) => je.transactionRef !== txRef), ...entries];
    return { ok: true, count: entries.length, entries };
  });
});
