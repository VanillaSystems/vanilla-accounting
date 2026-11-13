/**
 * POST /api/journal-entries/classify/:txRef — the UI's re-classify of one transaction: its
 * entries are replaced by what the classifier books now. A transaction or entry in a closed
 * period throws ClosedPeriodError, which api.ts's error handler answers with 403. A payment that
 * holds a person's booking (origin manual: by hand or by a wish in the AI sidebar) is booked anew
 * only when the body says `overwrite: true`; otherwise 409, and her booking stays. An answer that
 * would book the payment wrong (src/booking/classify.ts paymentRefusal) is refused with 422. A bank
 * movement of an account's reconciliation that waits (#254) is refused with 409 `reconcilePending` until
 * the person confirms it, one booked in a filed quarter as a read movement with 409 `bookedInFiled`.
 */
import { Router } from 'express';
import { ask } from '../../llm/ask.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { classifyTransactions, loadClassifyContext, vatToRead } from '../../booking/classify.js';
import { vatStep } from '../../intake/vat.js';
import { moduleActor, updateSaved, type Books } from '../../books/store.js';
import { reconcileRefusal, reconciliationOf } from '../../books/reconcile.js';
import { WS, assertOpen, readBooks, refDates, updateBooks, RequestError } from '../books.js';
import { assertNotBookedInFiled, bookedAgain } from '../edits.js';
import { learnFromCorrection } from '../questions.js';
import { askSalesWithoutVat } from '../../intake/sale-questions.js';
import { ordersPaidElsewhere } from '../../intake/sales-report-import.js';

export const router = Router();

function openTransaction(books: Books, txRef: string, overwrite: boolean) {
  const tx = books.transactions.find((t) => t.ref === txRef);
  if (!tx) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, txRef), 'editEntry');
  // A movement of a reconciliation that waits is not booked automatically (#254): booked now, it may count twice; one booked in a filed quarter as a read movement is booked.
  assertNotBookedInFiled(books, tx);
  const reconcile = reconciliationOf(books, txRef);
  if (reconcile) {
    const { why: { params } } = reconcileRefusal(reconcile);
    throw new RequestError(409, `Die Zahlung ${txRef} gehört zum Abgleich der aus PDFs gelesenen Bewegungen von Konto ${reconcile.account} mit dem Bank-Export (${reconcile.from} bis ${reconcile.to}): erst den Abgleich bestätigen.`, { code: 'reconcilePending', params: { account: params.account, from: params.from, to: params.to, payment: params.payment } });
  }
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
  // Her correction of a sale is kept as a rule first, so the classifier books it as she set.
  if (overwrite) learnFromCorrection([txRef]);
  const first = readBooks();
  openTransaction(first, txRef, overwrite);
  // Her click reads the VAT of the payment's receipts nobody has read yet first (#391): the model books on what they show, never on a guess.
  const toRead = new Set(first.transactions.filter((t) => t.ref === txRef).flatMap((t) => vatToRead(first, t)).map((r) => r.id));
  // The read is the VAT step's, written as the module (#450): its facts, or one more failed read on the receipt.
  if (toRead.size) await vatStep({ only: toRead })({ ws: WS, books: { read: readBooks, update: (fn) => updateSaved(WS, moduleActor('intake'), fn, readBooks) }, ask, progress: () => {}, log: () => {} });
  const scratch = toRead.size ? readBooks() : first;
  scratch.journalEntries = scratch.journalEntries.filter((je) => je.transactionRef !== txRef);
  // Every movement of the ref: the entries of all legs of a charge split across balances under one ref are replaced below (#287).
  const { failed, vatNotRead } = await classifyTransactions(scratch, scratch.transactions.filter((t) => t.ref === txRef), { ask, fx: loadFxResolver(), context: loadClassifyContext(WS) });
  if (vatNotRead.length) {
    const receipt = scratch.transactions.filter((t) => t.ref === txRef).flatMap((t) => vatToRead(scratch, t)).map((r) => r.originalFilename ?? r.filename).join(', ');
    throw new RequestError(422, `Die Steuer auf dem Beleg ${receipt} ist noch nicht gelesen: nichts gebucht. Die App liest sie beim nächsten Lauf und bucht die Zahlung dann; oder trage sie beim Beleg unter Angaben ein.`, { code: 'classifyVatNotRead', params: { receipt } });
  }
  const refused = failed.find((f) => f.refusal);
  if (refused) throw new RequestError(422, refused.reason, refused.refusal);
  if (failed.length) throw new RequestError(500, failed.map((f) => f.reason).join('; '));
  const entries = scratch.journalEntries.filter((je) => je.transactionRef === txRef);

  const done = updateBooks((books) => {
    openTransaction(books, txRef, overwrite);
    books.journalEntries = [...books.journalEntries.filter((je) => je.transactionRef !== txRef), ...entries];
    // «Automatisch buchen» is the person asking the app: a payment waiting for her waits no more (r10h-5).
    bookedAgain(books, txRef);
    return { ok: true, count: entries.length, entries };
  });
  // A sale booked now without an invoice is asked about now, as its reason says, not at the next inbox run (r4c-36).
  const books = readBooks();
  askSalesWithoutVat(WS, books, undefined, ordersPaidElsewhere(WS, books));
  res.json(done);
});
