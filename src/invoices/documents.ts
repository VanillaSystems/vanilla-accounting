/**
 * What each document of an invoice shows (src/invoices/sheet.ts SheetData): a draft from the
 * workspace's current settings, an issued invoice or credit note from what it froze at issue,
 * a reminder and a cancellation notice from the issued invoice.
 */
import type { Company } from '../workspace/workspace.js';
import { DEFAULT_LAYOUT, type CustomerFields, type Draft, type Invoice, type InvoiceBook, type InvoiceContent, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings, type Issued, type Letterhead, type Reminder, type Sender } from './model.js';
import { accountOnPaper, addDays, paymentToNewAccount, instalmentDue, openAmount, openCharges, paidAmount, retentionOf, skontoOffer, termsFor, totals } from './rules.js';
import type { SheetData } from './sheet.js';
import { TEXTS, formatAmount, formatDate, kindTitle, reminderTitle } from './texts.js';
import { recipientOf } from './contacts.js';
import { contactOnDay } from './dated-values.js';

/** What a document reads of the firm on its date (spec 4.12): the settings and the letterhead of that day; `letterhead` absent: the company's. */
export interface InvoicingContext { company: Company; settings: InvoicingSettings | undefined; letterhead?: Letterhead }

/** The company as an invoice in `currency` names it now; payTo absent when the workspace sets no account for that currency. */
export function senderFor(ctx: InvoicingContext, currency: InvoiceCurrency): Omit<Sender, 'payTo'> & { payTo?: Sender['payTo'] } {
  const head = ctx.letterhead ?? { name: ctx.company.name, address: ctx.company.address, uid: ctx.company.uid };
  const payTo = ctx.settings?.payTo[currency];
  return {
    name: head.name,
    address: head.address ?? { postcode: '', town: '', country: 'CH' },
    uid: head.uid ?? '',
    ...(payTo ? { payTo } : {}),
  };
}

/**
 * The texts above and below the table: the workspace's own for the language, else the app's.
 * `{days}` is the payment term. `salutation`: the greeting line above the intro of an invoice, a
 * setting of its own so a greeting never replaces the intro; none unless the workspace sets one.
 */
export function defaultTexts(ctx: InvoicingContext, kind: InvoiceContent['kind'], lang: InvoiceLanguage, days: number, printAs?: InvoiceContent['printAs']): { salutation: string; intro: string; closing: string } {
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
 * The subject and text of the e-mail that sends a document: the language's own texts
 * (Firma › Rechnungslayout), else the app's, with {document} and {company} filled in.
 */
export function mailText(settings: InvoicingSettings | undefined, inv: Issued, doc: MailDocument, company: string): { subject: string; body: string } {
  const L = TEXTS[inv.language];
  const own = settings?.texts[inv.language];
  const what = `${kindTitle(L, inv.kind, inv.printAs, inv.role)} ${inv.number}`;
  const document = doc.kind === 'reminder' ? `${doc.title ?? L.reminder(doc.level)} · ${what}`
    : doc.kind === 'instalment' ? `${L.instalment} · ${what}`
    : doc.kind === 'cancellation' ? L.cancelNotice(inv.number, formatDate(inv.date, inv.language))
    : what;
  const fill = (s: string) => s.replaceAll('{document}', document).replaceAll('{company}', company);
  // A Mahnstufe's own mail texts come first (Firma › Rechnungslayout › Mahnwesen).
  const level = doc.kind === 'reminder' ? settings?.dunning?.levels[doc.level - 1]?.texts?.[inv.language] : undefined;
  return { subject: fill(level?.mailSubject || (own?.mailSubject ?? L.mailSubject)), body: fill(level?.mailBody || (own?.mailBody ?? L.mailBody)) };
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
  const texts = defaultTexts(ctx, draft.kind, draft.language, terms, draft.printAs);
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
    layout: ctx.settings?.layout ?? DEFAULT_LAYOUT,
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
    layout: inv.layout,
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

/**
 * «Zahlungsaufforderung mit neuer IBAN» (spec 4.12): the invoice with what is still open, dated
 * `date`, paid to `payTo` (the account valid on that day). Its reference stays where the new account
 * takes it (the payment part's rule: paymentToNewAccount of its provider); where it
 * cannot, the notice names the account and the number, and its payment is matched by number and amount.
 */
export function payToNoticeSheet(book: InvoiceBook, inv: Issued, payTo: Sender['payTo'], date: string, logoSrc?: string): SheetData {
  const L = TEXTS[inv.language];
  const { to, reference } = paymentToNewAccount(inv.reference, payTo);
  const open = openAmount(inv, book.invoices);
  // What a Mahnung charged and is still open goes with it, as it would on the next Mahnung.
  const charges = openCharges(inv);
  const gross = totals(inv).gross;
  return {
    ...issuedSheet(book, inv, logoSrc),
    payToNotice: true,
    date,
    sender: { ...inv.sender, payTo: to },
    reference,
    intro: L.payToNoticeIntro(inv.number, formatDate(inv.date, inv.language), accountOnPaper(to).replace(/(.{4})(?!$)/g, '$1 ')),
    due: { paidSoFar: Math.round((gross - open) * 100) / 100, fee: charges.fee, open: Math.round((open + charges.fee + charges.interest) * 100) / 100 },
  };
}

/** The sheet of any invoice record: a draft with today's settings, an issued one as issued. */
export function sheetOf(ctx: InvoicingContext, book: InvoiceBook, inv: Invoice, logoSrc?: string): SheetData {
  if (inv.status === 'issued') return issuedSheet(book, inv, logoSrc);
  return draftSheet(ctx, book, inv, recipientOf(contactOnDay(book.contacts.find((c) => c.id === inv.customerId), inv.date), inv, ctx.settings), logoSrc);
}
