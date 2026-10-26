/**
 * «Zahlung suchen» on a receipt without a payment, «Beleg suchen» on a payment without a receipt
 * (#187): the matching chain for that one record, as the person (PERSON), its outcome in the reply.
 * Without a model the code's clear pair is linked and the rest are candidates to pick. A payment
 * of a filed quarter is never linked: its receipt is pointed at it (filedPayment, golden rule 1);
 * a receipt whose payment is filed is refused (403).
 */
import { Router } from 'express';
import { assertOpen, readBooks, receiptDates, RequestError, updateBooks, WS } from '../books.js';
import { relinked } from '../edits.js';
import { bookAgain, engine } from './automation.js';
import { closeAsksWithoutRule } from '../../workflows/held.js';
import { askIfReady } from '../../intake/run.js';
import { estvToChf, runPairChain, type ChainResult, type Found } from '../../intake/pair-chain.js';
import type { BooksPort } from '../../intake/pipeline.js';

export const router = Router();

const port: BooksPort = { read: readBooks, update: updateBooks };

async function find(only: { receipt: string } | { payment: string }): Promise<Found> {
  const ask = await askIfReady();
  const result: ChainResult = await runPairChain(port, { ask, toChf: estvToChf(), only });
  const model = result.calls > 0 && !result.modelFailed;
  const link = result.linked.find((l) => ('receipt' in only ? l.receipt === only.receipt : l.payment === only.payment));
  if (link) {
    if (!link.filed) {
      const { payments, file } = updateBooks((books) => relinked(books, [{ kind: 'link', receipt: link.receipt, payment: link.payment }]));
      await closeAsksWithoutRule(engine(), WS);
      if (payments.length) await bookAgain(file ?? link.payment);
    }
    return { outcome: link.filed ? 'filed' : 'linked', receipt: link.receipt, payment: link.payment, by: link.by, model };
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
