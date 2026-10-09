import { Router } from 'express';
import { CLOSED, assertOpen, refDates, receiptDates, withBooks, RequestError } from '../books.js';

export const router = Router();

function linkBody(body: unknown): { receiptId: string; transactionRef: string } {
  const { receiptId, transactionRef } = body as { receiptId: string; transactionRef: string };
  if (!receiptId || !transactionRef) throw new RequestError(400, 'receiptId and transactionRef are required');
  return { receiptId, transactionRef };
}

router.post('/api/mapping/add', (req, res) => {
  const { receiptId, transactionRef } = linkBody(req.body);
  return withBooks(res, (books) => {
    if (!books.receipts.some((r) => r.id === receiptId)) throw new RequestError(404, 'Receipt not found');
    if (!books.transactions.some((t) => t.ref === transactionRef)) throw new RequestError(404, 'Transaction not found');
    assertOpen(books, refDates(books, transactionRef), CLOSED.mapping);

    if (!books.mappings.some((m) => m.transactionRef === transactionRef && m.receiptId === receiptId)) {
      books.mappings.push({ transactionRef, receiptId });
    }
    return { ok: true };
  });
});

router.post('/api/mapping/approve-duplicate', (req, res) => {
  const { receiptId } = req.body as { receiptId: string };
  if (!receiptId) throw new RequestError(400, 'receiptId is required');

  return withBooks(res, (books) => {
    assertOpen(books, receiptDates(books, receiptId), CLOSED.mapping);
    books.mappings = books.mappings.map((m) =>
      m.receiptId === receiptId ? { ...m, approvedDuplicate: true } : m,
    );
    return { ok: true };
  });
});

router.post('/api/mapping/remove', (req, res) => {
  const { receiptId, transactionRef } = linkBody(req.body);
  return withBooks(res, (books) => {
    assertOpen(books, refDates(books, transactionRef), CLOSED.mapping);
    books.mappings = books.mappings.filter(
      (m) => !(m.transactionRef === transactionRef && m.receiptId === receiptId),
    );
    return { ok: true };
  });
});
