/**
 * Invoicing (ADR 0010): customers, drafts, issuing, sending, cancelling, credit notes, reminders,
 * comments, previews and the stored PDFs. Every change goes through src/invoices/service.ts; the
 * one route that books (a payment confirmed by a person) goes through withBooks and assertOpen.
 */
import { Router, type Request } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WS, assertOpen, readBooks, withBooks, RequestError } from '../books.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { liveCustomers, liveInvoices, type CreditRequest } from '../../invoices/rules.js';
import {
  addComment, cancelInvoice, createCreditNote, createCustomer, createDraft, draftReminder, fileReceipts, findInvoice, issueInvoice, issuedPdf,
  missingOf, parseCustomer, parseDraftPatch, paymentContext, previewHtml, recordSend, removeDraft, sendReminder, sentPdf, updateCustomer, updateDraft, viewOf,
} from '../../invoices/service.js';
import { confirmPayment, paymentProposals } from '../../invoices/payments.js';
import { checkMessage, sendMail } from '../../invoices/mail.js';
import type { Deliver } from '../../invoices/service.js';

export const router = Router();

const today = () => new Date().toISOString().slice(0, 10);
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new RequestError(400, 'JSON-Objekt erwartet.');
  return req.body as Record<string, unknown>;
};
const optText = (b: Record<string, unknown>, k: string): string | undefined => {
  if (b[k] === undefined) return undefined;
  if (typeof b[k] !== 'string') throw new RequestError(400, `${k} muss ein Text sein.`);
  return b[k] as string;
};
const optNumber = (b: Record<string, unknown>, k: string): number | undefined => {
  if (b[k] === undefined) return undefined;
  if (typeof b[k] !== 'number') throw new RequestError(400, `${k} muss eine Zahl sein.`);
  return b[k] as number;
};

// ─── reading ───────────────────────────────────────────────────────────────────

router.get('/api/invoices', (_req, res) => {
  const book = loadInvoices(WS);
  const day = today();
  res.json({ today: day, invoices: liveInvoices(book).map((i) => viewOf(book, i, day)), customers: liveCustomers(book), sent: book.sent.filter((d) => !d.deleted) });
});

router.get('/api/invoices/sent', (_req, res) => {
  res.json(loadInvoices(WS).sent.filter((d) => !d.deleted).sort((a, b) => b.sentAt.localeCompare(a.sentAt)));
});

/** Incoming payments without a usable reference that could pay an open invoice, for a person to confirm. */
router.get('/api/invoices/payments', (_req, res) => {
  res.json({ proposals: paymentProposals(readBooks(), loadInvoices(WS)) });
});

router.get('/api/invoices/:id', (req, res) => {
  const book = loadInvoices(WS);
  const inv = findInvoice(book, req.params.id);
  if (!inv) throw new RequestError(404, 'Rechnung nicht gefunden.');
  res.json({ ...viewOf(book, inv, today()), sent: book.sent.filter((d) => d.invoiceId === inv.id && !d.deleted), missing: missingOf(WS, inv.id) });
});

router.get('/api/invoices/:id/preview', async (req, res) => {
  const reminder = req.query.reminder !== undefined
    ? { date: String(req.query.date ?? today()), ...(req.query.fee !== undefined ? { fee: Number(req.query.fee) } : {}) }
    : undefined;
  const { html } = await previewHtml(WS, req.params.id, reminder ? { reminder } : {});
  res.type('html').send(html);
});

router.get('/api/invoices/:id/reminder', (req, res) => {
  const fee = req.query.fee === undefined ? undefined : Number(req.query.fee);
  res.json(draftReminder(WS, req.params.id, String(req.query.date ?? today()), fee));
});

router.get('/api/customers', (_req, res) => {
  res.json(liveCustomers(loadInvoices(WS)));
});

router.get('/api/customers/:id', (req, res) => {
  const book = loadInvoices(WS);
  const c = liveCustomers(book).find((x) => x.id === req.params.id);
  if (!c) throw new RequestError(404, 'Kunde nicht gefunden.');
  res.json({ ...c, invoices: liveInvoices(book).filter((i) => i.customerId === c.id).map((i) => viewOf(book, i, today())) });
});

/** A logo an invoice is laid out with: the layout's, or one an issued invoice froze; no other file. */
router.get('/api/invoice-logo', (req, res) => {
  const path = String(req.query.path ?? '');
  const known = new Set([WS.invoicing?.layout.logo, ...loadInvoices(WS).invoices.map((i) => (i.status === 'issued' ? i.layout.logo : undefined))]);
  const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[path.split('.').pop()?.toLowerCase() ?? ''];
  const file = join(WS.paths.root, path);
  if (!path || !known.has(path) || !type || !existsSync(file)) throw new RequestError(404, 'Logo nicht gefunden.');
  res.type(type).send(readFileSync(file));
});

/** The PDF exactly as issued (an invoice or credit note), or a sent reminder or notice exactly as sent. */
router.get('/invoices/:file', (req, res, next) => {
  const m = /^(.+)\.pdf$/.exec(req.params.file);
  if (!m) return next();
  res.type('application/pdf').send(issuedPdf(WS, m[1]));
});
router.get('/invoices/sent/:file', (req, res, next) => {
  const m = /^(.+)\.pdf$/.exec(req.params.file);
  if (!m) return next();
  res.type('application/pdf').send(sentPdf(WS, m[1]));
});

// ─── customers and drafts ──────────────────────────────────────────────────────

router.post('/api/customers', (req, res) => {
  res.json(createCustomer(WS, parseCustomer(req.body, false)));
});

router.patch('/api/customers/:id', (req, res) => {
  res.json(updateCustomer(WS, req.params.id, parseCustomer(req.body, true)));
});

router.post('/api/invoices', (req, res) => {
  const { clear: _, ...patch } = parseDraftPatch(req.body, loadInvoices(WS));
  if (!patch.customerId) throw new RequestError(400, 'customerId fehlt.');
  res.json(createDraft(WS, { ...patch, customerId: patch.customerId }));
});

router.patch('/api/invoices/:id', (req, res) => {
  res.json(updateDraft(WS, req.params.id, parseDraftPatch(req.body, loadInvoices(WS))));
});

router.delete('/api/invoices/:id', (req, res) => {
  removeDraft(WS, req.params.id);
  res.json({ ok: true });
});

// ─── issuing, sending, correcting ──────────────────────────────────────────────

router.post('/api/invoices/:id/issue', async (req, res) => {
  res.json(await issueInvoice(WS, req.params.id));
});

/** `email: { to, subject, body }` sends it through the company's mailbox; without, it is recorded as downloaded. */
function delivery(b: Record<string, unknown>): Deliver | undefined {
  if (b.email === undefined) return undefined;
  const e = b.email;
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new RequestError(400, 'email: { to, subject, body } erwartet.');
  const m = e as Record<string, unknown>;
  const message = checkMessage({ to: optText(m, 'to') ?? '', subject: optText(m, 'subject') ?? '', body: optText(m, 'body') ?? '' });
  return ({ filename, pdf }) => sendMail(WS, message, { filename, content: pdf });
}

router.post('/api/invoices/:id/send', async (req, res) => {
  const b = body(req);
  res.json(await recordSend(WS, req.params.id, { to: optText(b, 'to'), deliver: delivery(b) }));
});

router.post('/api/invoices/:id/cancel', async (req, res) => {
  const b = body(req);
  res.json(await cancelInvoice(WS, req.params.id, {
    date: optText(b, 'date') ?? today(), reason: optText(b, 'reason') ?? '', notify: b.notify === true, to: optText(b, 'to'),
  }, { deliver: delivery(b) }));
});

router.post('/api/invoices/:id/credit-note', (req, res) => {
  const b = body(req);
  const settlement = optText(b, 'settlement');
  if (settlement !== undefined && settlement !== 'refund' && settlement !== 'offset') throw new RequestError(400, 'settlement ist refund oder offset.');
  const credit: CreditRequest = { reason: optText(b, 'reason') ?? '', ...(b.amount !== undefined ? { amount: optNumber(b, 'amount') } : {}), ...(settlement ? { settlement } : {}) };
  res.json(createCreditNote(WS, req.params.id, credit));
});

router.post('/api/invoices/:id/reminders', async (req, res) => {
  const b = body(req);
  res.json(await sendReminder(WS, req.params.id, {
    date: optText(b, 'date'), fee: optNumber(b, 'fee'), intro: optText(b, 'intro'), closing: optText(b, 'closing'), to: optText(b, 'to'),
  }, { deliver: delivery(b) }));
});

router.post('/api/invoices/:id/comments', (req, res) => {
  res.json(addComment(WS, req.params.id, optText(body(req), 'text') ?? '', WS.company.owner));
});

/** A person confirms that an incoming payment pays the invoice: allocated, and its revenue booked from the invoice. */
router.post('/api/invoices/:id/payments', (req, res) => {
  const transactionRef = optText(body(req), 'transactionRef');
  if (!transactionRef) throw new RequestError(400, 'transactionRef fehlt.');
  const ctx = paymentContext(WS);
  if (!ctx) throw new RequestError(400, 'belege.workspace.yaml hat keinen invoicing-Block.');
  withBooks(res, (books) => {
    assertOpen(books, books.transactions.filter((t) => t.ref === transactionRef).map((t) => t.date), 'mapping');
    const invoices = loadInvoices(WS);
    const result = confirmPayment(books, invoices, req.params.id, transactionRef, ctx);
    fileReceipts(WS, books, result.files);
    saveInvoices(WS, invoices);
    return { paid: result.paid };
  });
});
