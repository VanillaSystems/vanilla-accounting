/**
 * The answer to «möglicher Doppelbeleg» in Belege (src/intake/duplicates.ts finds the pairs):
 *
 *   POST /api/receipts/:id/twin  { answer: 'same' | 'distinct', of }
 *
 * «ist dasselbe»: the receipt is a copy (kind duplicate, a person's): its links go, and the
 * entries booked with it, so it never pays a second time nor claims its input tax twice; those
 * payments are booked again. Never in a filed quarter. «verschieden»: the pair is remembered on
 * whichever of the two is in the open period, and not asked again.
 */
import { Router } from 'express';
import { RequestError, assertOpen, receiptDates, updateBooks } from '../books.js';
import { unbookPayments } from '../../accounting/classify-force.js';
import { periodLock } from '../../books/store.js';
import { dropLineBills } from '../../books/card-lines.js';
import { bookAgain } from './automation.js';

export const router = Router();

router.post('/api/receipts/:id/twin', async (req, res) => {
  const { id } = req.params;
  const { answer, of } = (req.body ?? {}) as { answer?: string; of?: string };
  if ((answer !== 'same' && answer !== 'distinct') || typeof of !== 'string' || !of) throw new RequestError(400, 'answer (same oder distinct) und of sind nötig.');
  const { again, receipt } = updateBooks((books) => {
    const receipt = books.receipts.find((r) => r.id === id);
    if (!receipt || !books.receipts.some((r) => r.id === of) || of === id) throw new RequestError(404, 'Receipt not found');
    if (answer === 'distinct') {
      // The note goes on a receipt of the open period: a filed quarter's receipts stay as filed.
      const lock = periodLock(books);
      const [on, other] = receiptDates(books, id).some(lock.isClosed) ? [of, id] : [id, of];
      assertOpen(books, receiptDates(books, on), 'editReceipt');
      const r = books.receipts.find((x) => x.id === on)!;
      if (!r.distinctFrom?.includes(other)) r.distinctFrom = [...(r.distinctFrom ?? []), other];
      return { again: [] as string[], receipt };
    }
    assertOpen(books, receiptDates(books, id), 'editReceipt');
    Object.assign(receipt, { kind: 'duplicate', kindBy: 'human' });
    delete receipt.kindRule;
    delete receipt.kindWhy;
    const refs = books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef);
    dropLineBills(books, id);
    books.mappings = books.mappings.filter((m) => m.receiptId !== id);
    return { again: unbookPayments(books, refs, 'links'), receipt };
  });
  if (again.length) await bookAgain(receipt.filename);
  res.json({ ok: true, receipt });
});
