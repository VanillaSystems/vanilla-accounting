import { Router } from 'express';
import { readBooks, updateBooksWithEffects, RequestError, WS } from '../books.js';
import { assertNotSecondPayment, link, relinked, unlink } from '../edits.js';
import type { BookChange } from '../../types/assistant.js';
import { bookAgain, engine } from './automation.js';
import { closeAsksWithoutRule } from '../../workflows/held.js';
import { recordReplaced, takeReplaced } from '../link-history.js';
import { periodLock, type Books } from '../../books/store.js';
import { modelReady } from '../../llm/ask.js';
import { archiveReceipt } from '../../books/archive.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { liveInvoices } from '../../invoices/rules.js';
import { paymentContext } from '../../invoices/service.js';
import { releasePayment } from '../../invoices/payments.js';

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
 * bank payment of another payee for a receipt that has one needs `confirm` (assertNotSecondPayment); a receipt paid privately takes none (link: assertNotPaidPrivately, #90).
 * A booking without a payment (#89) takes the link as a payment does.
 * Without a model on this Mac, a booked payment keeps its booking and the link is the whole change
 * (`kept` names it): a booking that saw no receipt claims nothing too much, and it is never taken
 * away for a rebooking nobody can make (r8f-41). An unlink still takes the booking that claimed the
 * receipt's VAT away, and the payment waits as a task (tests/relink-no-model.test.ts). A receipt
 * still in beleg-import/ is archived by the link, as the model's match step would archive it (r9n-26).
 */
async function relink(kind: 'link' | 'unlink', body: unknown): Promise<{ ok: true; again: string[]; kept?: string[] }> {
  const { receiptId: receipt, transactionRef: payment, confirm } = linkBody(body);
  const change: BookChange = { kind, receipt, payment };
  const now = readBooks();
  // A booking without a payment (#89) is a person's and never booked again: only a payment's booking is kept or rebooked.
  const booked = kind === 'link' && now.transactions.some((t) => t.ref === payment) && now.journalEntries.some((e) => e.transactionRef === payment);
  const keep = booked && !(await modelReady());
  const { payments, file } = updateBooksWithEffects((books) => {
    if (kind === 'link') {
      if (!confirm) assertNotSecondPayment(books, receipt, payment);
      const had = books.journalEntries.filter((e) => e.transactionRef === payment);
      link(books, receipt, payment);
      const r = books.receipts.find((x) => x.id === receipt);
      if (r) archiveReceipt(WS, books, r);
      if (keep) return { payments: [] };
      const out = relinked(books, [change]);
      const gone = had.filter((e) => !books.journalEntries.includes(e));
      if (gone.length) recordReplaced(WS, payment, receipt, gone);
      return out;
    }
    // The invoice's PDF as the payment's receipt (invoice-reference): «Lösen» undoes the whole link, the allocation on the invoice included (r10c-3).
    if (books.mappings.some((m) => m.transactionRef === payment && m.receiptId === receipt && m.rule === 'invoice-reference')) releaseFromInvoice(books, payment, receipt);
    unlink(books, receipt, payment);
    const out = relinked(books, [change]);
    return restoreReplaced(books, payment, receipt) ? { ...out, payments: out.payments.filter((p) => p !== payment) } : out;
  });
  await closeAsksWithoutRule(engine(), WS);
  if (payments.length) await bookAgain(file ?? payment);
  return { ok: true, again: payments, ...(keep ? { kept: [payment] } : {}) };
}

/** The invoice whose PDF is `receipt` and that holds `payment`: the payment leaves it, with the link's bookings (src/invoices/payments.ts releasePayment). */
function releaseFromInvoice(books: Books, payment: string, receipt: string): void {
  const ctx = paymentContext(WS);
  if (!ctx) return;
  const invoices = loadInvoices(WS);
  const inv = liveInvoices(invoices).find((i) => i.status === 'issued' && i.payments.some((p) => p.transactionRef === payment) && ctx.receiptId(ctx.pdfOf(i)) === receipt);
  if (!inv) return;
  releasePayment(books, invoices, inv.id, payment, ctx);
  saveInvoices(WS, invoices);
}

router.post('/api/mapping/add', async (req, res) => {
  res.json(await relink('link', req.body));
});

router.post('/api/mapping/remove', async (req, res) => {
  res.json(await relink('unlink', req.body));
});
