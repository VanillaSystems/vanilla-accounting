/**
 * What each document of an invoice shows (src/invoices/sheet.ts SheetData): a draft from the
 * workspace's current settings, an issued invoice or credit note from what it froze at issue,
 * a reminder and a cancellation notice from the issued invoice.
 */
import type { Company } from '../workspace/workspace.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type Invoice, type InvoiceBook, type InvoiceContent, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings, type Issued, type Reminder, type Sender } from './model.js';
import { addDays, openAmount, openFees, paidAmount, totals } from './rules.js';
import type { SheetData } from './sheet.js';
import { TEXTS, formatDate } from './texts.js';

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
 * The texts above and below the table: the workspace's own for the language, else the app's.
 * `{days}` is the payment term. `salutation`: the greeting line above the intro of an invoice, a
 * setting of its own so a greeting never replaces the intro; none unless the workspace sets one.
 */
export function defaultTexts(ctx: InvoicingContext, kind: InvoiceContent['kind'], lang: InvoiceLanguage, days: number): { salutation: string; intro: string; closing: string } {
  const L = TEXTS[lang];
  if (kind === 'credit-note') return { salutation: '', intro: '', closing: L.creditClosing };
  const own = ctx.settings?.texts[lang];
  return { salutation: own?.salutation ?? '', intro: own?.intro ?? L.intro, closing: (own?.closing ?? L.closing(days)).replaceAll('{days}', String(days)) };
}

/** The intro an invoice is issued with: the greeting line, then the intro. */
export const issuedIntro = (salutation: string, intro: string): string => [salutation.trim(), intro].filter(Boolean).join('\n\n');

function creditInfo(book: InvoiceBook, c: InvoiceContent): SheetData['credit'] {
  const target = book.invoices.find((i) => i.id === c.creditFor);
  if (!target || target.status !== 'issued') return undefined;
  const last = target.payments.at(-1);
  return { number: target.number, date: target.date, gross: totals(target.lines).gross, paid: paidAmount(target), ...(last ? { paidDate: last.date } : {}), ...(c.settlement ? { settlement: c.settlement } : {}) };
}

export type MailDocument = { kind: 'invoice' } | { kind: 'reminder'; level: number } | { kind: 'cancellation' };

/**
 * The subject and text of the e-mail that sends a document: the language's own texts
 * (Firma › Rechnungslayout), else the app's, with {document} and {company} filled in.
 */
export function mailText(settings: InvoicingSettings | undefined, inv: Issued, doc: MailDocument, company: string): { subject: string; body: string } {
  const L = TEXTS[inv.language];
  const own = settings?.texts[inv.language];
  const what = `${inv.kind === 'credit-note' ? L.credit : L.invoice} ${inv.number}`;
  const document = doc.kind === 'reminder' ? `${L.reminder(doc.level)} · ${what}`
    : doc.kind === 'cancellation' ? L.cancelNotice(inv.number, formatDate(inv.date, inv.language))
    : what;
  const fill = (s: string) => s.replaceAll('{document}', document).replaceAll('{company}', company);
  return { subject: fill(own?.mailSubject ?? L.mailSubject), body: fill(own?.mailBody ?? L.mailBody) };
}

export function draftSheet(ctx: InvoicingContext, book: InvoiceBook, draft: Draft, customer: Customer | undefined, logoSrc?: string): SheetData {
  const terms = customer?.paymentTermsDays ?? ctx.settings?.paymentTermsDays ?? 30;
  const texts = defaultTexts(ctx, draft.kind, draft.language, terms);
  return {
    kind: draft.kind,
    language: draft.language,
    date: draft.date,
    ...(draft.supplied ? { supplied: draft.supplied } : {}),
    ...(draft.kind === 'invoice' ? { dueDate: draft.dueDate ?? addDays(draft.date, terms) } : {}),
    currency: draft.currency,
    customer: customer ?? { name: '', address: { postcode: '', town: '', country: 'CH' }, language: draft.language, paymentTermsDays: terms },
    sender: senderFor(ctx, draft.currency),
    lines: draft.lines,
    ...(draft.exemption ? { exemption: draft.exemption } : {}),
    ...(texts.salutation ? { salutation: texts.salutation } : {}),
    intro: draft.intro ?? texts.intro,
    closing: draft.closing ?? texts.closing,
    layout: ctx.settings?.layout ?? DEFAULT_LAYOUT,
    ...(logoSrc ? { logoSrc } : {}),
    ...(draft.kind === 'credit-note' ? { credit: creditInfo(book, draft) } : {}),
  };
}

/** An issued invoice or credit note as it was issued; `cancelled` shows the stamp (the cancellation notice). */
export function issuedSheet(book: InvoiceBook, inv: Issued, logoSrc?: string): SheetData {
  return {
    kind: inv.kind,
    language: inv.language,
    number: inv.number,
    date: inv.date,
    ...(inv.supplied ? { supplied: inv.supplied } : {}),
    ...(inv.kind === 'invoice' ? { dueDate: inv.dueDate } : {}),
    currency: inv.currency,
    customer: inv.customer,
    sender: inv.sender,
    lines: inv.lines,
    ...(inv.exemption ? { exemption: inv.exemption } : {}),
    intro: inv.intro ?? '',
    closing: inv.closing ?? '',
    layout: inv.layout,
    ...(logoSrc ? { logoSrc } : {}),
    reference: inv.reference,
    ...(inv.kind === 'credit-note' ? { credit: creditInfo(book, inv) } : {}),
    ...(inv.cancelled ? { cancelled: inv.cancelled } : {}),
  };
}

/** A reminder: the invoice's lines and reference, what is still open with the fees, its own date, due date and texts. */
export function reminderSheet(book: InvoiceBook, inv: Issued, reminder: Omit<Reminder, 'documentId'>, logoSrc?: string): SheetData {
  const withThis = inv.reminders.some((r) => r.level === reminder.level && r.date === reminder.date) ? inv : { ...inv, reminders: [...inv.reminders, { ...reminder, documentId: '' }] };
  const open = openAmount(withThis, book.invoices);
  const fee = openFees(withThis);
  const gross = totals(inv.lines).gross;
  return {
    ...issuedSheet(book, inv, logoSrc),
    reminderLevel: reminder.level,
    date: reminder.date,
    dueDate: reminder.dueDate,
    intro: reminder.intro,
    closing: reminder.closing,
    due: { paidSoFar: Math.round((gross - open) * 100) / 100, fee, open: Math.round((open + fee) * 100) / 100 },
  };
}

/** The sheet of any invoice record: a draft with today's settings, an issued one as issued. */
export function sheetOf(ctx: InvoicingContext, book: InvoiceBook, inv: Invoice, logoSrc?: string): SheetData {
  if (inv.status === 'issued') return issuedSheet(book, inv, logoSrc);
  return draftSheet(ctx, book, inv, book.customers.find((c) => c.id === inv.customerId), logoSrc);
}
