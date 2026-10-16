import { Router } from 'express';
import { updateBooks, RequestError, WS } from '../books.js';
import { link, relinked, unlink } from '../edits.js';
import type { BookChange } from '../../types/assistant.js';
import { bookAgain, engine } from './automation.js';
import { closeAsksWithoutRule } from '../../workflows/held.js';

export const router = Router();

function linkBody(body: unknown): { receiptId: string; transactionRef: string } {
  const { receiptId, transactionRef } = body as { receiptId: string; transactionRef: string };
  if (!receiptId || !transactionRef) throw new RequestError(400, 'receiptId and transactionRef are required');
  return { receiptId, transactionRef };
}

/**
 * A link made or taken back by hand: the payment's automatic booking is made again with what is
 * linked now, and a payout that waited for this report as a question stops waiting (r5h-12).
 */
async function relink(kind: 'link' | 'unlink', body: unknown): Promise<{ ok: true; again: string[] }> {
  const { receiptId: receipt, transactionRef: payment } = linkBody(body);
  const change: BookChange = { kind, receipt, payment };
  const { payments, file } = updateBooks((books) => {
    (kind === 'link' ? link : unlink)(books, receipt, payment);
    return relinked(books, [change]);
  });
  await closeAsksWithoutRule(engine(), WS);
  if (payments.length) await bookAgain(file ?? payment);
  return { ok: true, again: payments };
}

router.post('/api/mapping/add', async (req, res) => {
  res.json(await relink('link', req.body));
});

router.post('/api/mapping/remove', async (req, res) => {
  res.json(await relink('unlink', req.body));
});
