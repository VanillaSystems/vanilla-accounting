import { Router } from 'express';
import { withBooks, RequestError } from '../books.js';
import { link, unlink } from '../edits.js';

export const router = Router();

function linkBody(body: unknown): { receiptId: string; transactionRef: string } {
  const { receiptId, transactionRef } = body as { receiptId: string; transactionRef: string };
  if (!receiptId || !transactionRef) throw new RequestError(400, 'receiptId and transactionRef are required');
  return { receiptId, transactionRef };
}

router.post('/api/mapping/add', (req, res) => {
  const { receiptId, transactionRef } = linkBody(req.body);
  return withBooks(res, (books) => {
    link(books, receiptId, transactionRef);
    return { ok: true };
  });
});

router.post('/api/mapping/remove', (req, res) => {
  const { receiptId, transactionRef } = linkBody(req.body);
  return withBooks(res, (books) => {
    unlink(books, receiptId, transactionRef);
    return { ok: true };
  });
});
