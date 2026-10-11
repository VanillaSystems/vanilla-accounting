/**
 * What the buttons of Rechnungen do: each call goes to the invoicing API, its refusal is shown
 * in the user's language (Art. 26 MWSTG gaps named one by one), and the records are read again.
 */
import type { Customer, CustomerFields, Draft, Invoice, Issued } from '../../../invoices/model.js';
import { api, errorText, type CreditInput, type DraftChange } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { localToday, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import type { Location } from '../../shell/route.js';
import { setUi } from './state.js';
import { put, reloadInvoices } from './data.js';
import { customerChange, routeId } from './model.js';

export const invoicePath = (inv: Invoice) => ({ area: 'invoices' as const, view: 'list' as const, id: routeId(inv) });

/** An invoice's link in a period that holds its date (a draft shows in every period). */
export const invoiceAt = (inv: Invoice, current?: Period): Location =>
  ({ route: invoicePath(inv), query: inv.status === 'draft' && current ? { period: current } : { period: parsePeriod(periodContaining(inv.date, current), localToday()) ?? undefined } });

/** The line a new draft starts with, its text ready to be typed over. */
export const firstLine = (zero: boolean) => ({ text: t('invoices.newLine'), quantity: 1, unit: 'h' as const, price: 0, vatRate: zero ? 0 : 8.1 } as const);

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

/** A draft changed on the sheet: shown at once, saved behind it. */
export async function saveDraft(nav: Nav, draft: Draft, patch: DraftChange): Promise<void> {
  const local = { ...draft } as Draft & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete local[k]; else local[k] = v; }
  put({ invoice: local });
  const saved = await run(nav, api.patchDraft(draft.id, patch));
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

export async function issue(nav: Nav, draft: Draft): Promise<Issued | undefined> {
  const issued = await run(nav, api.issue(draft.id));
  if (!issued) return undefined;
  await reloadInvoices();
  nav.select(invoicePath(issued));
  nav.toast(t(issued.kind === 'credit-note' ? 'invoices.creditIssued' : 'invoices.issued', { number: issued.number }));
  return issued;
}

/** No e-mail yet: the PDF is saved here, and that it went out is recorded with its bytes. */
export async function send(nav: Nav, inv: Issued): Promise<void> {
  const a = Object.assign(document.createElement('a'), { href: api.documentUrl(inv.pdf.file), download: `${inv.number}.pdf` });
  document.body.append(a);
  a.click();
  a.remove();
  const doc = await run(nav, api.recordSend(inv.id, 'download'));
  if (!doc) return;
  await reloadInvoices();
  nav.toast(t(doc.kind === 'resend' ? 'invoices.resent' : 'invoices.sent', { number: inv.number }));
}

export async function copyAsDraft(nav: Nav, inv: Issued): Promise<void> {
  const { customerId, currency, language, subject, lines, intro, closing, exemption } = inv;
  const lines2 = inv.kind === 'credit-note' ? lines.map((l) => ({ ...l, quantity: -l.quantity })) : lines;
  const draft = await newDraft(nav, { id: customerId, name: inv.customer.name }, { currency, language, lines: lines2, ...(subject ? { subject } : {}), ...(intro ? { intro } : {}), ...(closing ? { closing } : {}), ...(exemption ? { exemption } : {}) });
  if (draft) nav.toast(t('invoices.copied', { number: inv.number }));
}

export async function cancel(nav: Nav, inv: Issued, input: { date: string; reason: string; notify: boolean }): Promise<boolean> {
  const done = await run(nav, api.cancelInvoice(inv.id, { ...input, ...(input.notify ? { to: 'download' } : {}) }));
  if (!done) return false;
  if (done.sent) {
    const a = Object.assign(document.createElement('a'), { href: api.documentUrl(done.sent.file), download: `${done.sent.title}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
  }
  await reloadInvoices();
  nav.toast(t(done.sent ? 'invoices.cancelledNotice' : 'invoices.cancelled', { number: inv.number }));
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

export async function sendReminder(nav: Nav, inv: Issued, input: { fee?: number; intro?: string; closing?: string }): Promise<boolean> {
  const done = await run(nav, api.sendReminder(inv.id, { ...input, to: 'download' }));
  if (!done) return false;
  const a = Object.assign(document.createElement('a'), { href: api.documentUrl(done.sent.file), download: `${done.sent.title}.pdf` });
  document.body.append(a);
  a.click();
  a.remove();
  await reloadInvoices();
  nav.toast(t('invoices.reminderSent', { level: done.reminder.level, number: inv.number }));
  return true;
}

export async function comment(nav: Nav, inv: Invoice, text: string): Promise<boolean> {
  if (!(await run(nav, api.addComment(inv.id, text)))) return false;
  await reloadInvoices();
  return true;
}

export async function confirmPayment(nav: Nav, inv: Issued, ref: string): Promise<void> {
  if (!(await run(nav, api.confirmPayment(inv.id, ref)))) return;
  await reloadInvoices();
  nav.refresh();
  nav.toast(t('invoices.paymentConfirmed', { number: inv.number }));
}

export async function saveCustomer(nav: Nav, id: string | undefined, fields: CustomerFields): Promise<Customer | undefined> {
  const c = await run(nav, id ? api.patchCustomer(id, fields) : api.createCustomer(fields));
  if (!c) return undefined;
  put({ customer: c });
  await reloadInvoices();
  return c;
}
