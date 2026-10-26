/**
 * «Zahlung suchen» on a receipt without a payment, «Beleg suchen» on a payment without a receipt
 * (#187): the matching chain for that one record, as the person (PERSON), its outcome in the reply.
 * Without a model the code's clear pair is linked and the rest are candidates to pick. A payment
 * of a filed quarter is never linked: its receipt is pointed at it (filedPayment, golden rule 1);
 * a receipt whose payment is filed is refused (403).
 */
import { Router } from 'express';
import { assertOpen, readBooks, receiptDates, RequestError, updateBooks, WS } from '../books.js';
import { apart, relinked } from '../edits.js';
import { periodLock } from '../../books/store.js';
import { takenPayments } from '../../intake/pairing.js';
import { bookAgain, engine } from './automation.js';
import { closeAsksWithoutRule } from '../../workflows/held.js';
import { askIfReady } from '../../intake/run.js';
import { estvToChf, noReceiptFor, runPairChain, type ChainResult, type Found } from '../../intake/pair-chain.js';
import type { BooksPort } from '../../intake/pipeline.js';

export const router = Router();

const port: BooksPort = { read: readBooks, update: updateBooks };

async function find(only: { receipt: string } | { payment: string }): Promise<Found> {
  const ask = await askIfReady();
  const result: ChainResult = await runPairChain(port, { ask, toChf: estvToChf(), only, noReceipt: noReceiptFor(WS) });
  const model = result.calls > 0 && !result.modelFailed;
  const link = result.linked.find((l) => ('receipt' in only ? l.receipt === only.receipt : l.payment === only.payment));
  if (link) {
    if (!link.filed) {
      const { payments, file } = updateBooks((books) => relinked(books, [{ kind: 'link', receipt: link.receipt, payment: link.payment }]));
      await closeAsksWithoutRule(engine(), WS);
      if (payments.length) await bookAgain(file ?? link.payment);
    }
    return { outcome: link.filed ? 'filed' : 'linked', receipt: link.receipt, payment: link.payment, by: link.by, signals: link.signals, model };
  }
  const left = 'receipt' in only
    ? result.left.filter((l) => l.receipt === only.receipt).flatMap((l) => l.candidates.map((c) => ({ c, total: l.total })))
    : result.left.flatMap((l) => l.candidates.filter((c) => c.payment === only.payment).map((c) => ({ c, total: 0 })));
  const candidates = left.map(({ c }) => ({ receipt: c.receipt, payment: c.payment, score: c.score, filed: c.filed })).sort((a, b) => b.score - a.score);
  if (!candidates.length) return { outcome: 'none', model };
  return { outcome: 'candidates', candidates, total: 'receipt' in only ? left[0].total : candidates.length, model };
}

router.post('/api/receipts/:id/find-payment', async (req, res) => {
  const books = readBooks();
  const id = req.params.id;
  if (!books.receipts.some((r) => r.id === id)) throw new RequestError(404, 'Receipt not found', { code: 'gone', params: { what: 'receipt' } });
  // A receipt a filed payment holds is part of the filed quarter.
  assertOpen(books, receiptDates(books, id), 'mapping');
  res.json(await find({ receipt: id }));
});

router.post('/api/transactions/:ref/find-receipt', async (req, res) => {
  const books = readBooks();
  const ref = req.params.ref;
  if (!books.transactions.some((t) => t.ref === ref)) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
  res.json(await find({ payment: ref }));
});

/**
 * The filed payment a late receipt is pointed at (Receipt.filedPayment), by the person: `payment:
 * null` takes a wrong pointer away, and the pair is never paired again (notPaidBy); a ref points the
 * receipt at that filed payment again (the undo), when no other receipt points at it or is linked to it.
 * Receipts are not sealed; a receipt a filed payment holds by a link is refused (403).
 */
router.post('/api/receipts/:id/filed-payment', (req, res) => {
  const { payment } = (req.body ?? {}) as { payment?: unknown };
  if (payment !== null && typeof payment !== 'string') throw new RequestError(400, 'payment must be a ref or null');
  const id = req.params.id;
  res.json(updateBooks((books) => {
    const r = books.receipts.find((x) => x.id === id);
    if (!r) throw new RequestError(404, 'Receipt not found', { code: 'gone', params: { what: 'receipt' } });
    assertOpen(books, receiptDates(books, id), 'mapping');
    // A correction booked for the filed payment with this receipt counts its input tax already: the correction goes first.
    const correction = books.mappings.filter((m) => m.receiptId === id).flatMap((m) => books.journalEntries.filter((e) => e.transactionRef === m.transactionRef && e.corrects))[0];
    if (payment === null) {
      const was = r.filedPayment;
      if (was && correction) throw new RequestError(409, `Die Korrektur ${correction.id} bucht die Vorsteuer dieses Belegs schon: zuerst sie löschen.`, { code: 'correctionBooked', params: { receipt: id, entry: correction.id } });
      if (was) { delete r.filedPayment; apart(books, id, was, true); }
      return { ok: true, filedPayment: null, was: was ?? null };
    }
    const t = books.transactions.find((x) => x.ref === payment);
    if (!t) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
    if (!periodLock(books).isClosed(t.date)) throw new RequestError(400, 'Only a payment of a filed period is pointed at; link an open one.');
    if (r.filedPayment && r.filedPayment !== payment && correction) throw new RequestError(409, `Die Korrektur ${correction.id} bucht die Vorsteuer dieses Belegs schon: zuerst sie löschen.`, { code: 'correctionBooked', params: { receipt: id, entry: correction.id } });
    if (r.filedPayment !== payment && takenPayments(books).has(payment)) throw new RequestError(409, 'Another receipt holds this payment.');
    // A receipt a bank payment pays meanwhile: its input tax is booked there; pointing it at a filed payment too would count it twice.
    const paid = books.mappings.find((m) => m.receiptId === id && books.transactions.some((x) => x.ref === m.transactionRef));
    if (paid) throw new RequestError(409, `Der Beleg ist mit der Zahlung ${paid.transactionRef} verknüpft: er zahlt keine eingereichte Zahlung mehr.`, { code: 'pointerLinked', params: { receipt: id, payment: paid.transactionRef } });
    if (r.filedPayment && r.filedPayment !== payment) apart(books, id, r.filedPayment, true);
    r.filedPayment = payment;
    apart(books, id, payment, false);
    return { ok: true, filedPayment: payment };
  }));
});
