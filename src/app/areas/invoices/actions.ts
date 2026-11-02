/**
 * What the buttons of Rechnungen do: each call goes to the invoicing API, its refusal is shown
 * in the user's language (Art. 26 MWSTG gaps named one by one), and the records are read again.
 */
import { issuedPdfUrl, sentPdfUrl, type Customer, type CustomerFields, type Draft, type Invoice, type InvoiceLine, type Issued } from '../../../invoices/model.js';
import type { MailMessage } from '../../../invoices/mail.js';
import { api, errorText, type CreditInput, type DraftChange } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { localToday, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import type { Location } from '../../shell/route.js';
import { setUi } from './state.js';
import { edits, put, reloadInvoices } from './data.js';
import { inOrder } from '../../lib/in-order.js';
import { customerChange, routeId } from './model.js';
import { filing, invoiceRates, invoicing } from '../../../engines/index.js';
import { desktop } from '../../desktop/bridge.js';

export const invoicePath = (inv: Invoice) => ({ area: 'invoices' as const, view: 'list' as const, id: routeId(inv) });

/** An invoice's link in a period that holds its date (a draft shows in every period). */
export const invoiceAt = (inv: Invoice, current?: Period): Location =>
  ({ route: invoicePath(inv), query: inv.status === 'draft' && current ? { period: current } : { period: parsePeriod(periodContaining(inv.date, current, filing().length), localToday()) ?? undefined } });

/** The line a new draft starts with, its text ready to be typed over; no unit until one is picked (a discount has none). */
export const firstLine = (zero: boolean): InvoiceLine => ({ text: t('invoices.newLine'), quantity: 1, price: 0, vatRate: zero ? 0 : invoiceRates()[0] });

async function run<T>(nav: Nav, call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (e) {
    nav.toast(errorText(e));
    return undefined;
  }
}

export async function newDraft(nav: Nav, customer: Pick<Customer, 'id' | 'name'>, input: DraftChange = {}): Promise<Draft | undefined> {
  const draft = await run(nav, api.createDraft({ ...input, customerId: customer.id }));
  if (!draft) return undefined;
  put({ invoice: draft });
  setUi({ focus: 'l:0:text', preview: false });
  nav.select(invoicePath(draft));
  void reloadInvoices();
  return draft;
}

/** A new draft for `c`: one line to type over, the customer's language, 0 % for a customer abroad. */
export const newDraftFor = (nav: Nav, c: Pick<Customer, 'id' | 'name' | 'language' | 'address'>) =>
  newDraft(nav, c, { lines: [firstLine(false)], ...customerChange({ lines: [firstLine(false)], currency: 'CHF' }, c) });

const draftSaves = inOrder();

/** A draft changed on the sheet: shown at once, saved behind it, one save after the other; only the last answer is shown. */
export async function saveDraft(nav: Nav, draft: Draft, patch: DraftChange): Promise<void> {
  const local = { ...draft } as Draft & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete local[k]; else local[k] = v; }
  put({ invoice: local });
  const { result: saved, latest } = await edits.saving(draft.id, draftSaves(draft.id, () => run(nav, api.patchDraft(draft.id, patch))));
  if (!latest) return;
  if (saved) put({ invoice: saved });
  else void reloadInvoices();
}

export async function deleteDraft(nav: Nav, draft: Draft, next?: Invoice): Promise<void> {
  if (!(await run(nav, api.deleteDraft(draft.id)))) return;
  await reloadInvoices();
  nav.select(next ? invoicePath(next) : { area: 'invoices', view: 'list' });
  const { id: _id, createdAt: _c, origin: _o, deleted: _d, status: _s, comments: _cm, kind: _k, creditFor: _cf, ...content } = draft;
  // A credit note is drafted from its invoice only; any other draft comes back as it was.
  nav.toast(t('invoices.draftDeleted'), draft.kind === 'credit-note' ? undefined : () => { void newDraft(nav, { id: draft.customerId, name: '' }, content); });
}

/** Issues the draft and shows it in a period that holds its date (F10): the period on screen, `current`, when it does. */
export async function issue(nav: Nav, draft: Draft, current: Period): Promise<Issued | undefined> {
  const issued = await run(nav, api.issue(draft.id));
  if (!issued) return undefined;
  await reloadInvoices();
  nav.go(invoiceAt(issued, current));
  nav.toast(t(issued.kind === 'credit-note' ? 'invoices.creditIssued' : 'invoices.issued', { number: issued.number }));
  return issued;
}

/**
 * The PDF saved where the person says: in the Mac app through the Save dialog, which tells whether
 * it was saved; in a browser by its download, which does not.
 */
async function savePdf(href: string, name: string): Promise<boolean> {
  if (desktop?.saveFile) return desktop.saveFile(href, name);
  download(href, name);
  return true;
}

function download(href: string, name: string): void {
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * The issued PDF goes out by e-mail through the company's mailbox, or is saved here to be sent
 * otherwise; either way it is recorded with its bytes. A failed e-mail records nothing.
 */
export async function send(nav: Nav, inv: Issued, email?: MailMessage): Promise<boolean> {
  // Cancelled in the Save dialog: nothing went out, nothing is recorded.
  if (!email && !(await savePdf(issuedPdfUrl(inv.number), `${inv.number}.pdf`))) return false;
  const doc = await run(nav, api.recordSend(inv.id, email ? { email } : { to: 'download' }));
  if (!doc) return false;
  await reloadInvoices();
  nav.toast(email ? t('invoices.mailed', { number: inv.number, to: doc.to }) : t(doc.kind === 'resend' ? 'invoices.resent' : 'invoices.sent', { number: inv.number }));
  return true;
}

export async function copyAsDraft(nav: Nav, inv: Issued): Promise<void> {
  const { customerId, currency, language, subject, lines, intro, closing, exemption } = inv;
  const lines2 = inv.kind === 'credit-note' ? lines.map((l) => ({ ...l, price: -l.price })) : lines;
  const draft = await newDraft(nav, { id: customerId, name: inv.customer.name }, { currency, language, lines: lines2, ...(subject ? { subject } : {}), ...(intro ? { intro } : {}), ...(closing ? { closing } : {}), ...(exemption ? { exemption } : {}) });
  if (draft) nav.toast(t('invoices.copied', { number: inv.number }));
}

export async function cancel(nav: Nav, inv: Issued, input: { date: string; reason: string; notify: boolean }, email?: MailMessage): Promise<boolean> {
  const done = await run(nav, api.cancelInvoice(inv.id, { ...input, ...(input.notify ? (email ? { email } : { to: 'download' }) : {}) }));
  if (!done) return false;
  if (done.sent && !email) download(sentPdfUrl(done.sent.id), `${done.sent.title}.pdf`);
  await reloadInvoices();
  nav.toast(done.sent && email ? t('invoices.cancelledMailed', { number: inv.number, to: done.sent.to }) : t(done.sent ? 'invoices.cancelledNotice' : 'invoices.cancelled', { number: inv.number }));
  return true;
}

export async function creditNote(nav: Nav, inv: Issued, input: CreditInput): Promise<boolean> {
  const draft = await run(nav, api.creditNote(inv.id, input));
  if (!draft) return false;
  await reloadInvoices();
  nav.select(invoicePath(draft));
  nav.toast(t('invoices.creditDrafted', { number: inv.number }));
  return true;
}

export async function sendReminder(nav: Nav, inv: Issued, input: { fee?: number; intro?: string; closing?: string }, email?: MailMessage): Promise<boolean> {
  const done = await run(nav, api.sendReminder(inv.id, { ...input, ...(email ? { email } : { to: 'download' }) }));
  if (!done) return false;
  if (!email) download(sentPdfUrl(done.sent.id), `${done.sent.title}.pdf`);
  await reloadInvoices();
  nav.toast(email ? t('invoices.reminderMailed', { level: done.reminder.level, number: inv.number, to: done.sent.to }) : t('invoices.reminderSent', { level: done.reminder.level, number: inv.number }));
  return true;
}

export async function comment(nav: Nav, inv: Invoice, text: string): Promise<boolean> {
  if (!(await run(nav, api.addComment(inv.id, text)))) return false;
  await reloadInvoices();
  return true;
}

/** A payment linked to a document: booked from it, or, when a person booked the payment already, allocated with her booking kept (r9c-3). */
export async function confirmPayment(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, ref: string): Promise<boolean> {
  const out = await run(nav, api.confirmPayment(inv.id, ref));
  if (!out) return false;
  await reloadInvoices();
  nav.refresh();
  nav.toast(t(out.paid.some((p) => p.booked) ? 'invoices.paymentConfirmed' : 'invoices.paymentLinked', { number: inv.number }));
  return true;
}

/** «Lösen» (r10c-3): the payment leaves the invoice, the link's bookings go; the toast's undo links it again. */
export async function releasePayment(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, ref: string): Promise<boolean> {
  const out = await run(nav, api.releasePayment(inv.id, ref));
  if (!out) return false;
  await reloadInvoices();
  nav.refresh();
  nav.toast(t(out.restored.length ? 'invoices.paymentReleasedRestored' : 'invoices.paymentReleased', { number: inv.number }), () => { void confirmPayment(nav, inv, ref); });
  return true;
}

export async function saveCustomer(nav: Nav, id: string | undefined, fields: CustomerFields): Promise<Customer | undefined> {
  const c = await run(nav, id ? api.patchCustomer(id, fields) : api.createCustomer(fields));
  if (!c) return undefined;
  put({ customer: c });
  await reloadInvoices();
  return c;
}
