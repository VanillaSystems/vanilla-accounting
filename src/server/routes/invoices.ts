/**
 * Invoicing (ADR 0010): contacts, drafts, issuing, sending, cancelling, credit notes, reminders,
 * comments, previews and the stored PDFs. Every change goes through src/invoices/service.ts; the
 * routes that book go through the write door: a payment confirmed by a person (withBooks and
 * assertOpen), and on the agreed basis issuing and cancelling, which book the document's VAT event
 * (src/invoices/events.ts) on its date, or on the first open day when its period is locked.
 */
import { Router, type Request } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WS, assertOpen, readBooks, receiptPath, refDates, reopenWorkspace, updateBooksWithEffects, RequestError } from '../books.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { allTerms } from '../../invoices/dated-values.js';
import { changeDated, contactChangeCard } from '../../invoices/dated-change.js';
import type { DatedWay } from '../../invoices/backdated.js';
import { InvoiceRuleError, liveDocuments, liveInvoices, type CreditRequest } from '../../invoices/rules.js';
import {
  addArticles, createArticle, liveArticles, removeArticle, updateArticle,
  addComment, answerQuote, backToDraft, cancelInvoice, changeAccounts, convertDocument, createContact, addContacts, createCreditNote, createDraft, createReminderDraft, deleteReminderDraft, planDunningRun, previewReminder, runDunning, updateReminderDraft, fileReceipts, findInvoice, issueInvoice, issuedPdf,
  missingOf, parseDraftPatch, paymentContext, previewHtml, recordSend, removeContact, removeDraft, reopenDocument, replacedPdf, sendPayToNotice, sendReminder, sentPdf, updateContact, updateDraft, viewOf,
  addDeductions, createStageInvoice, parseStages, sendInstalment, setStages,
} from '../../invoices/service.js';
import { liveContacts, payerIbans, proposeBusiness } from '../../invoices/contacts.js';
import { importContacts, previewContactImport, type ImportChoice } from '../../invoices/contact-import.js';
import { importArticles, previewArticleImport } from '../../invoices/article-import.js';
import { DEFAULT_UNITS } from '../../invoices/model.js';
import { loadKnowledge } from '../../knowledge/layers.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import {
  allocatePayment, allocationProposal, confirmPayment, paymentProposals, recordHandPayment, releasePayment, removeHandPayment, removeWriteOff, writeOffRest,
  type AllocationPart, type PaymentContext, type PaymentReleased,
} from '../../invoices/payments.js';
import type { InvoiceBook } from '../../invoices/model.js';
import { WRITE_OFF_REASONS, type Issued, type WriteOffReason } from '../../invoices/model.js';
import { openAmount } from '../../invoices/rules.js';
import { isIsoDate } from '../../accounting/periods.js';
import { bookInvoiceEvents, type EventOutcome } from '../../invoices/events.js';
import { agreedBasis, baseCurrency, chart } from '../../engines/index.js';
import { eventRef } from '../../books/refs.js';
import { applyAccountChange, planAccountChange, takeBackEvent, withAccounts, type AccountContext } from '../../invoices/revise.js';
import { creditNotesOf } from '../../invoices/rules.js';
import type { Invoice } from '../../invoices/model.js';
import { openDay } from '../../accounting/tax-point.js';
import { periodLock } from '../../books/store.js';
import type { Books } from '../../books/store.js';
import { recordReplaced, takeReplaced } from '../link-history.js';
import { bookAgain } from './automation.js';
import { checkMessage, sendMail } from '../../invoices/mail.js';
import { thisDevice } from '../../workspace/device.js';
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
  res.json({ today: day, invoices: liveDocuments(book).map((i) => viewOf(book, i, day, WS.invoicing?.shortfallLimit)), contacts: liveContacts(book), articles: liveArticles(book), sent: book.sent.filter((d) => !d.deleted) });
});

router.get('/api/invoices/sent', (_req, res) => {
  res.json(loadInvoices(WS).sent.filter((d) => !d.deleted).sort((a, b) => b.sentAt.localeCompare(a.sentAt)));
});

/** Incoming payments without a usable reference that could pay an open invoice, for a person to confirm. */
router.get('/api/invoices/payments', (_req, res) => {
  res.json({ proposals: paymentProposals(readBooks(), loadInvoices(WS)) });
});

/** The Ausziffern dialog of an incoming payment: its customer's open invoices and code's proposal (`?transactionRef=…&customerId=…`). */
router.get('/api/invoices/allocation', (req, res) => {
  const ref = String(req.query.transactionRef ?? '');
  const customerId = req.query.customerId === undefined ? undefined : String(req.query.customerId);
  res.json(allocationProposal(readBooks(), loadInvoices(WS), ref, customerId));
});

router.get('/api/invoices/:id', (req, res) => {
  const book = loadInvoices(WS);
  const inv = findInvoice(book, req.params.id);
  if (!inv) throw new RequestError(404, 'Rechnung nicht gefunden.');
  res.json({ ...viewOf(book, inv, today(), WS.invoicing?.shortfallLimit), sent: book.sent.filter((d) => d.invoiceId === inv.id && !d.deleted), missing: missingOf(WS, inv.id) });
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
  res.json(previewReminder(WS, req.params.id, String(req.query.date ?? today()), fee));
});

/** This computer, as Firma › Mahnwesen names the one the automatic reminders run on. */
router.get('/api/invoices/dunning/device', (_req, res) => {
  res.json({ here: thisDevice(WS) });
});

/** The Mahnlauf's list (spec 4.4.7): `?date=` the reference date, `&ids=a,b` the rows ticked in the table. */
router.get('/api/invoices/dunning/run', (req, res) => {
  const ids = typeof req.query.ids === 'string' && req.query.ids ? req.query.ids.split(',') : undefined;
  res.json(planDunningRun(WS, String(req.query.date ?? today()), ids));
});

router.get('/api/contacts', (_req, res) => {
  res.json(liveContacts(loadInvoices(WS)));
});

/**
 * A contact with the business file it names and the one code proposes for it (by UID, the IBANs that
 * paid its invoices, or its name), and the customers' business files a person may pick.
 */
router.get('/api/contacts/:id', (req, res) => {
  const book = loadInvoices(WS);
  const c = liveContacts(book).find((x) => x.id === req.params.id);
  if (!c) throw new InvoiceRuleError('contactGone', 'Diesen Kontakt gibt es nicht (mehr).');
  const { counterparties } = loadKnowledge(APP_ROOT, WS.paths.root);
  const proposal = proposeBusiness(c, counterparties, payerIbans(book, c.id, readBooks().transactions));
  const named = c.business ? counterparties.find((x) => x.id === c.business) : undefined;
  res.json({
    contact: c,
    ...(c.business ? { business: { id: c.business, name: named?.name ?? c.business, known: !!named } } : {}),
    ...(proposal ? { proposal } : {}),
    businesses: counterparties.filter((x) => x.roles.includes('customer') || x.role === 'customer').map((x) => ({ id: x.id, name: x.name })),
  });
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
/** A PDF the document was issued with before it went back to draft (Draft.replaced), `k` from 1. */
router.get('/api/invoices/:id/replaced/:file', (req, res, next) => {
  const m = /^(\d+)\.pdf$/.exec(req.params.file);
  if (!m) return next();
  res.type('application/pdf').send(replacedPdf(WS, req.params.id, Number(m[1])));
});
router.get('/invoices/sent/:file', (req, res, next) => {
  const m = /^(.+)\.pdf$/.exec(req.params.file);
  if (!m) return next();
  res.type('application/pdf').send(sentPdf(WS, m[1]));
});

// ─── contacts and drafts ───────────────────────────────────────────────────────

router.post('/api/contacts', (req, res) => {
  res.json(createContact(WS, req.body));
});

/**
 * A change of a contact; `validFrom` («gilt ab», absent: today) dates its addresses, terms, discount and
 * revenue account (spec 4.12). A day before issued documents that printed another address or other terms
 * answers with the card and saves nothing until `way: 'keep'` («So lassen»).
 */
router.patch('/api/contacts/:id', (req, res) => {
  const { validFrom, way, ...patch } = body(req) as Record<string, unknown> & { validFrom?: string; way?: string };
  const from = typeof validFrom === 'string' ? validFrom : today();
  const card = way === 'keep' ? undefined : contactChangeCard(WS, req.params.id, patch, from);
  if (card) return void res.json({ saved: false, ...card });
  res.json(updateContact(WS, req.params.id, patch, from));
});

/** «Ändern» with «gilt ab» on a dated value (spec 4.12): saved, or the card of the issued documents it covers until a way is named. */
router.post('/api/invoicing/dated', (req, res) => {
  const b = body(req);
  const out = changeDated(WS, { path: String(b.path ?? ''), value: b.value, validFrom: String(b.validFrom ?? ''), ...(typeof b.way === 'string' ? { way: b.way as DatedWay } : {}) });
  if (out.saved && String(b.path).startsWith('invoicing/')) reopenWorkspace();
  res.json(out);
});

/** Archived while a document names it, else deleted (spec 4.4.5); the answer says which. */
router.delete('/api/contacts/:id', (req, res) => {
  res.json(removeContact(WS, req.params.id));
});

/** A CSV of contacts read with a column mapping (the proposed one when none is sent): each row as it would be imported, with its problems and its duplicates. */
router.post('/api/contacts/import/preview', (req, res) => {
  const b = body(req);
  res.json(previewContactImport(String(b.csv ?? ''), b.mapping as Record<string, string> | undefined, liveContacts(loadInvoices(WS))));
});

/** The rows of the preview imported, each as its choice says (`new`, `same`: not again, `skip`). */
router.post('/api/contacts/import', (req, res) => {
  const b = body(req);
  const plan = importContacts(String(b.csv ?? ''), b.mapping as Record<string, string> | undefined, (b.choices ?? {}) as Record<string, ImportChoice>, liveContacts(loadInvoices(WS)));
  const made = addContacts(WS, plan.contacts);
  res.json({ created: made.length, skipped: plan.skipped, ids: made.map((c) => c.id) });
});

// ─── Artikel (spec 4.3, 4.4.3): invoices.json only, never the books ─────────────

router.get('/api/articles', (_req, res) => {
  res.json(liveArticles(loadInvoices(WS)));
});

router.post('/api/articles', (req, res) => {
  res.json(createArticle(WS, req.body));
});

router.patch('/api/articles/:id', (req, res) => {
  res.json(updateArticle(WS, req.params.id, req.body));
});

/** Archived while a document has a position from it, else deleted; the answer says which. */
router.delete('/api/articles/:id', (req, res) => {
  res.json(removeArticle(WS, req.params.id));
});

/** A CSV of Artikel read with a column mapping (the proposed one when none is sent): each row as it would be imported, with its problems and its duplicates by code. */
router.post('/api/articles/import/preview', (req, res) => {
  const b = body(req);
  res.json(previewArticleImport(String(b.csv ?? ''), b.mapping as Record<string, string> | undefined, liveArticles(loadInvoices(WS)), WS.invoicing?.units ?? DEFAULT_UNITS, today()));
});

router.post('/api/articles/import', (req, res) => {
  const b = body(req);
  const plan = importArticles(String(b.csv ?? ''), b.mapping as Record<string, string> | undefined, (b.choices ?? {}) as Record<string, ImportChoice>, liveArticles(loadInvoices(WS)), WS.invoicing?.units ?? DEFAULT_UNITS, today());
  const made = addArticles(WS, plan.articles);
  res.json({ created: made.length, skipped: plan.skipped, ids: made.map((a) => a.id) });
});

router.post('/api/invoices', (req, res) => {
  const { clear: _, ...patch } = parseDraftPatch(req.body, loadInvoices(WS), WS.invoicing?.units, undefined, WS.invoicing ? allTerms(WS.invoicing) : undefined);
  if (!patch.customerId) throw new RequestError(400, 'customerId fehlt.');
  res.json(createDraft(WS, { ...patch, customerId: patch.customerId }));
});

/** `confirm: 'stagesInvoiced'`: «Trotzdem ändern» over a changed total of an Auftrag whose Teilrechnungen are issued (spec 4.11). */
router.patch('/api/invoices/:id', (req, res) => {
  const { confirm, ...patch } = body(req);
  res.json(updateDraft(WS, req.params.id, parseDraftPatch(patch, loadInvoices(WS), WS.invoicing?.units, req.params.id, WS.invoicing ? allTerms(WS.invoicing) : undefined), confirms({ confirm })));
});

router.delete('/api/invoices/:id', (req, res) => {
  removeDraft(WS, req.params.id);
  res.json({ ok: true });
});

// ─── issuing, sending, correcting ──────────────────────────────────────────────

/** The VAT events of the issued documents the books do not carry yet, booked and their PDFs filed; nothing on the cash basis. */
function bookEvents(books: Books): EventOutcome | undefined {
  const ctx = paymentContext(WS);
  if (!ctx || !agreedBasis()) return undefined;
  const out = bookInvoiceEvents(books, loadInvoices(WS), ctx);
  fileReceipts(WS, books, out.files);
  return out;
}

/**
 * `{ confirm: 'unconfirmed' }`: the person's «Trotzdem ausstellen» over a position without text or amount (spec 4.11);
 * `sourceCancelled` over a draft whose Auftrag or Angebot was cancelled since. One code or a list; each confirms its own warning.
 */
router.post('/api/invoices/:id/issue', async (req, res) => {
  const confirm = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? confirms(req.body as Record<string, unknown>) : [];
  const issued = await issueInvoice(WS, req.params.id, { confirmed: confirm.includes('unconfirmed'), confirm });
  if (agreedBasis()) updateBooksWithEffects(bookEvents);
  res.json(issued);
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

/**
 * Storno. A paid invoice is a warning (spec 4.11, code `paid`): `confirm: 'paid'` («Trotzdem
 * stornieren») cancels it and releases its payments, which wait unmatched again; a payment of a
 * filed period stays as filed, so such a Storno is refused.
 */
router.post('/api/invoices/:id/cancel', async (req, res) => {
  const b = body(req);
  // «Trotzdem stornieren», each code its own warning: a paid Rechnung (`paid`), an Auftrag with a Lieferschein (`orderDelivered`) or drafts (`orderDrafts`).
  const confirm = confirms(b);
  const before = liveInvoices(loadInvoices(WS)).find((i): i is Issued => i.id === req.params.id && i.status === 'issued');
  const paid = confirm.includes('paid') ? before?.payments ?? [] : [];
  if (paid.length) assertOpen(readBooks(), paid.map((p) => p.date), 'mapping');
  const cancelled = await cancelInvoice(WS, req.params.id, {
    date: optText(b, 'date') ?? today(), reason: optText(b, 'reason') ?? '', notify: b.notify === true, to: optText(b, 'to'), confirm,
  }, { deliver: delivery(b) });
  const unbooked: string[] = [];
  if (paid.length) {
    const ctx = paymentContext(WS);
    if (!ctx) throw new RequestError(400, 'belege.workspace.yaml hat keinen invoicing-Block.');
    updateBooksWithEffects((books) => {
      assertOpen(books, paid.map((p) => p.date), 'mapping');
      const invoices = loadInvoices(WS);
      for (const p of paid) if (releaseOne(books, invoices, req.params.id, p.transactionRef, ctx).unbooked) unbooked.push(p.transactionRef);
      bookEvents(books);
      saveInvoices(WS, invoices);
    });
  } else if (agreedBasis()) updateBooksWithEffects(bookEvents);
  for (const ref of unbooked) await bookAgain(ref);
  res.json(cancelled);
});

// ─── phase 2: conversions, the customer's answer, back to draft (invoices.json only, never the books) ───

/** The confirmations a request carries: one code or a list (`confirm: ['expired', 'overOpen']`), each the person's «Trotzdem …». */
const confirms = (b: Record<string, unknown>): string[] => {
  const c = b.confirm;
  if (c === undefined) return [];
  if (typeof c === 'string') return [c];
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c as string[];
  throw new RequestError(400, 'confirm ist ein Code oder eine Liste von Codes.');
};

/**
 * «Auftrag erstellen», «Lieferschein erstellen», «Rechnung erstellen» (spec 4.4.1):
 * `{ to, lines: [{ line, quantity }], confirm? }`. Warns (409, `expired`, `declined`, `overOpen`)
 * unless `confirm` names the warning; the draft is a draft, so nothing is booked.
 */
router.post('/api/invoices/:id/convert', (req, res) => {
  const b = body(req);
  if (!Array.isArray(b.lines)) throw new RequestError(400, 'lines: eine Liste { line, quantity }.');
  const lines = (b.lines as unknown[]).map((x, i) => {
    const p = (x ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(p.line) || typeof p.quantity !== 'number' || !Number.isFinite(p.quantity)) throw new RequestError(400, `lines[${i}]: { line, quantity } mit Zahlen.`);
    return { line: p.line as number, quantity: p.quantity as number };
  });
  res.json(convertDocument(WS, req.params.id, { to: String(b.to ?? '') as never, lines, confirm: confirms(b) }));
});

/** The customer's answer to an Angebot: `{ answer: 'accepted' | 'declined' | null, date? }` (today by default). */
router.post('/api/invoices/:id/answer', (req, res) => {
  const b = body(req);
  if (b.answer !== null && b.answer !== 'accepted' && b.answer !== 'declined') throw new RequestError(400, 'answer ist accepted, declined oder null.');
  res.json(answerQuote(WS, req.params.id, b.answer as 'accepted' | 'declined' | null, WS.company.owner, optText(b, 'date') ?? today()));
});

router.post('/api/invoices/:id/credit-note', (req, res) => {
  const b = body(req);
  const settlement = optText(b, 'settlement');
  if (settlement !== undefined && settlement !== 'refund' && settlement !== 'offset') throw new RequestError(400, 'settlement ist refund oder offset.');
  const credit: CreditRequest = { reason: optText(b, 'reason') ?? '', ...(b.amount !== undefined ? { amount: optNumber(b, 'amount') } : {}), ...(settlement ? { settlement } : {}) };
  res.json(createCreditNote(WS, req.params.id, credit));
});

/** «Zahlungsaufforderung mit neuer IBAN» (spec 4.12): mailed with `email`, else downloaded; kept in the sent log. */
router.post('/api/invoices/:id/notices', async (req, res) => {
  const b = body(req);
  res.json(await sendPayToNotice(WS, req.params.id, { date: optText(b, 'date'), to: optText(b, 'to') }, { deliver: delivery(b) }));
});

/** A Mahnung's changes in a body: null takes the fee or the interest off. */
const reminderPatch = (b: Record<string, unknown>) => ({
  date: optText(b, 'date'), dueDate: optText(b, 'dueDate'), title: optText(b, 'title'), intro: optText(b, 'intro'), closing: optText(b, 'closing'),
  ...(b.fee === null ? { fee: null } : { fee: optNumber(b, 'fee') }), ...(b.interest === null ? { interest: null } : { interest: optNumber(b, 'interest') }),
});

/** Sends the Mahnung: the draft as written (with what the body still changes), else the next level written now. */
router.post('/api/invoices/:id/reminders', async (req, res) => {
  const b = body(req);
  res.json(await sendReminder(WS, req.params.id, { ...reminderPatch(b), to: optText(b, 'to') }, { deliver: delivery(b) }));
});

/** «Mahnen»: the next Mahnung written and kept as a draft until it is sent or deleted. */
router.post('/api/invoices/:id/reminders/draft', (req, res) => {
  const b = body(req);
  res.json(createReminderDraft(WS, req.params.id, { date: optText(b, 'date'), fee: optNumber(b, 'fee') }));
});
router.patch('/api/invoices/:id/reminders/draft', (req, res) => {
  res.json(updateReminderDraft(WS, req.params.id, reminderPatch(body(req))));
});
/** Deletes the unsent Mahnung, which takes its level back; a sent one is kept as sent. */
router.delete('/api/invoices/:id/reminders/draft', (req, res) => {
  res.json(deleteReminderDraft(WS, req.params.id));
});

/** «Senden» of the Mahnlauf, after its one confirmation: `{ date, ids }`. */
router.post('/api/invoices/dunning/run', async (req, res) => {
  const b = body(req);
  const date = optText(b, 'date') ?? today();
  if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string')) throw new RequestError(400, 'ids: die Rechnungen, die gemahnt werden.');
  res.json(await runDunning(WS, { date, ids: b.ids as string[] }));
});

// ─── phase 3: Teilrechnungsplan, Schlussrechnung, Rückbehalt (invoices.json only, never the books) ───

/** The Teilrechnungsplan of an Auftrag: `{ stages: [{ label, percent? | amount?, date? }] }`; an empty list removes it. */
router.put('/api/invoices/:id/stages', (req, res) => {
  res.json(setStages(WS, req.params.id, parseStages(body(req).stages)));
});

/**
 * The Rechnung of a stage: `{ stage: <index> }` a Teilrechnung draft (the last stage the Schlussrechnung),
 * `{ stage: 'final' }` «Schlussrechnung erstellen»; `confirm: 'partialDrafts'` over a Teilrechnung still a draft.
 */
router.post('/api/invoices/:id/stage-invoice', (req, res) => {
  const b = body(req);
  if (b.stage !== 'final' && !Number.isInteger(b.stage)) throw new RequestError(400, 'stage ist die Nummer einer Stufe (ab 0) oder final.');
  res.json(createStageInvoice(WS, req.params.id, b.stage as number | 'final', confirms(b)));
});

/** «Akontos abziehen» on a Schlussrechnung draft: `{ ids: [<Teilrechnung id>] }`. */
router.post('/api/invoices/:id/deductions', (req, res) => {
  const b = body(req);
  if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string')) throw new RequestError(400, 'ids ist eine Liste von Teilrechnungen.');
  res.json(addDeductions(WS, req.params.id, b.ids as string[]));
});

/** «Zahlungsaufforderung» of a retention: `{ date?, intro?, closing?, to?, email? }`; recorded as sent, nothing booked. */
router.post('/api/invoices/:id/instalment', async (req, res) => {
  const b = body(req);
  res.json(await sendInstalment(WS, req.params.id, { date: optText(b, 'date'), intro: optText(b, 'intro'), closing: optText(b, 'closing'), to: optText(b, 'to') }, { deliver: delivery(b) }));
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
  res.json(updateBooksWithEffects((books) => {
    assertOpen(books, books.transactions.filter((t) => t.ref === transactionRef).map((t) => t.date), 'mapping');
    bookEvents(books);
    const invoices = loadInvoices(WS);
    const result = confirmPayment(books, invoices, req.params.id, transactionRef, ctx);
    fileReceipts(WS, books, result.files);
    saveInvoices(WS, invoices);
    // What the link replaced waits beside the books for «Lösen» (r10c-3).
    const inv = liveInvoices(invoices).find((i) => i.id === req.params.id);
    if (result.replaced?.length && inv?.status === 'issued') recordReplaced(WS, transactionRef, ctx.receiptId(ctx.pdfOf(inv)), result.replaced);
    return { paid: result.paid };
  }));
});

/**
 * «Lösen» on the invoice (r10c-3): the payment leaves it, the link's bookings go, and what the link
 * replaced is booked again (src/server/link-history.ts); a payment left without a booking is handed
 * to the booking run. The undo is the link again (POST …/payments).
 */
router.delete('/api/invoices/:id/payments/:ref', async (req, res) => {
  const ctx = paymentContext(WS);
  if (!ctx) throw new RequestError(400, 'belege.workspace.yaml hat keinen invoicing-Block.');
  const ref = req.params.ref;
  let unbooked = false;
  const out = updateBooksWithEffects((books): Omit<PaymentReleased, 'files'> => {
    assertOpen(books, books.transactions.filter((t) => t.ref === ref).map((t) => t.date), 'mapping');
    const invoices = loadInvoices(WS);
    const released = releaseOne(books, invoices, req.params.id, ref, ctx);
    saveInvoices(WS, invoices);
    unbooked = released.unbooked;
    return released.result;
  });
  if (unbooked) await bookAgain(ref);
  res.json(out);
});

/** Where the bookings an Ausziffern replaced wait beside the books: they belong to the payment, not to one of its invoices. */
const ALLOCATION = 'allocation';

/**
 * One document's part of a payment released (`releasePayment`), its receipts filed. What the link
 * or the Ausziffern replaced comes back only when the last allocation leaves the payment, and only
 * then is the payment without a booking (`unbooked`: the caller hands it to the booking run).
 */
function releaseOne(books: Books, invoices: InvoiceBook, invoiceId: string, ref: string, ctx: PaymentContext): { result: Omit<PaymentReleased, 'files'>; unbooked: boolean } {
  const inv = liveInvoices(invoices).find((i) => i.id === invoiceId);
  const last = !liveInvoices(invoices).some((i) => i.id !== invoiceId && i.status === 'issued' && i.payments.some((p) => p.transactionRef === ref));
  const restore = last && inv?.status === 'issued' ? takeReplaced(WS, ref, ctx.receiptId(ctx.pdfOf(inv))) ?? takeReplaced(WS, ref, ALLOCATION) : undefined;
  const { files, ...result } = releasePayment(books, invoices, invoiceId, ref, ctx, restore);
  fileReceipts(WS, books, files);
  return { result, unbooked: last && !books.journalEntries.some((e) => e.transactionRef === ref) };
}

// ─── Zahlungseingang by hand, write-offs, Ausziffern (spec 4.4.6) ──────────────

const needContext = () => {
  const ctx = paymentContext(WS);
  if (!ctx) throw new RequestError(400, 'belege.workspace.yaml hat keinen invoicing-Block.');
  return ctx;
};
const isoField = (b: Record<string, unknown>, k: string): string | undefined => {
  const v = optText(b, k);
  if (v !== undefined && !isIsoDate(v)) throw new RequestError(400, `${k} ist ein Datum JJJJ-MM-TT.`);
  return v;
};

/** «Zahlungseingang erfassen»: `{ date, account, amount }`, a hand movement on that money account, allocated and booked (P1.7). */
router.post('/api/invoices/:id/hand-payments', (req, res) => {
  const b = body(req);
  const date = isoField(b, 'date') ?? today();
  const account = optText(b, 'account');
  const amount = optNumber(b, 'amount');
  if (!account || amount === undefined) throw new RequestError(400, 'account und amount sind nötig.');
  const ctx = needContext();
  res.json(updateBooksWithEffects((books) => {
    assertOpen(books, [date], 'newTransaction');
    bookEvents(books);
    const invoices = loadInvoices(WS);
    const { transaction, allocation, files } = recordHandPayment(books, invoices, req.params.id, { date, account, amount }, ctx);
    fileReceipts(WS, books, files);
    saveInvoices(WS, invoices);
    return { transaction, allocation };
  }));
});

/** «Rückgängig» on a Zahlungseingang by hand: its movement, bookings and allocation go (open period only). */
router.delete('/api/invoices/:id/hand-payments/:ref', (req, res) => {
  const ctx = needContext();
  const ref = req.params.ref;
  res.json(updateBooksWithEffects((books) => {
    assertOpen(books, books.transactions.filter((t) => t.ref === ref).map((t) => t.date), 'deleteTransaction');
    const invoices = loadInvoices(WS);
    const { files, allocation } = removeHandPayment(books, invoices, req.params.id, ref, ctx);
    fileReceipts(WS, books, files);
    saveInvoices(WS, invoices);
    return { allocation };
  }));
});

/**
 * «Rest ausbuchen»: `{ reason, date?, amount?, note?, confirm? }`, today and what is open by
 * default; more than is open is a warning (`aboveOpen`) unless `confirm: 'aboveOpen'`.
 */
router.post('/api/invoices/:id/write-offs', (req, res) => {
  const b = body(req);
  const reason = optText(b, 'reason') as WriteOffReason | undefined;
  if (!reason || !WRITE_OFF_REASONS.includes(reason)) throw new RequestError(400, `reason ist eines von ${WRITE_OFF_REASONS.join(', ')}.`);
  const date = isoField(b, 'date') ?? today();
  const note = optText(b, 'note')?.trim();
  const ctx = needContext();
  const out = updateBooksWithEffects((books) => {
    assertOpen(books, [date], 'newEntry');
    bookEvents(books);
    const invoices = loadInvoices(WS);
    const inv = liveInvoices(invoices).find((i) => i.id === req.params.id);
    const amount = optNumber(b, 'amount') ?? (inv ? openAmount(inv, liveInvoices(invoices)) : 0);
    const files: Array<{ filename: string; pdf: Buffer }> = [];
    const result = writeOffRest(books, invoices, req.params.id, { date, amount, reason, ...(note ? { note } : {}), by: 'person' }, ctx, { files }, b.confirm === 'aboveOpen');
    fileReceipts(WS, books, files);
    saveInvoices(WS, invoices);
    return result;
  });
  res.json(out);
});

/** «Rückgängig» on a write-off: it leaves the invoice, its entries go (open period only). */
router.delete('/api/invoices/:id/write-offs/:wo', (req, res) => {
  res.json(updateBooksWithEffects((books) => {
    const invoices = loadInvoices(WS);
    const inv = liveInvoices(invoices).find((i): i is Issued => i.id === req.params.id && i.status === 'issued');
    const w = inv?.writeOffs?.find((x) => x.id === req.params.wo);
    if (w) assertOpen(books, [w.date, ...books.journalEntries.filter((e) => e.transactionRef === `RE-${inv!.number}-${w.id}`).map((e) => e.date)], 'deleteEntry');
    const writeOff = removeWriteOff(books, invoices, req.params.id, req.params.wo);
    saveInvoices(WS, invoices);
    return { writeOff };
  }));
});


/** «Buchen» of the Ausziffern dialog: `{ transactionRef, parts: [{ invoiceId, amount, rest? }] }`, every allocation and write-off at once. */
router.post('/api/invoices/allocation', (req, res) => {
  const b = body(req);
  const ref = optText(b, 'transactionRef');
  if (!ref || !Array.isArray(b.parts)) throw new RequestError(400, 'transactionRef und parts sind nötig.');
  const parts = (b.parts as unknown[]).map((raw): AllocationPart => {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (typeof p.invoiceId !== 'string' || typeof p.amount !== 'number' || !Number.isFinite(p.amount)) throw new RequestError(400, 'Ein Teil ist { invoiceId, amount, rest? }.');
    if (p.rest !== undefined && !WRITE_OFF_REASONS.includes(p.rest as WriteOffReason)) throw new RequestError(400, `rest ist eines von ${WRITE_OFF_REASONS.join(', ')}.`);
    return { invoiceId: p.invoiceId, amount: p.amount, ...(p.rest !== undefined ? { rest: p.rest as WriteOffReason } : {}) };
  });
  const ctx = needContext();
  const out = updateBooksWithEffects((books) => {
    assertOpen(books, books.transactions.filter((t) => t.ref === ref).map((t) => t.date), 'mapping');
    bookEvents(books);
    const invoices = loadInvoices(WS);
    const result = allocatePayment(books, invoices, ref, parts, ctx);
    fileReceipts(WS, books, result.files);
    saveInvoices(WS, invoices);
    // What the allocation replaced waits beside the books for the last «Lösen» (r10c-3): it belongs to the payment.
    if (result.replaced?.length) recordReplaced(WS, ref, ALLOCATION, result.replaced);
    return { paid: result.paid };
  });
  res.json(out);
});

// ─── back to draft, Konten ändern (spec 4.4.2) ─────────────────────────────────

/**
 * «Zurück zum Entwurf»: an issued document never sent, with nothing received, credited or written
 * off, becomes a draft and keeps its number. A sent one is refused (`sent`, MWSTG Art. 27 Abs. 2): a
 * Gutschrift or a Storno corrects it. Its VAT event (the agreed basis) comes off the books first,
 * refused while it lies in a filed period (403), with the receipt its PDF became.
 * An Angebot or Auftrag takes the same way and books nothing: once sent it warns (`sentVersion`), and
 * `confirm: 'sentVersion'` is «Trotzdem bearbeiten»; the version sent stays in the sent log as it went out.
 */
router.post('/api/invoices/:id/draft', async (req, res) => {
  const doc = findInvoice(loadInvoices(WS), req.params.id);
  if (doc && (doc.kind === 'quote' || doc.kind === 'sales-order')) {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    res.json(reopenDocument(WS, req.params.id, confirms(b).includes('sentVersion')));
    return;
  }
  const ctx = paymentContext(WS);
  res.json(await backToDraft(WS, req.params.id, {
    books: (inv) => {
      const ref = eventRef(inv, 'issue');
      // Its event (the agreed basis), or the receipt a payment matched and released again left (the cash basis).
      const now = readBooks();
      if (!ctx || (!now.journalEntries.some((e) => e.transactionRef === ref) && !now.receipts.some((r) => r.id === ctx.receiptId(ctx.pdfOf(inv))))) return [];
      return updateBooksWithEffects((books) => {
        assertOpen(books, refDates(books, ref), 'deleteEntry');
        const { receipts } = takeBackEvent(books, inv, ctx.receiptId(ctx.pdfOf(inv)));
        return receipts.map((r) => receiptPath(books, r));
      });
    },
  }));
});

const accountContext = (): AccountContext => {
  const s = WS.invoicing;
  if (!s) throw new RequestError(400, 'belege.workspace.yaml hat keinen invoicing-Block.');
  return { revenueAccount: s.revenueAccount, isRevenue: (a) => chart().typeOf(a) === 'revenue', base: baseCurrency() };
};

/** `{ lines: [{ line, account }], date? }`: the positions' new revenue accounts, and the day a reclassification takes (today by default). */
function accountRequest(req: Request): { lines: Array<{ line: number; account: string }>; date?: string } {
  const b = body(req);
  if (!Array.isArray(b.lines)) throw new RequestError(400, 'lines: [{ line, account }] erwartet.');
  const lines = (b.lines as unknown[]).map((raw) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(l.line) || typeof l.account !== 'string') throw new RequestError(400, 'Eine Zeile ist { line, account }.');
    return { line: l.line as number, account: l.account };
  });
  return { lines, date: isoField(b, 'date') };
}

/** What «Konten ändern» would book, nothing written: the dialog shows it. */
router.post('/api/invoices/:id/accounts/plan', (req, res) => {
  const { lines, date } = accountRequest(req);
  const ctx = accountContext();
  const books = readBooks();
  const invoices = liveInvoices(loadInvoices(WS));
  const inv = invoices.find((i): i is Issued => i.id === req.params.id && i.status === 'issued');
  if (!inv) throw new RequestError(404, 'Keine ausgestellte Rechnung mit dieser Id.');
  res.json(planAccountChange(books, inv, withAccounts(inv, lines, ctx), date ?? openDay(periodLock(books), today()), ctx, invoices));
});

/**
 * «Konten ändern» on an issued invoice: the positions' revenue accounts, never an amount, a rate or a
 * code; its credit notes' positions follow. Its bookings of an open period change account; for those
 * of a filed period a reclassification without a code is booked on `date` (an open day: else 403).
 * The books first, then the documents (src/invoices/service.ts changeAccounts). The PDFs stay as issued.
 */
router.post('/api/invoices/:id/accounts', async (req, res) => {
  const { lines, date: asked } = accountRequest(req);
  const ctx = accountContext();
  const pay = paymentContext(WS);
  const book = (from: Issued, to: Issued, invoices: readonly Invoice[], date?: string) => updateBooksWithEffects((books) => {
    const day = date ?? openDay(periodLock(books), today());
    assertOpen(books, [day], 'newEntry');
    const plan = planAccountChange(books, from, to, day, ctx, invoices);
    if (!plan.lines.length) return plan;
    assertOpen(books, plan.rebook.filter((r) => !r.filed).map((r) => r.date), 'editEntry');
    const docs = [from, ...creditNotesOf(from, invoices)];
    applyAccountChange(books, docs, plan, ctx, (n) => { const d = docs.find((x) => x.number === n); return d && pay ? pay.receiptId(pay.pdfOf(d)) : undefined; });
    return plan;
  });
  res.json(await changeAccounts(WS, req.params.id, lines, ctx, {
    books: (inv, next, invoices) => book(inv, next, invoices, asked),
    undo: (plan, now, before, invoices) => { book(now, before, invoices, plan.reclass[0]?.date); },
  }));
});
