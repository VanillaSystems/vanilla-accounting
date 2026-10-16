import { Router } from 'express';
import { readBooks, updateBooks, RequestError, WS } from '../books.js';
import { assertNotSecondPayment, link, relinked, unlink } from '../edits.js';
import type { BookChange } from '../../types/assistant.js';
import { bookAgain, engine } from './automation.js';
import { closeAsksWithoutRule } from '../../workflows/held.js';
import { hasReplaced, recordReplaced, takeReplaced } from '../link-history.js';
import { periodLock, type Books } from '../../books/store.js';
import { modelReady } from '../../llm/ask.js';

export const router = Router();

function linkBody(body: unknown): { receiptId: string; transactionRef: string; confirm: boolean } {
  const { receiptId, transactionRef, confirm } = body as { receiptId: string; transactionRef: string; confirm?: unknown };
  if (!receiptId || !transactionRef) throw new RequestError(400, 'receiptId and transactionRef are required');
  return { receiptId, transactionRef, confirm: confirm === true };
}

/**
 * The bookings that stood before the link go back when «Lösen» leaves the payment without any:
 * open, not booked meanwhile under their ids. Returns whether they are back.
 */
function restoreReplaced(books: Books, payment: string, receipt: string): boolean {
  const back = takeReplaced(WS, payment, receipt);
  if (!back?.length || books.journalEntries.some((e) => e.transactionRef === payment)) return false;
  const lock = periodLock(books);
  const ids = new Set(books.journalEntries.map((e) => e.id));
  if (back.some((e) => lock.isClosed(e.date) || ids.has(e.id))) return false;
  books.journalEntries.push(...back);
  return true;
}

/**
 * A link made or taken back by hand: the payment's automatic booking is made again with what is
 * linked now, and a payout that waited for this report as a question stops waiting (r5h-12). The
 * bookings a link replaces are kept, and «Lösen» puts them back as they were (r8h-21). A second
 * bank payment of another payee for a receipt that has one needs `confirm` (assertNotSecondPayment).
 * Without a model on this Mac, a booked payment keeps its booking and the link (or its removal) is
 * the whole change (`kept` names it): a booking is never taken away for a rebooking nobody can make
 * (r8f-41). «Lösen» still puts a replaced booking back, which needs no model.
 */
async function relink(kind: 'link' | 'unlink', body: unknown): Promise<{ ok: true; again: string[]; kept?: string[] }> {
  const { receiptId: receipt, transactionRef: payment, confirm } = linkBody(body);
  const change: BookChange = { kind, receipt, payment };
  const booked = readBooks().journalEntries.some((e) => e.transactionRef === payment);
  const keep = booked && !(kind === 'unlink' && hasReplaced(WS, payment, receipt)) && !(await modelReady());
  const { payments, file } = updateBooks((books) => {
    if (kind === 'link') {
      if (!confirm) assertNotSecondPayment(books, receipt, payment);
      const had = books.journalEntries.filter((e) => e.transactionRef === payment);
      link(books, receipt, payment);
      if (keep) return { payments: [] };
      const out = relinked(books, [change]);
      const gone = had.filter((e) => !books.journalEntries.includes(e));
      if (gone.length) recordReplaced(WS, payment, receipt, gone);
      return out;
    }
    unlink(books, receipt, payment);
    if (keep) return { payments: [] };
    const out = relinked(books, [change]);
    return restoreReplaced(books, payment, receipt) ? { ...out, payments: out.payments.filter((p) => p !== payment) } : out;
  });
  await closeAsksWithoutRule(engine(), WS);
  if (payments.length) await bookAgain(file ?? payment);
  return { ok: true, again: payments, ...(keep ? { kept: [payment] } : {}) };
}

router.post('/api/mapping/add', async (req, res) => {
  res.json(await relink('link', req.body));
});

router.post('/api/mapping/remove', async (req, res) => {
  res.json(await relink('unlink', req.body));
});
