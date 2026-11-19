/**
 * Invoicing on a workspace: every change to invoices.json and the invoice PDFs goes through
 * here, so the API, agents and CLIs apply the same rules (src/invoices/rules.ts). The changes that
 * print a PDF are asynchronous; they run one at a time in this process, so a number is never
 * given twice and nothing saves over another change.
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { parseUid } from '../workspace/uid.js';
import { basename, dirname, extname, join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { receiptFile, type Books } from '../books/store.js';
import { defaultTexts, draftDays, issuedIntro, issuedSheet, reminderSheet, senderFor, sheetOf, type InvoicingContext } from './documents.js';
import {
  INVOICE_CURRENCIES, INVOICE_LANGUAGES, DEFAULT_LAYOUT, DEFAULT_SHORTFALL_LIMIT, DEFAULT_UNITS, LINE_KINDS, PRICES, isItem, type UnitDef,
  type Comment, type Customer, type CustomerFields, type Draft, type Invoice, type InvoiceBook, type InvoiceContent,
  type AccountChange, type InvoiceLine, type Issued, type PaymentTerms, type Reminder, type SentDocument, type SentKind,
} from './model.js';
import { renderHtml, renderPdf, type Rendered } from './pdf.js';
import {
  InvoiceRuleError, asDraft, assertCreditWithinOpen, backToDraftRefusal, cancel, creditNoteDraft, deleteDraft, figures, isOverdue, issue, liveCustomers, liveInvoices, missingForIssue,
  openAmount, reminderDraft, shortfallOf, skontoOffer, status, totals, writeOffAccounts,
  type CreditRequest, type Figures, type InvoiceRefusal, type InvoiceStatus, type Missing, type Totals,
} from './rules.js';
import type { SheetData } from './sheet.js';
import { loadInvoices, newEnvelope, readPdf, sha256, storePdf, updateInvoices, writeAtomic } from './store.js';
import type { PaymentContext, PaymentOutcome } from './payments.js';
import { notesWithAccounts, withAccounts, type AccountChangePlan, type AccountContext } from './revise.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { creditNoteStatus, type CreditListStatus } from './lists.js';
import { TEXTS } from './texts.js';
import { baseCurrency, invoiceActivities, invoiceRates, invoicing } from '../engines/index.js';
import { openItemAccounts } from '../accounting/tax-point.js';
import { heldByReconciliation } from '../books/reconcile.js';
import { accountsOf } from '../workspace/reads.js';
import { accountName, setAccountName } from '../workspace/accounts-write.js';
import { standardAccounts } from '../workspace/chart.js';

export interface Printer {
  pdf(d: SheetData, at: string): Promise<Rendered & { pdf: Buffer }>;
  html(d: SheetData): Promise<Rendered>;
}
const chromium: Printer = { pdf: renderPdf, html: renderHtml };

/** An invoice with what lists show: its status, totals and what is open. */
export type InvoiceView = Invoice & { view: {
  status: InvoiceStatus; overdue: boolean; totals: Totals; open: number; customerName: string;
  /** An issued invoice's four figures (spec 4.8). */
  figures?: Figures;
  /** A credit note's state: Offen, Teilweise, Abgerechnet. */
  creditStatus?: CreditListStatus;
  /** A rest of at most the shortfall limit after a payment: proposed to write off as fees. */
  shortfall?: { amount: number; limit: number };
  /** The Skonto the printed terms offer: its amount, the last day and what the customer pays then. */
  skonto?: { amount: number; until: string; pays: number };
} };

let queue: Promise<unknown> = Promise.resolve();
/**
 * Runs `fn` after every printing change already queued in this process. A printing change reads
 * the book, prints, then commits to the book as it is by then (`commit`), so a change made while
 * it printed is kept.
 */
function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const notFound = (what: string): never => { throw new InvoiceRuleError('notFound', `${what} nicht gefunden.`); };

export function invoicingContext(ws: Workspace): InvoicingContext {
  return { company: ws.company, settings: ws.invoicing };
}

/** The logo as a data: URI, so the PDF needs no file access. */
export function logoSrc(ws: Workspace, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const file = join(ws.paths.root, path);
  if (!existsSync(file)) return undefined;
  const type = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(file).toLowerCase()];
  return type ? `data:${type};base64,${readFileSync(file).toString('base64')}` : undefined;
}

export function viewOf(book: InvoiceBook, inv: Invoice, today: string, shortfallLimit = DEFAULT_SHORTFALL_LIMIT): InvoiceView {
  const invoices = liveInvoices(book);
  const customerName = inv.status === 'issued' ? inv.customer.name : book.customers.find((c) => c.id === inv.customerId)?.name ?? '';
  const issued = inv.status === 'issued' ? inv : undefined;
  const short = issued && shortfallOf(issued, invoices, shortfallLimit, baseCurrency());
  const skonto = issued && !issued.cancelled && openAmount(issued, invoices) > 0 && !issued.payments.length ? skontoOffer(issued) : undefined;
  return { ...inv, view: {
    status: status(inv, invoices), overdue: isOverdue(inv, invoices, today), totals: totals(inv), open: openAmount(inv, invoices), customerName,
    ...(issued ? { figures: figures(issued, invoices) } : {}),
    ...(issued?.kind === 'credit-note' && !issued.cancelled ? { creditStatus: creditNoteStatus(issued, invoices) } : {}),
    ...(short ? { shortfall: { amount: short, limit: shortfallLimit } } : {}),
    ...(skonto ? { skonto } : {}),
  } };
}

export function findInvoice(book: InvoiceBook, idOrNumber: string): Invoice | undefined {
  return liveInvoices(book).find((i) => i.id === idOrNumber || (i.status === 'issued' && i.number === idOrNumber));
}

// ─── validation at the boundary ───────────────────────────────────────────────

const isText = (v: unknown): v is string => typeof v === 'string';
const isDate = (v: unknown): v is string => isText(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const bad = (msg: string, missing?: Missing[]): never => { throw new InvoiceRuleError('incomplete', msg, missing); };

/**
 * The positions of a request, each of its kind (absent: an item). `units`: the unit ids a position
 * may name, the firm's list and those the draft already holds (a unit removed from the list since).
 */
function parseLines(v: unknown, units: readonly string[]): InvoiceLine[] {
  if (!Array.isArray(v)) return bad('lines muss eine Liste sein.');
  return v.map((raw, i): InvoiceLine => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const at = `Position ${i + 1}`;
    const known = (keys: string[]) => { const extra = Object.keys(l).filter((k) => !['kind', ...keys].includes(k)); if (extra.length) bad(`${at}: unbekannte Felder ${extra.join(', ')}.`); };
    const text = () => { if (!isText(l.text)) bad(`${at}: text fehlt.`, [{ field: 'line.text', line: i }]); return l.text as string; };
    const num = (k: string) => { if (l[k] !== undefined && (typeof l[k] !== 'number' || !Number.isFinite(l[k]))) bad(`${at}: ${k} ist eine Zahl.`); return l[k] as number | undefined; };
    switch (l.kind) {
      case 'text':
        known(['text', 'style']);
        if (l.style !== undefined && l.style !== 'title' && l.style !== 'plain') bad(`${at}: style ist title oder plain.`);
        return { kind: 'text', text: text(), ...(l.style === 'title' ? { style: 'title' as const } : {}) };
      case 'subtotal':
        known(['text']);
        return { kind: 'subtotal', text: text() };
      case 'pagebreak':
        known([]);
        return { kind: 'pagebreak' };
      case 'discount': {
        known(['text', 'percent', 'amount']);
        const percent = num('percent'), amount = num('amount');
        if (percent !== undefined && amount !== undefined) bad(`${at}: ein Rabatt hat percent oder amount, nicht beides.`, [{ field: 'line.discount', line: i }]);
        return { kind: 'discount', text: text(), ...(percent !== undefined ? { percent } : {}), ...(amount !== undefined ? { amount } : {}) };
      }
      case undefined: case 'item': break;
      default: return bad(`${at}: kind ist eine von ${LINE_KINDS.join(', ')}.`);
    }
    known(['text', 'quantity', 'unit', 'price', 'vatRate', 'discount', 'vatIncluded', 'account', 'activity']);
    if (typeof l.quantity !== 'number' || typeof l.price !== 'number') bad(`${at}: quantity und price sind Zahlen.`, [{ field: 'line.quantity', line: i }]);
    if (!invoiceRates().includes(l.vatRate as number)) bad(`${at}: vatRate ist einer von ${invoiceRates().join(', ')}.`, [{ field: 'line.vatRate', line: i }]);
    if (l.unit !== undefined && !units.includes(l.unit as string)) bad(`${at}: unit ist eine von ${units.join(', ')}.`);
    if (l.account !== undefined && !/^\d{4}$/.test(String(l.account))) bad(`${at}: account ist ein Konto mit 4 Ziffern.`);
    if (l.vatIncluded !== undefined && typeof l.vatIncluded !== 'boolean') bad(`${at}: vatIncluded ist true oder false.`);
    // The activity of a firm with two approved net rates (#504): 2 books the second rate.
    if (l.activity !== undefined && l.activity !== 1 && l.activity !== 2) bad(`${at}: activity ist 1 oder 2.`, [{ field: 'line.activity', line: i }]);
    const discount = num('discount');
    if (discount !== undefined && !(discount >= 0 && discount <= 100)) bad(`${at}: discount ist ein Prozentsatz von 0 bis 100.`, [{ field: 'line.discount', line: i }]);
    return {
      text: text(), quantity: l.quantity as number, price: l.price as number, vatRate: l.vatRate as number,
      ...(l.unit !== undefined ? { unit: l.unit as string } : {}), ...(l.account !== undefined ? { account: String(l.account) } : {}),
      ...(discount ? { discount } : {}),
      // Only a line of schema 2 that differs from its document keeps the flag (ItemLine.vatIncluded); at 0 % it changes nothing.
      ...(typeof l.vatIncluded === 'boolean' && (l.vatRate as number) > 0 ? { vatIncluded: l.vatIncluded } : {}),
      // A 2 on a firm with one net rate (a draft from before it went back to one) is dropped, not refused: the line books the first and stays editable.
      ...(l.activity === 2 && invoiceActivities().length && (l.vatRate as number) > 0 ? { activity: 2 as const } : {}),
    };
  });
}

const DRAFT_FIELDS = ['customerId', 'date', 'supplied', 'dueDate', 'currency', 'language', 'subject', 'lines', 'prices', 'intro', 'closing', 'exemption', 'settlement', 'termsId'] as const;
export type DraftPatch = Partial<Pick<InvoiceContent, (typeof DRAFT_FIELDS)[number]>>;

/**
 * A draft patch from a request body; `null` clears an optional field. A position's unit is one of
 * `units` (the firm's list), one the draft `id` holds already, or one an issued document names.
 */
export function parseDraftPatch(body: unknown, book: InvoiceBook, units: readonly UnitDef[] = DEFAULT_UNITS, id?: string, terms?: readonly PaymentTerms[]): DraftPatch & { clear: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('JSON-Objekt erwartet.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !DRAFT_FIELDS.includes(k as never));
  if (unknown.length) bad(`Unbekannte Felder: ${unknown.join(', ')}`);
  const out: DraftPatch & { clear: string[] } = { clear: [] };
  for (const [k, v] of Object.entries(b)) {
    if (v === null && ['supplied', 'dueDate', 'subject', 'intro', 'closing', 'exemption', 'settlement', 'termsId'].includes(k)) { out.clear.push(k); continue; }
    if (k === 'customerId') { if (!liveCustomers(book).some((c) => c.id === v)) bad('Kunde nicht gefunden.', [{ field: 'customer' }]); out.customerId = v as string; }
    else if (k === 'date' || k === 'dueDate') { if (!isDate(v)) bad(`${k} ist ein Datum JJJJ-MM-TT.`); out[k] = v as string; }
    else if (k === 'supplied') {
      const p = (v ?? {}) as Record<string, unknown>;
      if (typeof v !== 'object' || !isDate(p.from) || (p.to !== undefined && (!isDate(p.to) || (p.to as string) < (p.from as string))) || Object.keys(p).some((x) => x !== 'from' && x !== 'to')) bad('supplied ist { from, to? }, Daten JJJJ-MM-TT, to nicht vor from.');
      out.supplied = { from: p.from as string, ...(p.to !== undefined && p.to !== p.from ? { to: p.to as string } : {}) };
    }
    else if (k === 'currency') { if (!INVOICE_CURRENCIES.includes(v as never)) bad('currency ist CHF oder EUR.'); out.currency = v as InvoiceContent['currency']; }
    else if (k === 'language') { if (!INVOICE_LANGUAGES.includes(v as never)) bad(`language ist eine von ${INVOICE_LANGUAGES.join(', ')}.`); out.language = v as InvoiceContent['language']; }
    else if (k === 'lines') {
      // A unit removed from the list since stays where a document names it: the draft itself, or an issued document copied («Als Entwurf kopieren»).
      const named = (ls: readonly InvoiceLine[]) => ls.flatMap((l) => (isItem(l) && l.unit ? [l.unit] : []));
      const held = [...named(findInvoice(book, id ?? '')?.lines ?? []), ...liveInvoices(book).flatMap((i) => (i.status === 'issued' ? named(i.lines) : []))];
      out.lines = parseLines(v, [...units.map((u) => u.id), ...held]);
    }
    else if (k === 'prices') { if (!PRICES.includes(v as never)) bad(`prices ist ${PRICES.join(' oder ')}.`); out.prices = v as InvoiceContent['prices']; }
    else if (k === 'exemption') { if (v !== 'abroad' && v !== 'export') bad('exemption ist abroad oder export.'); out.exemption = v as 'abroad' | 'export'; }
    else if (k === 'termsId') { if (!isText(v) || (terms && !terms.some((x) => x.id === v))) bad(`termsId ist eine von ${(terms ?? []).map((x) => x.id).join(', ')}.`); out.termsId = v as string; }
    else if (k === 'settlement') { if (v !== 'refund' && v !== 'offset') bad('settlement ist refund oder offset.'); out.settlement = v as 'refund' | 'offset'; }
    else { if (!isText(v)) bad(`${k} ist ein Text.`); (out as Record<string, unknown>)[k] = v; }
  }
  return out;
}

export function parseCustomer(body: unknown, partial: boolean): Partial<CustomerFields> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('JSON-Objekt erwartet.');
  const b = body as Record<string, unknown>;
  const known = ['name', 'attn', 'address', 'language', 'vatId', 'email', 'paymentTermsDays'];
  const unknown = Object.keys(b).filter((k) => !known.includes(k));
  if (unknown.length) bad(`Unbekannte Felder: ${unknown.join(', ')}`);
  const out: Partial<CustomerFields> = {};
  if (b.name !== undefined || !partial) { if (!isText(b.name) || !b.name.trim()) bad('name fehlt.', [{ field: 'customer.name' }]); out.name = (b.name as string).trim(); }
  for (const k of ['attn', 'vatId', 'email'] as const) if (b[k] !== undefined) { if (!isText(b[k])) bad(`${k} ist ein Text.`); out[k] = (b[k] as string).trim(); }
  // A Swiss UID carries a check digit (r8c-18): a typo is caught here; a foreign VAT number is any text.
  if (out.vatId && /^CHE/i.test(out.vatId)) {
    const parsed = parseUid(out.vatId.replace(/\s*(MWST|TVA|IVA|VAT)$/i, ''));
    if ('error' in parsed) throw new InvoiceRuleError('uid', parsed.error);
  }
  if (b.language !== undefined || !partial) { if (!INVOICE_LANGUAGES.includes(b.language as never)) bad(`language ist eine von ${INVOICE_LANGUAGES.join(', ')}.`); out.language = b.language as CustomerFields['language']; }
  if (b.paymentTermsDays !== undefined) { if (!Number.isInteger(b.paymentTermsDays) || (b.paymentTermsDays as number) < 0) bad('paymentTermsDays ist eine ganze Zahl von Tagen.'); out.paymentTermsDays = b.paymentTermsDays as number; }
  if (b.address !== undefined || !partial) {
    const a = (b.address ?? {}) as Record<string, unknown>;
    if (!isText(a.postcode) || !isText(a.town) || !isText(a.country) || !/^[A-Z]{2}$/.test(a.country)) bad('address braucht postcode, town und country (zwei Buchstaben, CH, DE, …).', [{ field: 'customer.address' }]);
    const address: CustomerFields['address'] = { postcode: a.postcode as string, town: a.town as string, country: a.country as string };
    for (const k of ['street', 'number', 'line2', 'state'] as const) if (a[k] !== undefined) { if (!isText(a[k])) bad(`address.${k} ist ein Text.`); address[k] = a[k] as string; }
    out.address = address;
  }
  return out;
}

// ─── customers ─────────────────────────────────────────────────────────────────

export function createCustomer(ws: Workspace, fields: Partial<CustomerFields>, now = new Date().toISOString()): Customer {
  return updateInvoices(ws, (book) => {
    const c: Customer = { ...newEnvelope('cu', now), ...(fields as CustomerFields), paymentTermsDays: fields.paymentTermsDays ?? ws.invoicing?.paymentTermsDays ?? 30 };
    book.customers.push(c);
    return c;
  });
}

export function updateCustomer(ws: Workspace, id: string, patch: Partial<CustomerFields>): Customer {
  return updateInvoices(ws, (book) => {
    const i = book.customers.findIndex((c) => c.id === id && !c.deleted);
    if (i < 0) notFound('Kunde');
    book.customers[i] = { ...book.customers[i], ...patch };
    return book.customers[i];
  });
}

/** Replaces the record `id` in the book as it is now, if it still is what `expected` was; else the change is refused. */
function commit<T>(ws: Workspace, id: string, expected: Invoice, fn: (book: InvoiceBook, at: number) => T): T {
  return updateInvoices(ws, (book) => {
    const at = book.invoices.findIndex((i) => i.id === id);
    if (at < 0 || JSON.stringify(book.invoices[at]) !== JSON.stringify(expected)) {
      throw new InvoiceRuleError('changed', 'Die Rechnung wurde inzwischen geändert; bitte neu laden.');
    }
    return fn(book, at);
  });
}

// ─── drafts ────────────────────────────────────────────────────────────────────

export function createDraft(ws: Workspace, input: { customerId: string } & DraftPatch, now = new Date().toISOString()): Draft {
  return updateInvoices(ws, (book) => {
    const customer = liveCustomers(book).find((c) => c.id === input.customerId) ?? notFound('Kunde');
    const terms = draftTerms(ws.invoicing, customer.paymentTermsDays);
    const draft: Draft = {
      ...newEnvelope('in', now),
      status: 'draft',
      kind: 'invoice',
      date: now.slice(0, 10),
      currency: 'CHF',
      language: customer.language,
      lines: [],
      prices: ws.invoicing?.prices.invoice ?? 'net',
      ...(terms ? { termsId: terms } : {}),
      ...input,
      comments: [],
    };
    book.invoices.push(draft);
    return draft;
  });
}

/**
 * The terms a new invoice picks: the firm's default, unless the customer pays in days of its own
 * (a `paymentTermsDays` other than the default's days): then none, and it prints the customer's days net.
 */
function draftTerms(s: Workspace['invoicing'], customerDays: number): string | undefined {
  const all = s?.paymentTerms ?? [];
  const def = all.find((x) => x.id === s?.defaultTerms) ?? all[0];
  return def && def.days === customerDays ? def.id : undefined;
}

export function updateDraft(ws: Workspace, id: string, patch: DraftPatch & { clear?: string[] }): Draft {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    if (inv.status !== 'draft') throw new InvoiceRuleError('notDraft', `Rechnung ${inv.number} ist ausgestellt und bleibt, wie sie ist: eine Gutschrift oder ein Storno korrigiert sie.`);
    const { clear = [], ...fields } = patch;
    const next = { ...inv, ...fields } as Draft;
    for (const k of clear) delete (next as unknown as Record<string, unknown>)[k];
    book.invoices[book.invoices.indexOf(inv)] = next;
    return next;
  });
}

export function removeDraft(ws: Workspace, id: string): void {
  updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    book.invoices[book.invoices.indexOf(inv)] = deleteDraft(inv);
  });
}

export function missingOf(ws: Workspace, id: string): Missing[] {
  const book = loadInvoices(ws);
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  if (inv.status !== 'draft') return [];
  return missingForIssue(inv, { customer: book.customers.find((c) => c.id === inv.customerId), sender: senderFor(invoicingContext(ws), inv.currency), invoices: liveInvoices(book) });
}

// ─── issuing and sending ───────────────────────────────────────────────────────

/** Gives the draft its number, freezes it, prints its PDF once and stores it with its checksum. */
/** `confirmed`: the person's «Trotzdem ausstellen» over the warnings of warningsForIssue (spec 4.11). */
export function issueInvoice(ws: Workspace, id: string, opts: { now?: string; printer?: Printer; confirmed?: boolean } = {}): Promise<Issued> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const draft = findInvoice(book, id) ?? notFound('Rechnung');
    if (draft.status !== 'draft') throw new InvoiceRuleError('notDraft', `Rechnung ${draft.number} ist schon ausgestellt.`);
    const ctx = invoicingContext(ws);
    const customer = liveCustomers(book).find((c) => c.id === draft.customerId);
    const texts = defaultTexts(ctx, draft.kind, draft.language, draftDays(ctx, draft, customer));
    const frozen: Draft = { ...draft, intro: issuedIntro(texts.salutation, draft.intro ?? texts.intro), closing: draft.closing ?? texts.closing };
    // A credit note above what its invoice has open: a warning (spec 4.11), the rest is paid back.
    assertCreditWithinOpen(draft, liveInvoices(book), opts.confirmed);
    const issued = issue(frozen, { customer, sender: senderFor(ctx, draft.currency), layout: ctx.settings?.layout ?? DEFAULT_LAYOUT, units: ctx.settings?.units, invoices: liveInvoices(book), now, confirmed: opts.confirmed, paymentTerms: ctx.settings?.paymentTerms });
    const printed = await (opts.printer ?? chromium).pdf(issuedSheet(book, issued as Issued, logoSrc(ws, issued.layout.logo)), now);
    return commit(ws, draft.id, draft, (fresh, at) => {
      if (nextNumberTaken(fresh, issued.number)) throw new InvoiceRuleError('changed', `Die Nummer ${issued.number} wurde inzwischen vergeben; bitte erneut ausstellen.`);
      const done: Issued = { ...issued, pdf: storePdf(ws, now.slice(0, 4), `${issued.number}.pdf`, printed.pdf) };
      fresh.invoices[at] = done;
      return done;
    });
  });
}

function sentTitle(inv: Issued, kind: SentKind, level?: number): string {
  const L = TEXTS[inv.language];
  if (kind === 'reminder') return `${L.reminder(level ?? 1)} · ${L.invoice} ${inv.number}`;
  if (kind === 'cancellation') return `${L.stamp}: ${L.invoice} ${inv.number}`;
  return `${inv.kind === 'credit-note' ? L.credit : L.invoice} ${inv.number}`;
}

/**
 * Hands a stored PDF to its recipient by e-mail (src/invoices/mail.ts) and says to whom, with the
 * Message-ID. Without one the PDF is downloaded, to be sent by other means.
 */
export type Deliver = (doc: { filename: string; pdf: Buffer }) => Promise<{ to: string; messageId: string }>;

/** Who a document went to, and how: what `deliver` reports, else `to` (or the customer's address) as a download. */
const recipient = (inv: Issued, to: string | undefined, delivered?: { to: string; messageId: string }): Pick<SentDocument, 'to' | 'channel' | 'messageId'> =>
  delivered ? { to: delivered.to, channel: 'email', messageId: delivered.messageId } : { to: to?.trim() || inv.customer.email || 'download', channel: 'download' };

function sendable(book: InvoiceBook, id: string): Issued {
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  if (inv.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Ein Entwurf wird erst ausgestellt, dann gesendet.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  return inv;
}

/**
 * Sends the issued PDF as it was issued (by e-mail with `deliver`, else downloaded) and records it.
 * The first time it is the invoice, later a resend. A failed e-mail records nothing.
 */
export function recordSend(ws: Workspace, id: string, opts: { to?: string; deliver?: Deliver; now?: string } = {}): Promise<SentDocument> {
  return serial(async () => {
    const inv = sendable(loadInvoices(ws), id);
    const delivered = opts.deliver && await opts.deliver({ filename: `${inv.number}.pdf`, pdf: readPdf(ws, inv.pdf) });
    const now = opts.now ?? new Date().toISOString();
    return updateInvoices(ws, (book) => {
      const fresh = sendable(book, id);
      const first = !book.sent.some((d) => d.invoiceId === fresh.id && (d.kind === 'invoice' || d.kind === 'credit-note'));
      const kind: SentKind = first ? (fresh.kind === 'credit-note' ? 'credit-note' : 'invoice') : 'resend';
      const doc: SentDocument = { ...newEnvelope('sd', now), invoiceId: fresh.id, kind, title: sentTitle(fresh, kind), ...fresh.pdf, sentAt: now, ...recipient(fresh, opts.to, delivered) };
      book.sent.push(doc);
      return doc;
    });
  });
}

const nextNumberTaken = (book: InvoiceBook, number: string) => book.invoices.some((i) => i.status === 'issued' && i.number === number);

/**
 * Prints a document of its own (reminder, cancellation notice), stores its PDF and hands it to
 * `deliver`; the caller records it as sent. A failed e-mail removes the PDF again and throws.
 */
async function printOwnDocument(ws: Workspace, inv: Issued, kind: SentKind, sheet: SheetData, to: string | undefined, now: string, printer: Printer, deliver?: Deliver, level?: number): Promise<SentDocument> {
  const env = newEnvelope('sd', now);
  const printed = await printer.pdf(sheet, now);
  const title = sentTitle(inv, kind, level);
  const pdf = storePdf(ws, now.slice(0, 4), `sent/${env.id}.pdf`, printed.pdf);
  let delivered: Awaited<ReturnType<Deliver>> | undefined;
  try {
    delivered = deliver && await deliver({ filename: `${title.replace(/[/\\:*?"<>|]/g, '-')}.pdf`, pdf: printed.pdf });
  } catch (e) {
    rmSync(join(ws.paths.root, pdf.file), { force: true });
    throw e;
  }
  return { ...env, invoiceId: inv.id, kind, title, ...pdf, sentAt: now, ...recipient(inv, to, delivered) };
}

// ─── back to draft (spec 4.4.2) ────────────────────────────────────────────────

const BACK_REFUSED: Partial<Record<InvoiceRefusal, (n: string) => string>> = {
  notIssued: () => 'Ein Entwurf ist schon ein Entwurf.',
  sent: (n) => `${n} ist gesendet oder heruntergeladen: der Kunde hat sie, sie bleibt ausgestellt (MWSTG Art. 27 Abs. 2). Eine Gutschrift oder ein Storno korrigiert sie.`,
  cancelled: (n) => `${n} ist storniert.`,
  settled: (n) => `Auf ${n} ist etwas eingegangen, gutgeschrieben oder ausgebucht: sie bleibt ausgestellt.`,
  applied: (n) => `${n} ist mit einer Zahlung ihrer Rechnung verrechnet: sie bleibt ausgestellt.`,
};

/**
 * «Zurück zum Entwurf» (spec 4.4.2, P2.7): an issued document never sent, with nothing received,
 * credited or written off, becomes a draft again and keeps its number (Draft.number). Its PDF stays,
 * renamed to invoices/<number>.replaced-<k>.pdf and named in `replaced`; issuing it again prints a new
 * one under the number. `books` takes its VAT event off the books first (the route, through the
 * write door: src/invoices/revise.ts takeBackEvent) and returns the receipt files that went with it,
 * removed here once the document is a draft. Refused with the rule's code (backToDraftRefusal).
 */
export function backToDraft(ws: Workspace, id: string, opts: { now?: string; books?: (inv: Issued) => string[] } = {}): Promise<Draft> {
  return serial(() => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const refusal = backToDraftRefusal(inv, liveInvoices(book), book.sent);
    if (refusal || inv.status !== 'issued') throw new InvoiceRuleError(refusal ?? 'notIssued', (BACK_REFUSED[refusal ?? 'notIssued'] ?? (() => ''))(inv.status === 'issued' ? inv.number : ''));
    const k = (inv.replaced?.length ?? 0) + 1;
    const file = join(dirname(inv.pdf.file), `${basename(inv.pdf.file, '.pdf')}.replaced-${k}.pdf`);
    if (existsSync(join(ws.paths.root, file))) throw new InvoiceRuleError('changed', `${file} gibt es schon; bitte neu laden.`);
    const removed = opts.books?.(inv) ?? [];
    renameSync(join(ws.paths.root, inv.pdf.file), join(ws.paths.root, file));
    const ctx = invoicingContext(ws);
    const customer = liveCustomers(book).find((c) => c.id === inv.customerId);
    const { salutation } = defaultTexts(ctx, inv.kind, inv.language, draftDays(ctx, inv, customer));
    let draft: Draft;
    try {
      draft = commit(ws, inv.id, inv, (fresh, at) => {
        const d = asDraft(inv, { file, sha256: inv.pdf.sha256, issuedAt: inv.issuedAt, replacedAt: now }, salutation);
        fresh.invoices[at] = d;
        return d;
      });
    } catch (e) {
      renameSync(join(ws.paths.root, file), join(ws.paths.root, inv.pdf.file));
      throw e;
    }
    for (const f of removed) rmSync(f, { force: true });
    return draft;
  });
}

// ─── Konten ändern (spec 4.4.2) ────────────────────────────────────────────────

/**
 * «Konten ändern»: `books` books the change first (the route, through the write door:
 * src/invoices/revise.ts planAccountChange, applyAccountChange) and returns its plan; then the
 * invoice's positions, and its credit notes' that follow them, record the new accounts and the
 * change (`accountChanges`), in this process's queue. Should the documents have changed meanwhile,
 * `undo` books the change back and the request is refused (`changed`).
 */
export function changeAccounts(ws: Workspace, id: string, lines: ReadonlyArray<{ line: number; account: string }>, ctx: AccountContext, opts: {
  now?: string;
  books(inv: Issued, next: Issued, invoices: readonly Invoice[]): AccountChangePlan;
  undo(plan: AccountChangePlan, now: Issued, before: Issued, invoices: readonly Invoice[]): void;
}): Promise<AccountChangePlan> {
  return serial(() => {
    const at = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = findInvoice(book, id);
    if (!inv || inv.status !== 'issued') return notFound('Rechnung');
    const next = withAccounts(inv, lines, ctx);
    const plan = opts.books(inv, next, liveInvoices(book));
    if (!plan.lines.length) return plan;
    const notes = notesWithAccounts(inv, next, liveInvoices(book), ctx);
    try {
      updateInvoices(ws, (fresh) => {
        const same = (x: Invoice) => JSON.stringify(fresh.invoices.find((i) => i.id === x.id)) === JSON.stringify(x);
        if (!same(inv) || !notes.every((n) => same(n.old))) throw new InvoiceRuleError('changed', 'Die Rechnung oder eine ihrer Gutschriften wurde inzwischen geändert; bitte neu laden.');
        const change = (d: Issued, ls: AccountChange['lines'], extra: Partial<AccountChange> = {}): Issued => ({ ...d, accountChanges: [...(d.accountChanges ?? []), { at, lines: ls, refs: plan.rebook.filter((r) => !r.filed && r.number === d.number).map((r) => r.ref), ...extra }] });
        const reclass = (n: string) => plan.reclass.find((r) => r.number === n)?.ref;
        fresh.invoices[fresh.invoices.findIndex((i) => i.id === inv.id)] = change(next, plan.lines, reclass(inv.number) ? { reclass: reclass(inv.number) } : {});
        for (const n of notes) {
          const ls = plan.notes.find((x) => x.id === n.old.id)?.lines ?? [];
          if (ls.length) fresh.invoices[fresh.invoices.findIndex((i) => i.id === n.old.id)] = change(n.next, ls, reclass(n.old.number) ? { reclass: reclass(n.old.number) } : {});
        }
      });
    } catch (e) {
      opts.undo(plan, next, inv, liveInvoices(book).map((i) => notes.find((n) => n.old.id === i.id)?.next ?? i));
      throw e;
    }
    return plan;
  });
}

/** A PDF the document was issued with before it went back to draft, `k` from 1, checked against its checksum. */
export function replacedPdf(ws: Workspace, id: string, k: number): Buffer {
  const inv = findInvoice(loadInvoices(ws), id) ?? notFound('Rechnung');
  const r = inv.replaced?.[k - 1] ?? notFound('PDF');
  return readPdf(ws, r);
}

// ─── cancelling, crediting, reminding, commenting ─────────────────────────────

export function cancelInvoice(ws: Workspace, id: string, req: { date: string; reason: string; notify?: boolean; to?: string; confirmed?: boolean }, opts: { now?: string; printer?: Printer; deliver?: Deliver } = {}): Promise<{ invoice: Issued; sent?: SentDocument }> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    if (!isDate(req.date)) bad('date ist ein Datum JJJJ-MM-TT.');
    if (typeof req.reason !== 'string') bad('reason ist ein Text.');
    const cancelled = cancel(inv, req);
    const sent = req.notify ? await printOwnDocument(ws, cancelled, 'cancellation', issuedSheet(book, cancelled, logoSrc(ws, cancelled.layout.logo)), req.to, now, opts.printer ?? chromium, opts.deliver) : undefined;
    return commit(ws, inv.id, inv, (fresh, at) => {
      fresh.invoices[at] = cancelled;
      if (sent) fresh.sent.push(sent);
      return { invoice: cancelled, ...(sent ? { sent } : {}) };
    });
  });
}

export function createCreditNote(ws: Workspace, id: string, req: CreditRequest, now = new Date().toISOString()): Draft {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const draft = creditNoteDraft(inv, req, newEnvelope('in', now), now.slice(0, 10));
    const texts = defaultTexts(invoicingContext(ws), 'credit-note', draft.language, 0);
    const credit = { ...draft, closing: texts.closing };
    book.invoices.push(credit);
    return credit;
  });
}

export function draftReminder(ws: Workspace, id: string, date: string, fee?: number): Omit<Reminder, 'documentId'> {
  const book = loadInvoices(ws);
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  return reminderDraft(inv, liveInvoices(book), date, fee);
}

export function sendReminder(ws: Workspace, id: string, req: { date?: string; fee?: number; intro?: string; closing?: string; to?: string }, opts: { now?: string; printer?: Printer; deliver?: Deliver } = {}): Promise<{ reminder: Reminder; sent: SentDocument }> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const date = req.date ?? now.slice(0, 10);
    if (!isDate(date)) bad('date ist ein Datum JJJJ-MM-TT.');
    if (req.fee !== undefined && (typeof req.fee !== 'number' || req.fee < 0)) bad('fee ist ein Betrag ab 0.');
    const drafted = reminderDraft(inv, liveInvoices(book), date, req.fee);
    const reminder = { ...drafted, ...(req.intro !== undefined ? { intro: req.intro } : {}), ...(req.closing !== undefined ? { closing: req.closing } : {}) };
    const issued = inv as Issued;
    const sent = await printOwnDocument(ws, issued, 'reminder', reminderSheet(book, issued, reminder, logoSrc(ws, issued.layout.logo)), req.to, now, opts.printer ?? chromium, opts.deliver, reminder.level);
    const done: Reminder = { ...reminder, documentId: sent.id };
    return commit(ws, inv.id, inv, (fresh, at) => {
      fresh.invoices[at] = { ...issued, reminders: [...issued.reminders, done] };
      fresh.sent.push(sent);
      return { reminder: done, sent };
    });
  });
}

export function addComment(ws: Workspace, id: string, text: string, author: string, now = new Date().toISOString()): Comment {
  if (!text.trim()) bad('Der Kommentar ist leer.');
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const comment: Comment = { ...newEnvelope('co', now), author, text: text.trim() };
    book.invoices[book.invoices.indexOf(inv)] = { ...inv, comments: [...inv.comments, comment] } as Invoice;
    return comment;
  });
}

// ─── reading ───────────────────────────────────────────────────────────────────

/** The sheet of an invoice as HTML pages: a draft with today's settings, an issued invoice as issued, or its next reminder. */
export async function previewHtml(ws: Workspace, id: string, opts: { reminder?: { date: string; fee?: number }; printer?: Printer } = {}): Promise<Rendered> {
  const book = loadInvoices(ws);
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  const logo = logoSrc(ws, inv.status === 'issued' ? inv.layout.logo : ws.invoicing?.layout.logo);
  const sheet = opts.reminder && inv.status === 'issued'
    ? reminderSheet(book, inv, reminderDraft(inv, liveInvoices(book), opts.reminder.date, opts.reminder.fee), logo)
    : sheetOf(invoicingContext(ws), book, inv, logo);
  return (opts.printer ?? chromium).html(sheet);
}

/** The bytes of an issued invoice's PDF, as issued (checked against its checksum). */
export function issuedPdf(ws: Workspace, number: string): Buffer {
  const inv = findInvoice(loadInvoices(ws), number);
  if (!inv || inv.status !== 'issued') return notFound(`Rechnung ${number}`);
  return readPdf(ws, inv.pdf);
}

export function sentPdf(ws: Workspace, docId: string): Buffer {
  const doc = loadInvoices(ws).sent.find((d) => d.id === docId && !d.deleted) ?? notFound('Dokument');
  return readPdf(ws, doc);
}

// ─── payments ──────────────────────────────────────────────────────────────────

/** What matching and booking payments need from the workspace; undefined while it sets up no invoicing. */
export function paymentContext(ws: Workspace): PaymentContext | undefined {
  const s = ws.invoicing;
  if (!s) return undefined;
  const fx = loadFxResolver();
  return {
    bankAccounts: ws.bankAccounts,
    revenueAccount: s.revenueAccount,
    ...(s.feeAccount ? { feeAccount: s.feeAccount } : {}),
    ...(writeOffAccounts(s) ? { writeOffAccount: writeOffAccounts(s) } : {}),
    ensureAccount: (number) => {
      if (accountName(ws, number) !== undefined) return;
      const name = standardAccounts().find((a) => a.number === number)?.name;
      if (name) setAccountName(ws, number, name);
    },
    openItems: openItemAccounts((accountsOf(ws) as Array<{ number?: string }>).flatMap((a) => (a.number ? [String(a.number)] : []))),
    fx,
    pdfOf: (inv) => readPdf(ws, inv.pdf),
    receiptId: (pdf) => sha256(pdf).slice(0, 16),
    indexedAt: () => new Date().toISOString(),
    held: heldByReconciliation,
  };
}

/** Files the invoice PDFs that became receipts of `books` under their year's receipts/, once. */
export function fileReceipts(ws: Workspace, books: Books, files: PaymentOutcome['files']): void {
  for (const f of files) {
    const receipt = books.receipts.find((r) => r.filename === f.filename);
    if (!receipt) throw new Error(`${f.filename}: no receipt of the books names it`);
    const path = receiptFile(ws, books, receipt);
    if (!existsSync(path)) writeAtomic(path, f.pdf);
  }
}
