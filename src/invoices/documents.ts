/**
 * What each document of an invoice shows (src/invoices/sheet.ts SheetData): a draft from the
 * workspace's current settings, an issued invoice or credit note from what it froze at issue,
 * a reminder and a cancellation notice from the issued invoice.
 */
import type { Company } from '../workspace/workspace.js';
import { DEFAULT_LAYOUT, type CustomerFields, type Draft, type Invoice, type InvoiceBook, type InvoiceContent, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings, type Issued, type Reminder, type Sender } from './model.js';
import { addDays, instalmentDue, openAmount, openCharges, paidAmount, retentionOf, skontoOffer, termsFor, totals } from './rules.js';
import type { SheetData } from './sheet.js';
import { TEXTS, formatAmount, formatDate, kindTitle, reminderTitle } from './texts.js';
import { recipientOf } from './contacts.js';
import { fillPlaceholders, templateOf, templateText, type PlaceholderValues } from './templates.js';

export interface InvoicingContext { company: Company; settings: InvoicingSettings | undefined }

/** The company as an invoice in `currency` names it now; payTo absent when the workspace sets no account for that currency. */
export function senderFor(ctx: InvoicingContext, currency: InvoiceCurrency): Omit<Sender, 'payTo'> & { payTo?: Sender['payTo'] } {
  const { company } = ctx;
  const payTo = ctx.settings?.payTo[currency];
  return {
    name: company.name,
    address: company.address ?? { postcode: '', town: '', country: 'CH' },
    uid: company.uid ?? '',
    ...(payTo ? { payTo } : {}),
  };
}

/**
 * The texts above and below the table and the title: the Vorlage's for the kind and language
 * (Firma › Vorlagen), else the workspace's own of the language (an invoice's), else the app's.
 * `{days}` is the payment term; the other placeholders are filled when the document is issued
 * (src/invoices/templates.ts fillPlaceholders). `salutation`: the greeting line above the intro of
 * an invoice, a setting of its own so a greeting never replaces the intro; none unless the
 * workspace sets one. `title`: absent where the Vorlage names none (the kind's word prints).
 */
export function defaultTexts(ctx: InvoicingContext, kind: InvoiceContent['kind'], lang: InvoiceLanguage, days: number, printAs?: InvoiceContent['printAs'], templateId?: string): { salutation: string; intro: string; closing: string; title?: string } {
  const base = builtInDefaults(ctx, kind, lang, days, printAs);
  const tpl = templateOf(ctx.settings, { kind, templateId });
  const own = (k: 'title' | 'intro' | 'closing') => templateText(tpl, kind, lang, k);
  const title = own('title');
  return { ...base, intro: own('intro') ?? base.intro, closing: (own('closing') ?? base.closing).replaceAll('{days}', String(days)), ...(title ? { title } : {}) };
}

function builtInDefaults(ctx: InvoicingContext, kind: InvoiceContent['kind'], lang: InvoiceLanguage, days: number, printAs?: InvoiceContent['printAs']): { salutation: string; intro: string; closing: string } {
  const L = TEXTS[lang];
  if (kind === 'credit-note') return { salutation: '', intro: '', closing: L.creditClosing };
  // An Angebot, Auftrag and Lieferschein speak of themselves; the firm's own texts are those of its invoices.
  if (kind !== 'invoice') {
    const which = kind === 'sales-order' && printAs === 'proforma' ? 'proforma' : kind;
    return { salutation: ctx.settings?.texts[lang]?.salutation ?? '', intro: L.kindIntro[which], closing: L.kindClosing[which] };
  }
  const own = ctx.settings?.texts[lang];
  return { salutation: own?.salutation ?? '', intro: own?.intro ?? L.intro, closing: (own?.closing ?? L.closing(days)).replaceAll('{days}', String(days)) };
}

/** What a Vorlage's placeholders stand for on an issued document (or a draft, where its number and due date may be unknown). */
export function placeholderValues(doc: Pick<InvoiceContent, 'lines' | 'prices' | 'currency'> & { number?: string; dueDate?: string; customer?: CustomerFields }, company?: string, person?: string): PlaceholderValues {
  return {
    person: person ?? doc.customer?.person ?? doc.customer?.name,
    ...(doc.number ? { number: doc.number } : {}),
    ...(doc.dueDate ? { dueDate: doc.dueDate } : {}),
    total: { amount: totals(doc).gross, currency: doc.currency },
    ...(company ? { company } : {}),
  };
}

/** The intro an invoice is issued with: the greeting line, then the intro. */
export const issuedIntro = (salutation: string, intro: string): string => [salutation.trim(), intro].filter(Boolean).join('\n\n');

function creditInfo(book: InvoiceBook, c: InvoiceContent): SheetData['credit'] {
  const target = book.invoices.find((i) => i.id === c.creditFor);
  if (!target || target.status !== 'issued') return undefined;
  const last = target.payments.at(-1);
  return { number: target.number, date: target.date, gross: totals(target).gross, paid: paidAmount(target), ...(last ? { paidDate: last.date } : {}), ...(c.settlement ? { settlement: c.settlement } : {}) };
}

export type MailDocument = { kind: 'invoice' } | { kind: 'reminder'; level: number; title?: string } | { kind: 'cancellation' } | { kind: 'instalment' };

/**
 * The subject and text of the e-mail that sends a document: its Vorlage's for the kind and
 * language (Firma › Vorlagen), else the language's own texts (Firma › Rechnungslayout), else the
 * app's, with {document}, {company} and the Vorlage's placeholders filled in.
 */
export function mailText(settings: InvoicingSettings | undefined, inv: Issued, doc: MailDocument, company: string): { subject: string; body: string } {
  const L = TEXTS[inv.language];
  const own = settings?.texts[inv.language];
  const what = `${inv.title ?? kindTitle(L, inv.kind, inv.printAs, inv.role)} ${inv.number}`;
  const document = doc.kind === 'reminder' ? `${doc.title ?? L.reminder(doc.level)} · ${what}`
    : doc.kind === 'instalment' ? `${L.instalment} · ${what}`
    : doc.kind === 'cancellation' ? L.cancelNotice(inv.number, formatDate(inv.date, inv.language))
    : what;
  const values = { ...placeholderValues(inv, company), document, company };
  const fill = (s: string) => fillPlaceholders(s, values, inv.language);
  // A Mahnstufe's own mail texts come first (Firma › Rechnungslayout › Mahnwesen), with the same placeholders.
  const level = doc.kind === 'reminder' ? settings?.dunning?.levels[doc.level - 1]?.texts?.[inv.language] : undefined;
  // The document's own mail is its Vorlage's (Firma › Vorlagen); a Mahnung and a notice speak of themselves.
  const tpl = doc.kind === 'invoice' ? templateOf(settings, inv) : undefined;
  const mine = (k: 'mailSubject' | 'mailBody') => level?.[k] || (tpl ? templateText(tpl, inv.kind, inv.language, k) : undefined);
  return { subject: fill(mine('mailSubject') ?? own?.mailSubject ?? L.mailSubject), body: fill(mine('mailBody') ?? own?.mailBody ?? L.mailBody) };
}

/** The days a draft gives to pay: those of the terms it picks, else the customer's, else the firm's. */
export function draftDays(ctx: InvoicingContext, draft: Pick<Draft, 'kind' | 'termsId' | 'language'>, customer: Pick<CustomerFields, 'paymentTermsDays'> | undefined): number {
  const days = customer?.paymentTermsDays ?? ctx.settings?.paymentTermsDays ?? 30;
  return ctx.settings?.paymentTerms.find((x) => x.id === draft.termsId)?.days ?? days;
}

/** What the paper says of the terms: their text, and the Skonto with its last day and amount. */
function termsOnPaper(inv: Pick<Issued, 'date' | 'terms' | 'lines' | 'prices' | 'kind'>): SheetData['terms'] {
  if (!inv.terms) return undefined;
  const sk = skontoOffer(inv);
  return { text: inv.terms.text, ...(sk && inv.terms.skonto ? { skonto: { percent: inv.terms.skonto.percent, until: sk.until, amount: sk.amount, pays: sk.pays } } : {}) };
}

/** `customer`: the recipient as the draft prints it now (src/invoices/contacts.ts recipientOf). */
export function draftSheet(ctx: InvoicingContext, book: InvoiceBook, draft: Draft, customer: CustomerFields | undefined, logoSrc?: string): SheetData {
  const terms = draftDays(ctx, draft, customer);
  const texts = defaultTexts(ctx, draft.kind, draft.language, terms, draft.printAs, draft.templateId);
  const tpl = templateOf(ctx.settings, draft);
  const title = draft.title ?? texts.title;
  const picked = ctx.settings?.paymentTerms.some((x) => x.id === draft.termsId) ? termsFor(draft, ctx.settings?.paymentTerms, terms) : undefined;
  return {
    kind: draft.kind,
    ...kindFacts(draft),
    language: draft.language,
    date: draft.date,
    ...(draft.supplied ? { supplied: draft.supplied } : {}),
    ...(draft.kind === 'invoice' ? { dueDate: draft.dueDate ?? addDays(draft.date, terms) } : {}),
    currency: draft.currency,
    customer: customer ?? { name: '', address: { postcode: '', town: '', country: 'CH' }, language: draft.language, paymentTermsDays: terms },
    sender: senderFor(ctx, draft.currency),
    lines: draft.lines,
    ...(draft.prices ? { prices: draft.prices } : {}),
    ...(ctx.settings ? { units: ctx.settings.units } : {}),
    ...(draft.exemption ? { exemption: draft.exemption } : {}),
    ...(texts.salutation ? { salutation: texts.salutation } : {}),
    intro: draft.intro ?? texts.intro,
    closing: draft.closing ?? texts.closing,
    ...(title ? { title } : {}),
    layout: ctx.settings ? tpl.layout : DEFAULT_LAYOUT,
    ...(tpl.letterhead ? { letterhead: tpl.letterhead } : {}),
    ...(logoSrc ? { logoSrc } : {}),
    ...(draft.kind === 'credit-note' ? { credit: creditInfo(book, draft) } : {}),
    ...(picked ? { terms: termsOnPaper({ ...draft, terms: picked }) } : {}),
  };
}

/** What the paper names of a document's kind: an Auftrag's print variant, an Angebot's last day, the customer's order reference, a Teil- or Schlussrechnung and its retention. */
const kindFacts = (d: InvoiceContent): Pick<SheetData, 'printAs' | 'validUntil' | 'ordered' | 'role' | 'retention'> => ({
  ...(d.kind === 'sales-order' && d.printAs ? { printAs: d.printAs } : {}),
  ...(d.kind === 'quote' && d.validUntil ? { validUntil: d.validUntil } : {}),
  ...(d.ordered ? { ordered: d.ordered } : {}),
  ...(d.kind === 'invoice' && d.role ? { role: d.role } : {}),
  ...(d.kind === 'invoice' && d.schedule?.retention ? { retention: { ...d.schedule.retention, amount: retentionOf(d) } } : {}),
});

/** An issued invoice or credit note as it was issued; `cancelled` shows the stamp (the cancellation notice). */
export function issuedSheet(book: InvoiceBook, inv: Issued, logoSrc?: string): SheetData {
  return {
    kind: inv.kind,
    ...kindFacts(inv),
    language: inv.language,
    number: inv.number,
    date: inv.date,
    ...(inv.supplied ? { supplied: inv.supplied } : {}),
    ...(inv.kind === 'invoice' ? { dueDate: inv.dueDate } : {}),
    currency: inv.currency,
    customer: inv.customer,
    sender: inv.sender,
    lines: inv.lines,
    ...(inv.prices ? { prices: inv.prices } : {}),
    ...(inv.units ? { units: inv.units } : {}),
    ...(inv.exemption ? { exemption: inv.exemption } : {}),
    intro: inv.intro ?? '',
    closing: inv.closing ?? '',
    ...(inv.title ? { title: inv.title } : {}),
    layout: inv.layout,
    ...(inv.letterhead ? { letterhead: inv.letterhead.file } : {}),
    ...(logoSrc ? { logoSrc } : {}),
    reference: inv.reference,
    ...(inv.kind === 'credit-note' ? { credit: creditInfo(book, inv) } : {}),
    ...(inv.cancelled ? { cancelled: inv.cancelled } : {}),
    ...(inv.terms?.skonto ? { terms: termsOnPaper(inv) } : {}),
  };
}

/**
 * A reminder: the invoice's lines and reference, what is still open with the fees and default
 * interest (this one's with those sent before), its own title, date, due date and texts.
 */
export function reminderSheet(book: InvoiceBook, inv: Issued, reminder: Reminder, logoSrc?: string): SheetData {
  // As sent, or as it would be sent: a draft, or one not stored yet, counts with the Mahnungen sent before it.
  const sent = inv.reminders.filter((r) => r.documentId);
  const k = reminder.documentId ? sent.findIndex((r) => r.documentId === reminder.documentId) : -1;
  const upTo = k >= 0 ? sent.slice(0, k + 1) : [...sent, { ...reminder, documentId: 'this' }];
  const withThis: Issued = { ...inv, reminders: upTo };
  const open = openAmount(withThis, book.invoices);
  const charges = openCharges(withThis);
  const gross = totals(inv).gross;
  const interest = charges.interest && reminder.interest ? { amount: charges.interest, rate: reminder.interest.rate, from: reminder.interest.from, days: reminder.interest.days } : undefined;
  // Before the retention's day a reminder asks for what is due now (open less the retention), its fees and interest on top, and names the retention.
  const r = inv.schedule?.retention;
  const held = r && r.until > reminder.date && open > retentionOf(inv) ? retentionOf(inv) : 0;
  const { retention: _r, ...sheet } = issuedSheet(book, inv, logoSrc);
  return {
    ...(held ? sheet : issuedSheet(book, inv, logoSrc)),
    reminderTitle: reminderTitle(reminder, inv.language),
    date: reminder.date,
    dueDate: reminder.dueDate,
    intro: reminder.intro,
    closing: reminder.closing,
    due: {
      paidSoFar: Math.round((gross - open) * 100) / 100, fee: charges.fee, ...(interest ? { interest } : {}),
      ...(held && r ? { held: { amount: held, until: r.until, percent: r.percent } } : {}),
      open: Math.round((open - held + charges.fee + charges.interest) * 100) / 100,
    },
  };
}

/** The days a Zahlungsaufforderung gives to pay, as a reminder does. */
export const INSTALMENT_DAYS = 10;

/**
 * A Zahlungsaufforderung (spec 4.4.9): the Rechnung's lines and reference, what is paid and what is
 * still open (the retention), its own date, due date and texts; its payment part asks for what is open.
 */
export function instalmentSheet(book: InvoiceBook, inv: Issued, at: { date: string; intro?: string; closing?: string }, logoSrc?: string): SheetData {
  const L = TEXTS[inv.language];
  const open = openAmount(inv, book.invoices);
  const gross = totals(inv).gross;
  // The retention, or what is open when less; what else is open is named, not asked here (a reminder asks it).
  const due = instalmentDue(inv, book.invoices, at.date) ?? { amount: Math.min(open, retentionOf(inv)), more: Math.max(0, Math.round((open - retentionOf(inv)) * 100) / 100) };
  const { retention: _r, ...sheet } = issuedSheet(book, inv, logoSrc);
  const more = due.more > 0 ? ` ${L.instalmentMore(`${inv.currency} ${formatAmount(due.more, inv.language)}`)}` : '';
  return {
    ...sheet,
    instalment: true,
    date: at.date,
    dueDate: addDays(at.date, INSTALMENT_DAYS),
    intro: at.intro ?? L.instalmentIntro(inv.number, formatDate(inv.date, inv.language), formatDate(inv.schedule?.retention?.until ?? inv.dueDate, inv.language)) + more,
    closing: at.closing ?? L.instalmentClosing,
    due: { paidSoFar: Math.round((gross - open) * 100) / 100, fee: 0, open: due.amount, ...(due.more > 0 ? { notAsked: due.more } : {}) },
  };
}

/** The sheet of any invoice record: a draft with today's settings, an issued one as issued. */
export function sheetOf(ctx: InvoicingContext, book: InvoiceBook, inv: Invoice, logoSrc?: string): SheetData {
  if (inv.status === 'issued') return issuedSheet(book, inv, logoSrc);
  return draftSheet(ctx, book, inv, recipientOf(book.contacts.find((c) => c.id === inv.customerId), inv, ctx.settings), logoSrc);
}
