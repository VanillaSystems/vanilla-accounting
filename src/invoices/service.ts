/**
 * Invoicing on a workspace: every change to invoices.json and the invoice PDFs goes through
 * here, so the API, agents and CLIs apply the same rules (src/invoices/rules.ts). The changes that
 * print a PDF are asynchronous; they run one at a time in this process, so a number is never
 * given twice and nothing saves over another change.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { receiptFile, type Books } from '../books/store.js';
import { defaultTexts, draftDays, instalmentSheet, issuedIntro, issuedSheet, mailText, reminderSheet, senderFor, sheetOf, type InvoicingContext } from './documents.js';
import {
  INVOICE_CURRENCIES, INVOICE_LANGUAGES, DEFAULT_LAYOUT, DEFAULT_SHORTFALL_LIMIT, DEFAULT_UNITS, LINE_KINDS, PRICES, isItem, withGroups, type UnitDef,
  type Article, type ArticleFields, type Comment, type Contact, type ContactFields, type CustomerFields, type Draft, type Invoice, type InvoiceBook, type InvoiceContent,
  type AccountChange, type DunningSettings, type InvoiceLine, type Issued, type PaymentTerms, type Reminder, type Schedule, type SentDocument, type SentKind, type Stage,
} from './model.js';
import { renderHtml, renderPdf, type Rendered } from './pdf.js';
import {
  InvoiceRuleError, KIND_WORD, asDraft, assertCreditWithinOpen, backToDraftRefusal, cancel, creditNoteDraft, deleteDraft, figures, isOverdue, issue, liveDocuments, liveInvoices, missingForIssue,
  addDays, openAmount, shortfallOf, skontoOffer, status, totals, warningsForIssue, writeOffAccounts,
  type CreditRequest, type Figures, type InvoiceRefusal, type InvoiceStatus, type Missing, type Totals,
} from './rules.js';
import type { SheetData } from './sheet.js';
import { loadInvoices, newEnvelope, readPdf, sha256, storePdf, updateInvoices, writeAtomic } from './store.js';
import { yearPaths } from '../workspace/workspace.js';
import { DEFAULT_NUMBERING } from './numbering.js';
import { convertDraft, defaultValidUntil, type Ticked } from './chain.js';
import { orderCancelBlock, ownSends } from './lists.js';
import { isBooked } from './model.js';
import { formatAmount, kindTitle } from './texts.js';
import type { PaymentContext, PaymentOutcome } from './payments.js';
import { notesWithAccounts, withAccounts, type AccountChangePlan, type AccountContext } from './revise.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { creditNoteStatus, daysBetween, type CreditListStatus } from './lists.js';
import { DEFAULT_DUNNING, MAX_RUN, assertRemindable, autoDue, draftReminder, dunningRun, interestAccount, interestOf, levelKey, levelTitle, nextLevel, reminderAddress, reminderDraftOf, reminderTitle, round, storedDraftOf, type LeftOut, type RunPlan } from './dunning.js';
import { thisDevice } from '../workspace/device.js';
import { MailError, checkMessage, sendMail } from './mail.js';
import { isDurchsicht } from '../handover/durchsicht.js';
import {
  applyContact, assertNumberFree, checkVatId, contactOfCustomer, documentsOf, draftTermsOf, goneRefs, lineDefaults, liveContacts, numberContact, parseContact, pickableContacts, recipientOf,
} from './contacts.js';
import { applyArticle, assertCodeFree, documentsNaming, liveArticles, parseArticle } from './articles.js';
import { TEXTS } from './texts.js';
import { baseCurrency, invoiceActivities, invoiceRates, invoicing } from '../engines/index.js';
import { openItemAccounts } from '../accounting/tax-point.js';
import { heldByReconciliation } from '../books/reconcile.js';
import { accountsOf } from '../workspace/reads.js';
import { accountName, setAccountName } from '../workspace/accounts-write.js';
import { standardAccounts } from '../workspace/chart.js';
import { checkPlan, finalDraft, invoicedStages, stageDraft, stageStates, withDeductions } from './stages.js';
import { instalmentDue } from './rules.js';

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
const contactGone = (): never => { throw new InvoiceRuleError('contactGone', 'Diesen Kontakt gibt es nicht (mehr).'); };

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
  const customerName = inv.status === 'issued' ? inv.customer.name : book.contacts.find((c) => c.id === inv.customerId)?.name ?? '';
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

/** A document of any kind by its id or its number; a draft back from issue keeps its number, and its link with it. */
export function findInvoice(book: InvoiceBook, idOrNumber: string): Invoice | undefined {
  return liveDocuments(book).find((i) => i.id === idOrNumber || (!!i.number && i.number === idOrNumber));
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
  // A sub-position with no Gruppe above it is an ordinary position (model.ts withGroups).
  return withGroups(v.map((raw, i): InvoiceLine => {
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
      case 'group':
        known(['text']);
        return { kind: 'group', text: text() };
      case 'discount': {
        known(['text', 'percent', 'amount']);
        const percent = num('percent'), amount = num('amount');
        if (percent !== undefined && amount !== undefined) bad(`${at}: ein Rabatt hat percent oder amount, nicht beides.`, [{ field: 'line.discount', line: i }]);
        return { kind: 'discount', text: text(), ...(percent !== undefined ? { percent } : {}), ...(amount !== undefined ? { amount } : {}) };
      }
      case undefined: case 'item': case 'article': break;
      default: return bad(`${at}: kind ist eine von ${LINE_KINDS.join(', ')}.`);
    }
    known(['text', 'quantity', 'unit', 'price', 'vatRate', 'discount', 'vatIncluded', 'account', 'activity', 'optional', 'ofLine', 'inGroup', 'deducts', 'deductedVat', ...(l.kind === 'article' ? ['articleId', 'code'] : [])]);
    // An Artikel position names its Artikel; it stays one when the Artikel is archived or deleted since (its fields are its own).
    if (l.kind === 'article' && !(isText(l.articleId) && l.articleId)) bad(`${at}: articleId fehlt.`);
    if (l.code !== undefined && !isText(l.code)) bad(`${at}: code ist ein Text.`);
    if (l.inGroup !== undefined && typeof l.inGroup !== 'boolean') bad(`${at}: inGroup ist true oder false.`);
    // A Schlussrechnung's deduction keeps the Teilrechnung it names and the VAT that one charged (stages.ts deductionLines).
    if (l.deducts !== undefined && (!isText(l.deducts) || typeof l.deductedVat !== 'number' || !Number.isFinite(l.deductedVat))) bad(`${at}: deducts ist die id einer Teilrechnung, mit deductedVat als Zahl.`);
    if (l.deducts === undefined && l.deductedVat !== undefined) bad(`${at}: deductedVat nur mit deducts.`);
    if (l.optional !== undefined && typeof l.optional !== 'boolean') bad(`${at}: optional ist true oder false.`);
    if (l.ofLine !== undefined && !(Number.isInteger(l.ofLine) && (l.ofLine as number) >= 0)) bad(`${at}: ofLine ist die Nummer einer Position.`);
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
      ...(l.kind === 'article' ? { kind: 'article' as const, articleId: l.articleId as string, ...(isText(l.code) && l.code.trim() ? { code: l.code.trim() } : {}) } : {}),
      text: text(), quantity: l.quantity as number, price: l.price as number, vatRate: l.vatRate as number,
      ...(l.unit !== undefined ? { unit: l.unit as string } : {}), ...(l.account !== undefined ? { account: String(l.account) } : {}),
      ...(discount ? { discount } : {}),
      // Only a line of schema 2 that differs from its document keeps the flag (ItemLine.vatIncluded); at 0 % it changes nothing.
      ...(typeof l.vatIncluded === 'boolean' && (l.vatRate as number) > 0 ? { vatIncluded: l.vatIncluded } : {}),
      // A 2 on a firm with one net rate (a draft from before it went back to one) is dropped, not refused: the line books the first and stays editable.
      ...(l.activity === 2 && invoiceActivities().length && (l.vatRate as number) > 0 ? { activity: 2 as const } : {}),
      ...(l.optional === true ? { optional: true as const } : {}),
      ...(typeof l.ofLine === 'number' ? { ofLine: l.ofLine } : {}),
      ...(l.inGroup === true ? { inGroup: true as const } : {}),
      ...(isText(l.deducts) ? { deducts: l.deducts, deductedVat: l.deductedVat as number } : {}),
    };
  }));
}

/** `schedule: { retention: { percent, until } }` (spec 4.4.9): a percent above 0 and below 100, and a day. */
function parseSchedule(v: unknown): Schedule {
  const s = (v ?? {}) as Record<string, unknown>;
  if (typeof v !== 'object' || Object.keys(s).some((k) => k !== 'retention')) return bad('schedule ist { retention: { percent, until } }.');
  if (s.retention === undefined) return {};
  const r = (s.retention ?? {}) as Record<string, unknown>;
  if (typeof r.percent !== 'number' || !(r.percent > 0 && r.percent < 100) || !isDate(r.until) || Object.keys(r).some((k) => k !== 'percent' && k !== 'until')) {
    return bad('retention ist { percent, until }: ein Prozentsatz über 0 und unter 100 und ein Datum JJJJ-MM-TT.');
  }
  return { retention: { percent: r.percent, until: r.until as string } };
}

const DRAFT_FIELDS = ['kind', 'customerId', 'personId', 'addressId', 'date', 'supplied', 'dueDate', 'currency', 'language', 'subject', 'lines', 'prices', 'intro', 'closing', 'exemption', 'settlement', 'termsId', 'validUntil', 'ordered', 'printAs', 'role', 'schedule'] as const;
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
    if (v === null && ['personId', 'addressId', 'supplied', 'dueDate', 'subject', 'intro', 'closing', 'exemption', 'settlement', 'termsId', 'validUntil', 'ordered', 'printAs', 'role', 'schedule'].includes(k)) { out.clear.push(k); continue; }
    // A draft is of one kind from its start (a conversion makes one of another); a credit note only from its invoice.
    // A Lieferschein comes only from an Auftrag (decision 21), by «Lieferschein erstellen».
    if (k === 'kind' && v === 'delivery-note') throw new InvoiceRuleError('deliveryFromOrder', 'Ein Lieferschein entsteht aus einem Auftrag: dort «Lieferschein erstellen».');
    if (k === 'kind') { if (id !== undefined || !['quote', 'sales-order', 'invoice'].includes(v as string)) bad('kind ist quote, sales-order oder invoice, beim Anlegen.'); out.kind = v as InvoiceContent['kind']; continue; }
    if (k === 'validUntil') { if (!isDate(v)) bad('validUntil ist ein Datum JJJJ-MM-TT.'); out.validUntil = v as string; continue; }
    if (k === 'printAs') { if (v !== 'confirmation' && v !== 'proforma') bad('printAs ist confirmation oder proforma.'); out.printAs = v as 'confirmation' | 'proforma'; continue; }
    // A Teil- or Schlussrechnung (spec 4.4.9): a Rechnung's mark; its plan's stage comes only from the Auftrag.
    if (k === 'role') { if (v !== 'partial' && v !== 'final') bad('role ist partial oder final.'); out.role = v as 'partial' | 'final'; continue; }
    if (k === 'schedule') { out.schedule = parseSchedule(v); continue; }
    if (k === 'customerId') {
      const c = liveContacts(book).find((x) => x.id === v);
      if (!c) bad('Kontakt nicht gefunden.', [{ field: 'customer' }]);
      // An archived contact stays on the documents that name it; a document picks it again only once it is restored.
      if (c!.archived && findInvoice(book, id ?? '')?.customerId !== v) throw new InvoiceRuleError('archived', `${c!.name} ist archiviert: zuerst wiederherstellen.`);
      out.customerId = v as string;
    }
    else if (k === 'personId' || k === 'addressId') {
      const c = book.contacts.find((x) => x.id === (b.customerId ?? findInvoice(book, id ?? '')?.customerId));
      const list = k === 'personId' ? c?.persons : c?.addresses;
      if (!list?.some((x) => x.id === v)) bad(`${k}: ${k === 'personId' ? 'diese Kontaktperson' : 'diese Adresse'} hat der Kontakt nicht.`);
      out[k] = v as string;
    }
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
      const held = [...named(findInvoice(book, id ?? '')?.lines ?? []), ...liveDocuments(book).flatMap((i) => (i.status === 'issued' ? named(i.lines) : []))];
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
  checkVatId(out.vatId);
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

// ─── contacts ──────────────────────────────────────────────────────────────────

/** The ids of the firm's terms a contact may name. */
const termIds = (ws: Workspace) => (ws.invoicing?.paymentTerms ?? []).map((x) => x.id);

export function createContact(ws: Workspace, body: unknown, now = new Date().toISOString()): Contact {
  const { clear: _, ...fields } = parseContact(body, undefined, termIds(ws));
  return updateInvoices(ws, (book) => {
    assertNumberFree(book, fields.number);
    const c: Contact = { ...newEnvelope('cu', now), ...(fields as ContactFields) };
    book.contacts.push(c);
    return c;
  });
}

/** A customer as phase 1 named one (the AI's «newCustomer», the demo's customers): a firm contact with its address as the billing address. */
export function createCustomer(ws: Workspace, fields: Partial<CustomerFields>, now = new Date().toISOString()): Contact {
  return updateInvoices(ws, (book) => {
    const c: Contact = { ...newEnvelope('cu', now), ...contactOfCustomer({ language: 'de', ...fields, name: fields.name ?? '' }) };
    book.contacts.push(c);
    return c;
  });
}

export function updateContact(ws: Workspace, id: string, body: unknown): Contact {
  return updateInvoices(ws, (book) => {
    const i = book.contacts.findIndex((c) => c.id === id && !c.deleted);
    if (i < 0) contactGone();
    const patch = parseContact(body, book.contacts[i], termIds(ws));
    assertNumberFree(book, patch.number, id);
    book.contacts[i] = applyContact(book.contacts[i], patch);
    return book.contacts[i];
  });
}

/**
 * Takes a contact away: archived while any document names it (spec 4.4.5: its documents keep it),
 * deleted when none does. An archived contact comes back with `archived: false`.
 */
export function removeContact(ws: Workspace, id: string): { contact: Contact; outcome: 'archived' | 'deleted' } {
  return updateInvoices(ws, (book) => {
    const i = book.contacts.findIndex((c) => c.id === id && !c.deleted);
    if (i < 0) contactGone();
    const outcome = documentsOf(book, id).length ? 'archived' : 'deleted';
    book.contacts[i] = { ...book.contacts[i], ...(outcome === 'archived' ? { archived: true } : { deleted: true }) };
    return { contact: book.contacts[i], outcome };
  });
}

/** Adds contacts made elsewhere (the CSV import), each with its own envelope, in one save. */
export function addContacts(ws: Workspace, list: readonly ContactFields[], now = new Date().toISOString()): Contact[] {
  return updateInvoices(ws, (book) => {
    for (const f of list) assertNumberFree(book, f.number);
    const made = list.map((f): Contact => ({ ...newEnvelope('cu', now, 'import'), ...f }));
    book.contacts.push(...made);
    return made;
  });
}

// ─── Artikel ───────────────────────────────────────────────────────────────────

/** The unit ids an Artikel may name: the firm's list. */
const unitIds = (ws: Workspace) => (ws.invoicing?.units ?? DEFAULT_UNITS).map((u) => u.id);
const articleGone = (): never => { throw new InvoiceRuleError('articleGone', 'Diesen Artikel gibt es nicht (mehr).'); };

export function createArticle(ws: Workspace, body: unknown, now = new Date().toISOString()): Article {
  const { clear: _, ...fields } = parseArticle(body, unitIds(ws));
  return updateInvoices(ws, (book) => {
    assertCodeFree(book, fields.code);
    const a: Article = { ...newEnvelope('ar', now), ...(fields as ArticleFields) };
    book.articles.push(a);
    return a;
  });
}

export function updateArticle(ws: Workspace, id: string, body: unknown): Article {
  return updateInvoices(ws, (book) => {
    const i = book.articles.findIndex((a) => a.id === id && !a.deleted);
    if (i < 0) articleGone();
    const patch = parseArticle(body, unitIds(ws), book.articles[i]);
    assertCodeFree(book, patch.code, id);
    book.articles[i] = applyArticle(book.articles[i], patch);
    return book.articles[i];
  });
}

/**
 * Takes an Artikel away: archived while any document (a draft too) has a position from it, deleted
 * when none does (as a contact, spec 4.4.5). An archived Artikel comes back with `archived: false`.
 */
export function removeArticle(ws: Workspace, id: string): { article: Article; outcome: 'archived' | 'deleted' } {
  return updateInvoices(ws, (book) => {
    const i = book.articles.findIndex((a) => a.id === id && !a.deleted);
    if (i < 0) articleGone();
    const outcome = documentsNaming(book, id).length ? 'archived' : 'deleted';
    book.articles[i] = { ...book.articles[i], ...(outcome === 'archived' ? { archived: true } : { deleted: true }) };
    return { article: book.articles[i], outcome };
  });
}

/** Adds Artikel made elsewhere (the CSV import), each with its own envelope, in one save. */
export function addArticles(ws: Workspace, list: readonly ArticleFields[], now = new Date().toISOString()): Article[] {
  return updateInvoices(ws, (book) => {
    for (const f of list) assertCodeFree(book, f.code);
    const made = list.map((f): Article => ({ ...newEnvelope('ar', now, 'import'), ...f }));
    book.articles.push(...made);
    return made;
  });
}

export { liveArticles };

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

/**
 * A new draft for a contact: its language, currency and terms; its positions (the AI's) take the
 * contact's revenue account and standing discount where they name none.
 */
export function createDraft(ws: Workspace, input: { customerId: string } & DraftPatch, now = new Date().toISOString()): Draft {
  return updateInvoices(ws, (book) => {
    const contact = liveContacts(book).find((c) => c.id === input.customerId) ?? contactGone();
    // One refusal for an archived contact, wherever a document would pick it.
    if (contact.archived) throw new InvoiceRuleError('archived', `${contact.name} ist archiviert: zuerst wiederherstellen.`);
    const kind = input.kind ?? 'invoice';
    // A Lieferschein comes only from an Auftrag, a Gutschrift only from its Rechnung (convertDocument, createCreditNote).
    if (kind === 'delivery-note') throw new InvoiceRuleError('deliveryFromOrder', 'Ein Lieferschein entsteht aus einem Auftrag: dort «Lieferschein erstellen».');
    if (kind === 'credit-note') throw new InvoiceRuleError('incomplete', 'Eine Gutschrift entsteht aus ihrer Rechnung.');
    const terms = kind === 'invoice' ? draftTermsOf(ws.invoicing, contact) : undefined;
    const defaults = lineDefaults(contact);
    const date = input.date ?? now.slice(0, 10);
    const draft: Draft = {
      ...newEnvelope('in', now),
      status: 'draft',
      kind,
      date,
      currency: contact.currency ?? 'CHF',
      language: contact.language,
      lines: [],
      prices: ws.invoicing?.prices[kind] ?? 'net',
      ...(terms ? { termsId: terms } : {}),
      // An Angebot holds for 30 days unless the person sets another day.
      ...(kind === 'quote' ? { validUntil: defaultValidUntil(date) } : {}),
      ...input,
      ...(input.lines ? { lines: input.lines.map((l) => (isItem(l) ? { ...defaults, ...l } : l)) } : {}),
      comments: [],
    };
    book.invoices.push(draft);
    return draft;
  });
}

/**
 * `confirm`: the warnings the person overrode, `stagesInvoiced` («Trotzdem ändern», spec 4.11): the
 * total of an Auftrag whose Teilrechnungen are issued changes.
 */
export function updateDraft(ws: Workspace, id: string, patch: DraftPatch & { clear?: string[] }, confirm: readonly string[] = []): Draft {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    if (inv.status !== 'draft') throw new InvoiceRuleError('notDraft', `Rechnung ${inv.number} ist ausgestellt und bleibt, wie sie ist: eine Gutschrift oder ein Storno korrigiert sie.`);
    const { clear = [], ...fields } = patch;
    const next = { ...inv, ...fields } as Draft;
    if (inv.kind === 'sales-order' && !confirm.includes('stagesInvoiced') && totals(next).gross !== totals(inv).gross) {
      const made = invoicedStages(inv, liveDocuments(book));
      if (made.numbers.length) {
        const amount = `${inv.currency} ${formatAmount(made.gross, 'de')}`;
        throw new InvoiceRuleError('stagesInvoiced', `${made.numbers.length === 1 ? 'Eine Teilrechnung' : `${made.numbers.length} Teilrechnungen`} über ${amount} ausgestellt (${made.numbers.join(', ')}): die Stufen ergeben das alte Total, die Schlussrechnung zieht ab, was in Rechnung gestellt ist. Nur mit «Trotzdem ändern».`, undefined, { n: made.numbers.length, amount, numbers: made.numbers.join(', ') });
      }
    }
    // Another contact: the person and the address of the one before are not its own.
    if (fields.customerId && fields.customerId !== inv.customerId) {
      if (!('personId' in fields)) delete next.personId;
      if (!('addressId' in fields)) delete next.addressId;
    }
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
  return missingForIssue(inv, { customer: recipientOf(book.contacts.find((c) => c.id === inv.customerId), inv, ws.invoicing), sender: senderFor(invoicingContext(ws), inv.currency), invoices: liveDocuments(book) });
}

// ─── issuing and sending ───────────────────────────────────────────────────────

/** Gives the draft its number, freezes it, prints its PDF once and stores it with its checksum. */
/**
 * `confirmed`: the person's «Trotzdem ausstellen» over the warnings of warningsForIssue (spec 4.11);
 * `confirm`: the other warnings she overrode by their codes, `sourceCancelled` a draft made from a
 * document cancelled since.
 */
export function issueInvoice(ws: Workspace, id: string, opts: { now?: string; printer?: Printer; confirmed?: boolean; confirm?: readonly string[] } = {}): Promise<Issued> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const draft = findInvoice(book, id) ?? notFound('Rechnung');
    if (draft.status !== 'draft') throw new InvoiceRuleError('notDraft', `Rechnung ${draft.number} ist schon ausgestellt.`);
    // A draft made from an Auftrag or Angebot cancelled since: a warning (the chain would hang on a Storno).
    const source = draft.from ? findInvoice(book, draft.from.id) : undefined;
    if (source?.status === 'issued' && source.cancelled && !opts.confirm?.includes('sourceCancelled')) {
      throw new InvoiceRuleError('sourceCancelled', `${KIND_WORD[source.kind]} ${source.number} ist storniert: dieser Entwurf stammt daraus. Nur mit «Trotzdem ausstellen».`, undefined, { number: source.number });
    }
    const ctx = invoicingContext(ws);
    const contact = liveContacts(book).find((c) => c.id === draft.customerId);
    // A person or address the contact no longer has: a warning; on «Trotzdem ausstellen» the document goes without them.
    const gone = goneRefs(contact, draft);
    if (gone.length && !opts.confirmed) throw new InvoiceRuleError('unconfirmed', 'Die gewählte Kontaktperson oder Adresse gibt es beim Kontakt nicht mehr; nur mit «Trotzdem ausstellen».', [...gone, ...warningsForIssue(draft)]);
    const customer = recipientOf(contact, draft, ws.invoicing);
    const texts = defaultTexts(ctx, draft.kind, draft.language, draftDays(ctx, draft, customer), draft.printAs);
    const kept = { ...draft } as Draft;
    for (const m of gone) delete kept[m.field === 'customer.person' ? 'personId' : 'addressId'];
    const frozen: Draft = { ...kept, intro: issuedIntro(texts.salutation, draft.intro ?? texts.intro), closing: draft.closing ?? texts.closing };
    // A credit note above what its invoice has open: a warning (spec 4.11), the rest is paid back.
    assertCreditWithinOpen(draft, liveInvoices(book), opts.confirmed);
    const issued = issue(frozen, { customer, sender: senderFor(ctx, draft.currency), layout: ctx.settings?.layout ?? DEFAULT_LAYOUT, units: ctx.settings?.units, invoices: liveDocuments(book), now, confirmed: opts.confirmed, paymentTerms: ctx.settings?.paymentTerms, numbering: ctx.settings?.numbering ?? DEFAULT_NUMBERING });
    const printed = await (opts.printer ?? chromium).pdf(issuedSheet(book, issued as Issued, logoSrc(ws, issued.layout.logo)), now);
    return commit(ws, draft.id, draft, (fresh, at) => {
      if (nextNumberTaken(fresh, issued.number, draft.id)) throw new InvoiceRuleError('changed', `Die Nummer ${issued.number} wurde inzwischen vergeben; bitte erneut ausstellen.`);
      const done: Issued = { ...issued, pdf: storePdf(ws, now.slice(0, 4), pdfName(ws, now.slice(0, 4), issued.number, printed.pdf), printed.pdf) };
      fresh.invoices[at] = done;
      // The contact's first issued document gives it its customer number.
      numberContact(fresh, done.customerId);
      return done;
    });
  });
}

function sentTitle(inv: Issued, kind: SentKind, reminder?: Pick<Reminder, 'level' | 'title'>): string {
  const L = TEXTS[inv.language];
  if (kind === 'reminder') return `${reminderTitle(reminder ?? { level: 1 }, inv.language)} · ${L.invoice} ${inv.number}`;
  if (kind === 'cancellation') return `${L.stamp}: ${L.invoice} ${inv.number}`;
  if (kind === 'instalment') return `${L.instalment} · ${kindTitle(L, inv.kind, inv.printAs, inv.role)} ${inv.number}`;
  return `${kindTitle(L, inv.kind, inv.printAs, inv.role)} ${inv.number}`;
}

/**
 * The file an issued PDF takes: `<number>.pdf`, or `<number>-2.pdf`, … when an Angebot or Auftrag
 * back from draft is issued again under its number: the version that went out stays as it was sent.
 */
function pdfName(ws: Workspace, year: string, number: string, pdf: Buffer): string {
  for (let k = 1; ; k++) {
    const name = k === 1 ? `${number}.pdf` : `${number}-${k}.pdf`;
    const path = join(yearPaths(ws.paths, year).invoices, name);
    if (!existsSync(path) || readFileSync(path).equals(pdf)) return name;
  }
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
      // The first send of this version (an Angebot back from draft is issued again under its number) is the document; a later one a resend.
      const first = !book.sent.some((d) => d.invoiceId === fresh.id && d.file === fresh.pdf.file && d.kind !== 'reminder' && d.kind !== 'cancellation');
      const kind: SentKind = first ? fresh.kind : 'resend';
      const doc: SentDocument = { ...newEnvelope('sd', now), invoiceId: fresh.id, kind, title: sentTitle(fresh, kind), ...fresh.pdf, sentAt: now, ...recipient(fresh, opts.to, delivered) };
      book.sent.push(doc);
      return doc;
    });
  });
}

/** Whether another document holds `number` by now: issued, or a draft that keeps it (Draft.number). */
const nextNumberTaken = (book: InvoiceBook, number: string, id?: string) => book.invoices.some((i) => !i.deleted && i.id !== id && i.number === number);

/**
 * Prints a document of its own (reminder, cancellation notice), stores its PDF and hands it to
 * `deliver`; the caller records it as sent. A failed e-mail removes the PDF again and throws.
 */
async function printOwnDocument(ws: Workspace, inv: Issued, kind: SentKind, sheet: SheetData, to: string | undefined, now: string, printer: Printer, deliver?: Deliver, reminder?: Pick<Reminder, 'level' | 'title'>): Promise<SentDocument> {
  const env = newEnvelope('sd', now);
  const printed = await printer.pdf(sheet, now);
  const title = sentTitle(inv, kind, reminder);
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
    const customer = recipientOf(liveContacts(book).find((c) => c.id === inv.customerId), inv, ws.invoicing);
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

/**
 * Storno. `confirm`: the warnings the person overrode, each by its own code: `paid` (a paid Rechnung),
 * `orderDelivered` and `orderDrafts` (an Auftrag with a Lieferschein, or with drafts made from it); a
 * code confirms only its own warning.
 */
export function cancelInvoice(ws: Workspace, id: string, req: { date: string; reason: string; notify?: boolean; to?: string; confirm?: readonly string[] }, opts: { now?: string; printer?: Printer; deliver?: Deliver } = {}): Promise<{ invoice: Issued; sent?: SentDocument }> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    if (!isDate(req.date)) bad('date ist ein Datum JJJJ-MM-TT.');
    if (typeof req.reason !== 'string') bad('reason ist ein Text.');
    if (inv.kind === 'quote') throw new InvoiceRuleError('notQuote', 'Ein Angebot wird abgelehnt, nicht storniert.');
    // An Auftrag with a Rechnung that stands keeps it: refused; with a Lieferschein, a warning (spec 4.4.2).
    const block = inv.kind === 'sales-order' ? orderCancelBlock(inv, liveDocuments(book)) : undefined;
    if (block?.code === 'orderInvoiced') throw new InvoiceRuleError('orderInvoiced', `Aus dem Auftrag ist ${block.numbers.join(', ')} ausgestellt: erst die Rechnung stornieren oder gutschreiben, dann den Auftrag.`, undefined, { numbers: block.numbers.join(', ') });
    const confirm = req.confirm ?? [];
    if (block?.code === 'orderDelivered' && !confirm.includes('orderDelivered')) throw new InvoiceRuleError('orderDelivered', `Zum Auftrag ist ${block.numbers.join(', ')} ausgeführt: die Lieferung bleibt, nur der Auftrag wird storniert. Nur mit «Trotzdem stornieren».`, undefined, { numbers: block.numbers.join(', ') });
    // Drafts made from it would hang on a Storno: named first, and each warns again at its issue.
    const drafts = inv.kind === 'sales-order' ? liveDocuments(book).filter((d) => d.status === 'draft' && d.from?.id === inv.id) : [];
    if (drafts.length && !confirm.includes('orderDrafts')) throw new InvoiceRuleError('orderDrafts', `Aus ${inv.number} ${drafts.length === 1 ? 'ist ein Entwurf' : `sind ${drafts.length} Entwürfe`} angelegt: storniert, kann ${drafts.length === 1 ? 'er' : 'jeder'} nur mit «Trotzdem ausstellen» ausgestellt werden. Nur mit «Trotzdem stornieren».`, undefined, { number: inv.number ?? '', n: drafts.length });
    const cancelled = cancel(inv, { ...req, confirmed: !isBooked(inv) || confirm.includes('paid'), invoices: liveDocuments(book) });
    const sent = req.notify && isBooked(inv) ? await printOwnDocument(ws, cancelled, 'cancellation', issuedSheet(book, cancelled, logoSrc(ws, cancelled.layout.logo)), req.to, now, opts.printer ?? chromium, opts.deliver) : undefined;
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

// ─── the chain of phase 2: conversions, the customer's answer, back to draft ───

/**
 * «Auftrag erstellen», «Lieferschein erstellen», «Rechnung erstellen» (spec 4.4.1): a draft of `to`
 * with the ticked positions and quantities, `from` naming the source. `confirm`: the warnings the
 * person overrode («Trotzdem erstellen», «Trotzdem übernehmen»), the codes of convertWarnings.
 */
export function convertDocument(ws: Workspace, id: string, req: { to: InvoiceContent['kind']; lines: Ticked[]; confirm?: string[] }, now = new Date().toISOString()): Draft {
  return updateInvoices(ws, (book) => {
    const source = findInvoice(book, id) ?? notFound('Dokument');
    const docs = liveDocuments(book);
    const draft = convertDraft(source, req.to, req.lines, docs, newEnvelope('in', now), now.slice(0, 10), now.slice(0, 10), req.confirm ?? []);
    const contact = liveContacts(book).find((c) => c.id === draft.customerId);
    const terms = req.to === 'invoice' && !draft.termsId && contact ? draftTermsOf(ws.invoicing, contact) : undefined;
    const done: Draft = { ...draft, ...(terms ? { termsId: terms } : {}) };
    book.invoices.push(done);
    return done;
  });
}

/**
 * The customer's answer to an Angebot, a person's click (spec 4.4.2): `accepted` or `declined` on
 * `date`, recorded with who clicked; `null` takes the answer back. Refused on a draft and on any other kind.
 */
export function answerQuote(ws: Workspace, id: string, answer: 'accepted' | 'declined' | null, by: string, date: string): Issued {
  return updateInvoices(ws, (book) => {
    const q = findInvoice(book, id) ?? notFound('Angebot');
    if (q.kind !== 'quote') throw new InvoiceRuleError('notQuote', 'Nur ein Angebot wird angenommen oder abgelehnt.');
    if (q.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Ein Entwurf wird erst ausgestellt, dann angenommen oder abgelehnt.');
    if (!isDate(date)) bad('date ist ein Datum JJJJ-MM-TT.');
    const { accepted: _a, declined: _d, ...rest } = q;
    const next: Issued = { ...rest, ...(answer ? { [answer]: { date, by } } : {}) };
    book.invoices[book.invoices.indexOf(q)] = next;
    return next;
  });
}

/**
 * An issued Angebot or Auftrag back to draft (spec 4.4.2), keeping its number; issued again it takes
 * that number and a PDF of its own. Once sent it warns (`sentVersion`, «Trotzdem bearbeiten»): the
 * customer may hold the version sent, which stays in the sent log. A Rechnung and a Gutschrift are not
 * taken back here; a cancelled document, or one with documents made from it, neither.
 */
export function reopenDocument(ws: Workspace, id: string, confirmed: boolean): Draft {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Dokument');
    if (inv.kind !== 'quote' && inv.kind !== 'sales-order') throw new InvoiceRuleError('notReopenable', 'Nur ein Angebot oder ein Auftrag geht hier zurück zum Entwurf.');
    if (inv.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Das ist schon ein Entwurf.');
    if (inv.cancelled) throw new InvoiceRuleError('cancelled', `${inv.number} ist storniert.`, undefined, { number: inv.number });
    // Its Teilrechnungen hold it no more than its plan: its total changes only with the warning of updateDraft (spec 4.11).
    const made = liveDocuments(book).filter((d) => d.from?.id === inv.id && !(d.kind === 'invoice' && d.role === 'partial'));
    if (made.length) throw new InvoiceRuleError('notReopenable', `Aus ${inv.number} sind schon Dokumente entstanden: es bleibt, wie es ist.`, undefined, { number: inv.number });
    const last = ownSends(book.sent, inv).at(-1);
    if (last && !confirmed) {
      const to = last.to;
      throw new InvoiceRuleError('sentVersion', `Gesendet am ${last.sentAt.slice(0, 10)} an ${to}: diese Fassung bleibt im Versandprotokoll, der Kunde hat sie vielleicht. Nur mit «Trotzdem bearbeiten».`, undefined, { date: last.sentAt.slice(0, 10), to });
    }
    const { status: _s, issuedAt: _i, reference: _r, customer: _c, sender: _se, layout: _l, units: _u, pdf: _p, payments: _pa, writeOffs: _w, terms: _t, reminders: _re, cancelled: _cx, dueDate: _due, ...content } = inv;
    const draft: Draft = { ...content, status: 'draft' };
    book.invoices[book.invoices.indexOf(inv)] = draft;
    return draft;
  });
}

// ─── Mahnungen (spec 4.4.7) ────────────────────────────────────────────────────

const dunningOf = (ws: Workspace): DunningSettings => ws.invoicing?.dunning ?? DEFAULT_DUNNING;
const draftIn = (book: InvoiceBook, inv: Issued) => reminderDraftOf(inv, liveInvoices(book));
const noDraft = (): never => { throw new InvoiceRuleError('noReminderDraft', 'Keine Mahnung im Entwurf: eine gesendete bleibt, wie sie gesendet wurde.'); };

/** The next Mahnung of an invoice as it would be written on `date` (not stored): the preview of «Mahnen». */
export function previewReminder(ws: Workspace, id: string, date: string, fee?: number): Reminder {
  const book = loadInvoices(ws);
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  if (inv.status === 'issued') { const d = draftIn(book, inv); if (d) return d; }
  return draftReminder(inv, liveInvoices(book), date, dunningOf(ws), fee !== undefined ? { fee } : {});
}

const remindable = (book: InvoiceBook, id: string): Issued => {
  const inv = findInvoice(book, id) ?? notFound('Rechnung');
  assertRemindable(inv, liveInvoices(book));
  return inv;
};
const replaceDoc = (book: InvoiceBook, inv: Issued) => { book.invoices[book.invoices.findIndex((i) => i.id === inv.id)] = inv; };

/**
 * «Mahnen»: the next Mahnung written and kept as a draft (Reminder without documentId) with the
 * level's texts in the invoice's language, editable until it is sent. One draft per invoice: a second
 * «Mahnen» returns the one there.
 */
export function createReminderDraft(ws: Workspace, id: string, req: { date?: string; fee?: number } = {}, now = new Date().toISOString()): Reminder {
  const date = req.date ?? now.slice(0, 10);
  if (!isDate(date)) bad('date ist ein Datum JJJJ-MM-TT.');
  if (req.fee !== undefined && (typeof req.fee !== 'number' || req.fee < 0)) bad('fee ist ein Betrag ab 0.');
  return updateInvoices(ws, (book) => {
    const inv = remindable(book, id);
    const there = draftIn(book, inv);
    if (there) return there;
    const r = draftReminder(inv, liveInvoices(book), date, dunningOf(ws), req.fee !== undefined ? { fee: req.fee } : {});
    if (r.date < inv.date) bad(`Eine Mahnung ist frühestens am Tag der Rechnung (${inv.date}) datiert.`);
    replaceDoc(book, { ...inv, reminders: [...inv.reminders.filter((x) => x.documentId), r] });
    return r;
  });
}

/** What a person changes on a Mahnung before it is sent; null takes a fee or the interest off. */
export interface ReminderPatch { date?: string; dueDate?: string; title?: string; fee?: number | null; interest?: number | null; intro?: string; closing?: string }

function patched(ws: Workspace, inv: Issued, invoices: readonly Invoice[], r: Reminder, p: ReminderPatch): Reminder {
  if (p.date !== undefined && !isDate(p.date)) bad('date ist ein Datum JJJJ-MM-TT.');
  if (p.dueDate !== undefined && !isDate(p.dueDate)) bad('dueDate ist ein Datum JJJJ-MM-TT.');
  if (p.fee !== undefined && p.fee !== null && (typeof p.fee !== 'number' || !Number.isFinite(p.fee) || p.fee < 0)) bad('fee ist ein Betrag ab 0.');
  if (p.interest !== undefined && p.interest !== null && (typeof p.interest !== 'number' || !Number.isFinite(p.interest) || p.interest < 0)) bad('interest ist ein Betrag ab 0.');
  for (const k of ['title', 'intro', 'closing'] as const) if (p[k] !== undefined && typeof p[k] !== 'string') bad(`${k} ist ein Text.`);
  const level = dunningOf(ws).levels[r.level - 1];
  // A new date moves the due date by the level's days and the interest to it, unless the person names them.
  const date = p.date ?? r.date;
  const dueDate = p.dueDate ?? (p.date !== undefined ? addDays(date, level?.days ?? daysBetween(r.date, r.dueDate)) : r.dueDate);
  if (date < inv.date) bad(`Eine Mahnung ist frühestens am Tag der Rechnung (${inv.date}) datiert.`);
  if (dueDate < date) bad(`Zahlbar bis ${dueDate} liegt vor dem Datum der Mahnung ${date}.`);
  const computed = p.date !== undefined ? interestOf(inv, invoices, date, dunningOf(ws)) : r.interest;
  // An amount typed by hand: over the same span; without a rate (the firm charges none) the paper names no percent.
  const span = computed ?? { rate: dunningOf(ws).interest?.rate ?? 0, from: inv.dueDate, to: date, days: Math.max(0, daysBetween(inv.dueDate, date)), amount: 0 };
  const interest = p.interest === null ? undefined : p.interest !== undefined ? { ...span, amount: round(inv, p.interest) } : computed;
  const fee = p.fee === null ? undefined : p.fee !== undefined ? round(inv, p.fee) : r.fee;
  const { fee: _f, interest: _i, ...rest } = r;
  return {
    ...rest, date, dueDate,
    ...(p.title !== undefined && p.title.trim() ? { title: p.title.trim() } : {}),
    ...(p.intro !== undefined ? { intro: p.intro } : {}), ...(p.closing !== undefined ? { closing: p.closing } : {}),
    ...(fee ? { fee } : {}), ...(interest && interest.amount > 0 ? { interest } : {}),
  };
}

/** Changes the Mahnung written and not sent yet; refused (`noReminderDraft`) when there is none: a sent one is kept as sent. */
export function updateReminderDraft(ws: Workspace, id: string, p: ReminderPatch): Reminder {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const r = inv.status === 'issued' ? draftIn(book, inv) : undefined;
    if (!r || inv.status !== 'issued') return noDraft();
    const next = patched(ws, inv, liveInvoices(book), r, p);
    replaceDoc(book, { ...inv, reminders: inv.reminders.map((x) => (x === r ? next : x)) });
    return next;
  });
}

/** Deletes the Mahnung written and not sent yet (also one a payment made moot), which takes its level back; a sent one is kept as sent (`noReminderDraft`). */
export function deleteReminderDraft(ws: Workspace, id: string): Issued {
  return updateInvoices(ws, (book) => {
    const inv = findInvoice(book, id) ?? notFound('Rechnung');
    const r = inv.status === 'issued' ? storedDraftOf(inv) : undefined;
    if (!r || inv.status !== 'issued') return noDraft();
    const next: Issued = { ...inv, reminders: inv.reminders.filter((x) => x !== r) };
    replaceDoc(book, next);
    return next;
  });
}

/** What a Mahnlauf or an automatic round planned to send: refused (`levelChanged`) when, by the time it is its turn, another level is due or the draft came or went. */
export interface PlannedReminder { level: number; draft: boolean }

/**
 * Sends the next Mahnung of an invoice (by e-mail with `deliver`, else downloaded) and keeps it as
 * sent, with its PDF in the sent log: the draft as written, with what `req` still changes, or, without
 * a draft, the next level written now (the Mahnlauf, the automatic reminder). `expect`: what the
 * caller planned; two overlapping runs so never escalate one invoice twice. Print, mail and record run
 * in one step of this process's queue; the record merges into the book as it is by then (a payment
 * matched meanwhile stays). A failed e-mail records nothing. A mail that went out whose record then
 * fails is noted on this computer (data/dunning-mailed.json), so it is never mailed again by itself,
 * and refused with `recordFailed`.
 */
export function sendReminder(ws: Workspace, id: string, req: ReminderPatch & { to?: string; by?: Reminder['by']; expect?: PlannedReminder }, opts: { now?: string; printer?: Printer; deliver?: Deliver } = {}): Promise<{ reminder: Reminder; sent: SentDocument }> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = remindable(book, id);
    const invoices = liveInvoices(book);
    const draft = draftIn(book, inv);
    const { to, by, expect, ...patch } = req;
    const base = draft ?? draftReminder(inv, invoices, req.date ?? now.slice(0, 10), dunningOf(ws), typeof req.fee === 'number' ? { fee: req.fee } : {});
    if (expect && (base.level !== expect.level || !!draft !== expect.draft)) {
      throw new InvoiceRuleError('levelChanged', `Rechnung ${inv.number}: inzwischen ist ${draft ? 'eine Mahnung im Entwurf' : `die Stufe ${base.level}`} dran, nicht die geplante Stufe ${expect.level}; nichts gesendet.`, undefined, { number: inv.number });
    }
    const reminder: Reminder = { ...patched(ws, inv, invoices, base, draft ? patch : { ...patch, date: undefined }), ...(by ? { by } : {}) };
    const sent = await printOwnDocument(ws, inv, 'reminder', reminderSheet(book, inv, reminder, logoSrc(ws, inv.layout.logo)), to, now, opts.printer ?? chromium, opts.deliver, reminder);
    const done: Reminder = { ...reminder, documentId: sent.id };
    try {
      return updateInvoices(ws, (fresh) => {
        const at = fresh.invoices.findIndex((i) => i.id === inv.id);
        const cur = fresh.invoices[at];
        if (!cur || cur.status !== 'issued') throw new Error(`${inv.number} ist nicht mehr ausgestellt`);
        // Merged into the book as it is now: what changed meanwhile stays; the draft gives way to what was sent.
        fresh.invoices[at] = { ...cur, reminders: [...cur.reminders.filter((r) => r.documentId), done] };
        fresh.sent.push(sent);
        return { reminder: done, sent };
      });
    } catch (e) {
      if (sent.channel === 'email') noteMailed(ws, { invoiceId: inv.id, number: inv.number, level: reminder.level, to: sent.to, at: now });
      throw new InvoiceRuleError('recordFailed', `${reminderTitle(reminder, inv.language)} zu ${inv.number} ging an ${sent.to}, ist aber nicht festgehalten: ${(e as Error).message}. Bitte im Versand prüfen; sie wird nicht noch einmal von selbst gesendet.`, undefined, { number: inv.number, to: sent.to });
    }
  });
}

/** A Mahnung mailed whose record failed, by invoice and level: never mailed again by itself. */
interface Mailed { invoiceId: string; number: string; level: number; to: string; at: string }
const mailedFile = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, 'data', 'dunning-mailed.json');
function readMailed(ws: Pick<Workspace, 'paths'>): Mailed[] {
  try { return existsSync(mailedFile(ws)) ? (JSON.parse(readFileSync(mailedFile(ws), 'utf8')) as { mailed: Mailed[] }).mailed : []; } catch { return []; }
}
function noteMailed(ws: Pick<Workspace, 'paths'>, m: Mailed): void {
  try {
    mkdirSync(dirname(mailedFile(ws)), { recursive: true });
    writeAtomic(mailedFile(ws), `${JSON.stringify({ mailed: [...readMailed(ws), m] }, null, 2)}\n`);
  } catch { /* the refusal still says it went */ }
}

/** Whether the firm's mail is set up: a Mahnung with an address then goes by e-mail. */
export const canMail = (ws: Workspace): boolean => !!ws.outgoingMail;

/** Sends a Mahnung's PDF to `to`: the level's mail texts, else the firm's, else the app's, through the company's mailbox. */
export type MailReminder = (to: string, inv: Issued, r: Pick<Reminder, 'level' | 'title'>) => Deliver;
export const mailReminder = (ws: Workspace): MailReminder => (to, inv, r) => ({ filename, pdf }) =>
  sendMail(ws, checkMessage({ to, ...mailText(ws.invoicing, inv, { kind: 'reminder', level: r.level, title: reminderTitle(r, inv.language) }, ws.company.name) }), { filename, content: pdf });

/** The Mahnlauf's list on `date` (spec 4.4.7): see src/invoices/dunning.ts dunningRun. */
export function planDunningRun(ws: Workspace, date: string, only?: readonly string[]): RunPlan {
  if (!isDate(date)) bad('date ist ein Datum JJJJ-MM-TT.');
  const book = loadInvoices(ws);
  return dunningRun(book, liveInvoices(book), dunningOf(ws), date, { ...(only ? { only } : {}), canMail: canMail(ws) });
}

/** Why a Mahnung did not go: the rule's or the mailbox's code, and its words. */
export interface RunFailed { invoiceId: string; number: string; error: string; code: string }
const failure = (e: unknown): Pick<RunFailed, 'error' | 'code'> => ({
  error: (e as Error).message,
  code: e instanceof InvoiceRuleError ? e.code : e instanceof MailError ? `mail.${e.code}` : 'failed',
});

export interface RunSent { invoiceId: string; number: string; title: string; channel: 'email' | 'download'; to: string; sentId: string }
export interface RunOutcome { sent: RunSent[]; failed: RunFailed[]; leftOut: LeftOut[]; more: number }

/**
 * «Senden» of the Mahnlauf, after the one confirmation: each ticked invoice that the list on `date`
 * still proposes gets its Mahnung, by e-mail where it has an address and the firm's mail is set up,
 * else downloaded (its PDF in the sent log, channel «Download»). A written draft goes as it stands,
 * with its own date. Each goes only at the level the list planned. One that fails is named with its
 * code and the rest go on.
 */
export async function runDunning(ws: Workspace, req: { date: string; ids: readonly string[] }, opts: { now?: string; printer?: Printer; mail?: MailReminder } = {}): Promise<RunOutcome> {
  const plan = planDunningRun(ws, req.date, req.ids);
  const out: RunOutcome = { sent: [], failed: [], leftOut: plan.leftOut, more: plan.more };
  const mail = opts.mail ?? mailReminder(ws);
  const book = loadInvoices(ws);
  for (const item of plan.items) {
    try {
      const inv = findInvoice(book, item.invoiceId) as Issued;
      const deliver = item.to ? mail(item.to, inv, { level: item.level, title: item.title }) : undefined;
      const r = await sendReminder(ws, item.invoiceId, { ...(item.draft ? {} : { date: req.date }), by: 'run', expect: { level: item.level, draft: !!item.draft }, ...(item.to ? {} : { to: 'download' }) }, { ...(opts.now ? { now: opts.now } : {}), ...(opts.printer ? { printer: opts.printer } : {}), ...(deliver ? { deliver } : {}) });
      out.sent.push({ invoiceId: item.invoiceId, number: item.number, title: item.title, channel: r.sent.channel ?? 'download', to: r.sent.to, sentId: r.sent.id });
    } catch (e) {
      out.failed.push({ invoiceId: item.invoiceId, number: item.number, ...failure(e) });
    }
  }
  return out;
}

/** Why an automatic Mahnung did not go: no address, mail not set up, the server refused, it went but was not recorded, or the invoice moved on meanwhile. */
export type AutoFailure = 'noAddress' | 'noMail' | 'refused' | 'unrecorded' | 'changed';
/**
 * What one round of automatic reminders did: sent, failed with why, `examined` the invoices it took
 * up and `deferred` those beyond its MAX_RUN (the next round's). `skipped`: nothing ran here, a
 * Durchsicht copy or a read-only start (`copy`), automatic reminders switched on on another computer
 * (`otherDevice`), or on none (`noDevice`).
 */
export interface AutoOutcome {
  sent: RunSent[];
  failed: Array<{ invoiceId: string; number: string; level: number; reason: AutoFailure; detail?: string; code?: string }>;
  examined: string[]; deferred: string[];
  skipped?: 'copy' | 'otherDevice' | 'noDevice';
}

/**
 * The automatic reminders of `today` (spec 4.4.7): each level «N Tage nach Fälligkeit» sends by mail
 * without a click, only on the computer that holds the books (decision 7.4): the one the levels were
 * switched to automatic on (`dunning.device`), never in a Durchsicht copy or a read-only start. Each
 * level once: the next round finds the level after it. At most MAX_RUN a round, the rest the next.
 * A Mahnung that cannot go (no address, no mail set up, refused) is a failure the caller makes a task
 * of; nothing is recorded for it, so the next round tries again.
 */
export async function autoReminders(ws: Workspace, opts: { today?: string; now?: string; printer?: Printer; mail?: MailReminder } = {}): Promise<AutoOutcome> {
  const none = (skipped?: AutoOutcome['skipped']): AutoOutcome => ({ sent: [], failed: [], examined: [], deferred: [], ...(skipped ? { skipped } : {}) });
  if (!holdsTheBooks(ws)) return none('copy');
  const dunning = dunningOf(ws);
  if (!dunning.levels.some((l) => l.auto)) return none();
  if (!dunning.device) return none('noDevice');
  if (dunning.device.id !== thisDevice(ws).id) return none('otherDevice');
  const now = opts.now ?? new Date().toISOString();
  const today = opts.today ?? now.slice(0, 10);
  const book = loadInvoices(ws);
  const due = autoDue(book, liveInvoices(book), dunning, today, new Set(readMailed(ws).map((m) => levelKey(m.invoiceId, m.level))));
  const take = due.slice(0, MAX_RUN);
  const out: AutoOutcome = { sent: [], failed: [], examined: take.map((i) => i.id), deferred: due.slice(MAX_RUN).map((i) => i.id) };
  const mail = opts.mail ?? mailReminder(ws);
  for (const inv of take) {
    const { level, def } = nextLevel(inv, dunning);
    const to = reminderAddress(book, inv);
    if (!to) { out.failed.push({ invoiceId: inv.id, number: inv.number, level, reason: 'noAddress' }); continue; }
    if (!canMail(ws)) { out.failed.push({ invoiceId: inv.id, number: inv.number, level, reason: 'noMail' }); continue; }
    try {
      const r = await sendReminder(ws, inv.id, { date: today, by: 'auto', expect: { level, draft: false } }, { now, ...(opts.printer ? { printer: opts.printer } : {}), deliver: mail(to, inv, { level, title: levelTitle(def, inv.language) }) });
      out.sent.push({ invoiceId: inv.id, number: inv.number, title: reminderTitle(r.reminder, inv.language), channel: 'email', to: r.sent.to, sentId: r.sent.id });
    } catch (e) {
      const code = failure(e).code;
      // Another round sent this level meanwhile, or the invoice was paid: nothing to do, and no task.
      if (code === 'levelChanged' || code === 'nothingOpen' || code === 'cancelled') continue;
      out.failed.push({ invoiceId: inv.id, number: inv.number, level, reason: code === 'recordFailed' ? 'unrecorded' : 'refused', detail: (e as Error).message, code });
    }
  }
  return out;
}

/** The device that holds the books: not a Durchsicht copy of someone else's, not a read-only start (decision 7.4). */
export const holdsTheBooks = (ws: Pick<Workspace, 'paths'>): boolean => !isDurchsicht(ws.paths.root) && process.env.READONLY !== '1';

// ─── Teilrechnungen, Schlussrechnung, Rückbehalt (spec 4.4.9) ─────────────────

/** A plan from a request: `[{ label, percent? | amount?, date? }]`. */
export function parseStages(v: unknown): Stage[] {
  if (!Array.isArray(v)) return bad('stages ist eine Liste { label, percent? | amount?, date? }.');
  return v.map((raw, k) => {
    const x = (raw ?? {}) as Record<string, unknown>;
    if (Object.keys(x).some((f) => !['label', 'percent', 'amount', 'date'].includes(f))) bad(`Stufe ${k + 1}: unbekannte Felder.`);
    if (!isText(x.label)) bad(`Stufe ${k + 1}: label ist ein Text.`);
    for (const f of ['percent', 'amount'] as const) if (x[f] !== undefined && (typeof x[f] !== 'number' || !Number.isFinite(x[f]))) bad(`Stufe ${k + 1}: ${f} ist eine Zahl.`);
    if (x.date !== undefined && !isDate(x.date)) bad(`Stufe ${k + 1}: date ist ein Datum JJJJ-MM-TT.`);
    return { label: (x.label as string).trim(), ...(x.percent !== undefined ? { percent: x.percent as number } : {}), ...(x.amount !== undefined ? { amount: x.amount as number } : {}), ...(x.date !== undefined ? { date: x.date as string } : {}) };
  });
}

/**
 * The Teilrechnungsplan of an Auftrag, a draft or issued (it prints nothing of it): the stages must
 * add up to its total (`stagesSum`). A stage invoiced already stays as it is, and stays in the plan
 * (`stageInvoiced`): what was invoiced is the Schlussrechnung's to deduct. An empty list removes the plan.
 */
export function setStages(ws: Workspace, id: string, stages: readonly Stage[]): Invoice {
  return updateInvoices(ws, (book) => {
    const order = findInvoice(book, id) ?? notFound('Auftrag');
    if (order.status === 'issued' && order.cancelled) throw new InvoiceRuleError('cancelled', `${order.number} ist storniert.`, undefined, { number: order.number });
    if (stages.length) checkPlan(order, stages);
    else if (order.kind !== 'sales-order') checkPlan(order, stages);
    const docs = liveDocuments(book);
    for (const s of stageStates(order, docs)) {
      if (!s.doc || s.last) continue;
      const now = stages[s.k];
      if (!now || JSON.stringify(now) !== JSON.stringify(s.stage)) throw new InvoiceRuleError('stageInvoiced', `Stufe ${s.k + 1} «${s.stage.label}» ist in Rechnung gestellt: sie bleibt, wie sie ist.`, undefined, { stage: s.k + 1, label: s.stage.label });
    }
    const { stages: _old, ...rest } = order;
    const next = (stages.length ? { ...rest, stages: [...stages] } : rest) as Invoice;
    book.invoices[book.invoices.indexOf(order)] = next;
    return next;
  });
}

/**
 * The Rechnung of stage `stage` of an Auftrag's plan: a Teilrechnung draft, or for the last stage the
 * Schlussrechnung (finalDraft). `confirm`: `partialDrafts`, the person's «Trotzdem erstellen».
 */
export function createStageInvoice(ws: Workspace, id: string, stage: number | 'final', confirm: readonly string[] = [], now = new Date().toISOString()): Draft {
  return updateInvoices(ws, (book) => {
    const order = findInvoice(book, id) ?? notFound('Auftrag');
    const docs = liveDocuments(book);
    const last = (order.stages?.length ?? 0) - 1;
    const envelope = newEnvelope('in', now);
    const draft = stage === 'final' || stage === last
      ? finalDraft(order, docs, envelope, now.slice(0, 10), confirm)
      : stageDraft(order, stage, docs, envelope, now.slice(0, 10));
    const contact = liveContacts(book).find((c) => c.id === draft.customerId);
    const terms = !draft.termsId && contact ? draftTermsOf(ws.invoicing, contact) : undefined;
    const done: Draft = { ...draft, ...(terms ? { termsId: terms } : {}) };
    book.invoices.push(done);
    return done;
  });
}

/** «Akontos abziehen» on a Schlussrechnung draft: the deductions of the contact's Teilrechnungen `ids` added at its end. */
export function addDeductions(ws: Workspace, id: string, ids: readonly string[]): Draft {
  return updateInvoices(ws, (book) => {
    const draft = findInvoice(book, id) ?? notFound('Rechnung');
    const next = withDeductions(draft, ids, liveDocuments(book));
    book.invoices[book.invoices.indexOf(draft)] = next;
    return next;
  });
}

/**
 * «Zahlungsaufforderung» (spec 4.4.9): the retention of an issued Rechnung asked for, with its own
 * QR-bill for what is open and the Rechnung's reference, so its payment is matched as the Rechnung's.
 * Recorded in the sent log as `instalment`; nothing is booked. Refused without a retention or with nothing open.
 */
export function sendInstalment(ws: Workspace, id: string, req: { date?: string; intro?: string; closing?: string; to?: string }, opts: { now?: string; printer?: Printer; deliver?: Deliver } = {}): Promise<SentDocument> {
  return serial(async () => {
    const now = opts.now ?? new Date().toISOString();
    const book = loadInvoices(ws);
    const inv = sendable(book, id);
    const date = req.date ?? now.slice(0, 10);
    if (!isDate(date)) bad('date ist ein Datum JJJJ-MM-TT.');
    if (inv.kind !== 'invoice' || !inv.schedule?.retention || openAmount(inv, liveInvoices(book)) === 0) {
      throw new InvoiceRuleError('noRetention', `Rechnung ${inv.number} hat keinen offenen Rückbehalt.`, undefined, { number: inv.number });
    }
    // Offered and sent from the retention's day only (spec 4.4.9); before it a reminder asks for what is due.
    if (!instalmentDue(inv, liveInvoices(book), date)) {
      throw new InvoiceRuleError('retentionNotDue', `Der Rückbehalt von ${inv.number} ist erst am ${inv.schedule.retention.until} fällig.`, undefined, { number: inv.number, date: inv.schedule.retention.until });
    }
    const sheet = instalmentSheet(book, inv, { date, ...(req.intro !== undefined ? { intro: req.intro } : {}), ...(req.closing !== undefined ? { closing: req.closing } : {}) }, logoSrc(ws, inv.layout.logo));
    const sent = await printOwnDocument(ws, inv, 'instalment', sheet, req.to, now, opts.printer ?? chromium, opts.deliver);
    return updateInvoices(ws, (fresh) => {
      sendable(fresh, id);
      fresh.sent.push(sent);
      return sent;
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
    ? reminderSheet(book, inv, draftIn(book, inv) ?? draftReminder(inv, liveInvoices(book), opts.reminder.date, dunningOf(ws), opts.reminder.fee !== undefined ? { fee: opts.reminder.fee } : {}), logo)
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
    interestAccount: interestAccount(s),
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
