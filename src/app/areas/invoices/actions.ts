/**
 * What the buttons of Rechnungen do: each call goes to the invoicing API, its refusal is shown
 * in the user's language (Art. 26 MWSTG gaps named one by one), and the records are read again.
 */
import { isItem, issuedPdfUrl, sentPdfUrl, type Contact, type DocumentKind, type Draft, type Invoice, type InvoiceLine, type Issued, type Stage, type WriteOff, type WriteOffReason } from '../../../invoices/model.js';
import type { AllocationPart } from '../../../invoices/payments.js';
import type { SendMail as MailMessage } from '../../lib/api.js';
import type { ReminderPatch } from '../../../invoices/service.js';
import { reminderTitle } from '../../../invoices/texts.js';
import { api, errorText, type AccountsInput, type ContactInput, type CreditInput, type DraftChange } from '../../lib/api.js';
import { lineDefaults } from '../../../invoices/contacts.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { localToday, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import type { Location } from '../../shell/route.js';
import { setUi } from './state.js';
import { edits, put, reloadInvoices } from './data.js';
import { inOrder } from '../../lib/in-order.js';
import { customerChange, routeId } from './model.js';
import { viewOfKind } from './table.js';
import { filing, invoiceRates, invoicing } from '../../../engines/index.js';
import { desktop } from '../../desktop/bridge.js';

/** A document's place: the table of its kind (/invoices/<number> opens any). */
export const invoicePath = (inv: Invoice) => ({ area: 'invoices' as const, view: viewOfKind(inv.kind), id: routeId(inv) });

/** An invoice's link in a period that holds its date (a draft shows in every period). */
export const invoiceAt = (inv: Invoice, current?: Period): Location =>
  ({ route: invoicePath(inv), query: inv.status === 'draft' && current ? { period: current } : { period: parsePeriod(periodContaining(inv.date, current, filing().length), localToday()) ?? undefined } });

/**
 * The line a new draft starts with, its text ready to be typed over; no unit until one is picked.
 * `contact`: its revenue account and standing discount fill the new position (the person may remove them).
 */
export const firstLine = (zero: boolean, contact?: Pick<Contact, 'revenueAccount' | 'discount'>): InvoiceLine =>
  ({ text: t('invoices.newLine'), quantity: 1, price: 0, vatRate: zero ? 0 : invoiceRates()[0], ...lineDefaults(contact) });

async function run<T>(nav: Nav, call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (e) {
    nav.toast(errorText(e));
    return undefined;
  }
}

export async function newDraft(nav: Nav, customer: Pick<Contact, 'id' | 'name'>, input: DraftChange = {}): Promise<Draft | undefined> {
  const draft = await run(nav, api.createDraft({ ...input, customerId: customer.id }));
  if (!draft) return undefined;
  put({ invoice: draft });
  setUi({ focus: 'l:0:text', preview: false });
  nav.select(invoicePath(draft));
  void reloadInvoices();
  return draft;
}

/** A new draft of `kind` for `c`: one line to type over, the contact's language, 0 % for a contact abroad. */
export const newDraftFor = (nav: Nav, c: Pick<Contact, 'id' | 'name' | 'language' | 'addresses' | 'currency'>, kind: DocumentKind = 'invoice') =>
  newDraft(nav, c, { ...(kind !== 'invoice' ? { kind } : {}), lines: [firstLine(false)], ...customerChange({ lines: [firstLine(false)], currency: 'CHF' }, c) });

const draftSaves = inOrder();

/**
 * A draft changed on the sheet: shown at once, saved behind it, one save after the other; only the last answer is shown.
 * A changed total of an Auftrag whose Teilrechnungen are issued asks first («Trotzdem ändern», spec 4.11).
 */
export async function saveDraft(nav: Nav, draft: Draft, patch: DraftChange): Promise<void> {
  const local = { ...draft } as Draft & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete local[k]; else local[k] = v; }
  put({ invoice: local });
  let warned = false;
  const call = () => api.patchDraft(draft.id, patch).catch((e: unknown) => {
    const code = (e as { body?: { invoiceRefusal?: string } }).body?.invoiceRefusal;
    if (code !== 'stagesInvoiced') throw e;
    warned = true;
    setUi({ dialog: { kind: 'warn', title: t('sales.plan.changeTitle'), text: errorText(e), anyway: t('sales.anyway.stagesInvoiced'), run: async () => {
      const saved = await run(nav, api.patchDraft(draft.id, patch, ['stagesInvoiced']));
      if (saved) { setUi({ dialog: null }); put({ invoice: saved }); }
    } } });
    return undefined;
  });
  const { result: saved, latest } = await edits.saving(draft.id, draftSaves(draft.id, () => run(nav, call())));
  if (!latest) return;
  if (saved) put({ invoice: saved });
  else if (warned) put({ invoice: draft });
  else void reloadInvoices();
}

/** The Teilrechnungsplan saved (spec 4.4.9); what is missing or too much is the API's to name. */
export async function savePlan(nav: Nav, inv: Invoice, stages: Stage[]): Promise<boolean> {
  const done = await run(nav, api.setStages(inv.id, stages));
  if (!done) return false;
  put({ invoice: done });
  await reloadInvoices();
  nav.toast(t(stages.length ? 'sales.plan.saved' : 'sales.plan.removed', { number: inv.number ?? '' }));
  return true;
}

/** The Rechnung of a stage of the plan, or «Schlussrechnung erstellen» (`final`): the new draft opens; a Teilrechnung still a draft asks first. */
export function stageInvoice(nav: Nav, inv: Issued, stage: number | 'final'): Promise<Draft | undefined> {
  return withWarnings(nav, t('sales.plan.finalCreate'), (confirm) => api.stageInvoice(inv.id, stage, confirm), async (draft) => {
    setUi({ dialog: null });
    put({ invoice: draft });
    await reloadInvoices();
    nav.select(invoicePath(draft));
    nav.toast(t(draft.role === 'final' ? 'sales.plan.finalMade' : 'sales.plan.partialMade', { number: inv.number }));
  });
}

/** «Akontos abziehen»: the picked Teilrechnungen deducted at the end of the Schlussrechnung draft. */
export async function addDeductions(nav: Nav, draft: Draft, ids: string[]): Promise<boolean> {
  const done = await run(nav, api.deductions(draft.id, ids));
  if (!done) return false;
  put({ invoice: done });
  nav.toast(t('sales.plan.deducted', { n: ids.length }));
  return true;
}

/** «Zahlungsaufforderung» of a retention, by e-mail or saved as a download; recorded in the sent log. */
export async function sendInstalment(nav: Nav, inv: Issued, email?: MailMessage): Promise<boolean> {
  const doc = await run(nav, api.sendInstalment(inv.id, email ? { email } : { to: 'download' }));
  if (!doc) return false;
  if (!email) download(sentPdfUrl(doc.id), `${doc.title}.pdf`);
  await reloadInvoices();
  nav.toast(email ? t('sales.instalment.mailed', { number: inv.number, to: doc.to }) : t('sales.instalment.saved', { number: inv.number }));
  return true;
}

/** Deletes the draft; its table stays in view with nothing open (layout A selects nothing by itself). */
export async function deleteDraft(nav: Nav, draft: Draft): Promise<void> {
  if (!(await run(nav, api.deleteDraft(draft.id)))) return;
  await reloadInvoices();
  nav.select({ area: 'invoices', view: invoicePath(draft).view });
  const { id: _id, createdAt: _c, origin: _o, deleted: _d, status: _s, comments: _cm, kind: _k, creditFor: _cf, ...content } = draft;
  // A credit note is drafted from its invoice only; any other draft comes back as it was.
  nav.toast(t('invoices.draftDeleted'), draft.kind === 'credit-note' ? undefined : () => { void newDraft(nav, { id: draft.customerId, name: '' }, content); });
}

/**
 * Issues the draft, shows it in a period that holds its date (F10): the period on screen, `current`,
 * when it does, and opens the send window with its PDF.
 */
export function issue(nav: Nav, draft: Draft, current: Period, anyway = false): Promise<Issued | undefined> {
  // A draft whose Auftrag or Angebot was cancelled since asks first («Trotzdem ausstellen»).
  return withWarnings(nav, t('invoices.issue'), (confirm) => api.issue(draft.id, anyway, confirm), async (issued) => {
    await reloadInvoices();
    nav.go(invoiceAt(issued, current));
    setUi({ dialog: { kind: 'send', issued: true }, preview: false });
  });
}

/**
 * The PDF saved where the person says: in the Mac app through the Save dialog, which tells whether
 * it was saved; in a browser by its download, which does not.
 */
async function saveFile(href: string, name: string): Promise<boolean> {
  if (desktop?.saveFile) return desktop.saveFile(href, name);
  download(href, name);
  return true;
}

/** A text made here (a CSV of a table) saved as a file by its download. */
export function saveText(text: string, name: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export function download(href: string, name: string): void {
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

/** The issued PDF saved here and nothing recorded: «Nur ansehen» (a view, not a sending). */
export async function savePdf(nav: Nav, inv: Issued): Promise<boolean> {
  return !!(await run(nav, saveFile(issuedPdfUrl(inv.number), `${inv.number}.pdf`)));
}

/**
 * The issued PDF goes out by e-mail through the company's mailbox, or is saved here to be sent
 * otherwise; either way it is recorded with its bytes. A failed e-mail records nothing.
 */
export async function send(nav: Nav, inv: Issued, email?: MailMessage): Promise<boolean> {
  // Cancelled in the Save dialog: nothing went out, nothing is recorded.
  if (!email && !(await run(nav, saveFile(issuedPdfUrl(inv.number), `${inv.number}.pdf`)))) return false;
  const doc = await run(nav, api.recordSend(inv.id, email ? { email } : { to: 'download' }));
  if (!doc) return false;
  await reloadInvoices();
  nav.toast(email ? t('invoices.mailed', { number: inv.number, to: doc.to }) : t(doc.kind === 'resend' ? 'invoices.resent' : 'invoices.sent', { number: inv.number }));
  return true;
}

/** «Zurück zum Entwurf»: the document is a draft again under its number, shown as such. */
export async function backToDraft(nav: Nav, inv: Issued): Promise<boolean> {
  const draft = await run(nav, api.backToDraft(inv.id));
  if (!draft) return false;
  put({ invoice: draft });
  await booked(nav);
  nav.select(invoicePath(draft));
  nav.toast(t('invoices.backDone', { number: inv.number }));
  return true;
}

/** «Konten ändern»: the positions' accounts, and the bookings with them. */
export async function changeAccounts(nav: Nav, inv: Issued, input: AccountsInput): Promise<boolean> {
  if (!(await run(nav, api.changeAccounts(inv.id, input)))) return false;
  await booked(nav);
  nav.toast(t('invoices.accountsDone'));
  return true;
}

/**
 * «Als Entwurf kopieren» (spec 4.4.1): a draft of the same kind with every position, no `from`; a
 * Gutschrift's copy is a Rechnung with the prices turned round, since a Gutschrift comes only from its Rechnung.
 */
export async function copyAsDraft(nav: Nav, inv: Issued): Promise<void> {
  const { customerId, currency, language, subject, lines, prices, intro, closing, exemption, ordered, printAs } = inv;
  // A copy stands alone: its positions name no position of a source.
  // A deduction belongs to the Schlussrechnung it was checked on: a copy takes the work, not the Akontos (nor the role).
  const lines2 = lines.filter((l) => !(isItem(l) && l.deducts)).map((l) => { if (!isItem(l)) return l; const { ofLine: _f, ...rest } = l; return inv.kind === 'credit-note' ? { ...rest, price: -l.price } : rest; });
  const kind = inv.kind === 'credit-note' ? undefined : inv.kind;
  const draft = await newDraft(nav, { id: customerId, name: inv.customer.name }, {
    ...(kind && kind !== 'invoice' ? { kind } : {}), currency, language, lines: lines2, ...(prices ? { prices } : {}), ...(subject ? { subject } : {}), ...(intro ? { intro } : {}), ...(closing ? { closing } : {}), ...(exemption ? { exemption } : {}),
    ...(ordered ? { ordered } : {}), ...(kind === 'sales-order' && printAs ? { printAs } : {}),
  });
  if (draft) nav.toast(t('invoices.copied', { number: inv.number }));
}

/** The warnings of spec 4.11 a phase-2 action may meet: each opens «Trotzdem …» instead of a toast. */
const WARNINGS = ['expired', 'declined', 'overOpen', 'sentVersion', 'orderDelivered', 'orderDrafts', 'sourceCancelled', 'stagesInvoiced', 'partialDrafts'] as const;
type Warning = (typeof WARNINGS)[number];

/**
 * Runs `call(confirmed)`; a warning of the API opens the warning dialog, whose «Trotzdem …» runs it
 * again with that warning confirmed too (several may come one after the other).
 */
async function withWarnings<T>(nav: Nav, title: string, call: (confirmed: Warning[]) => Promise<T>, done: (r: T) => void | Promise<void>, confirmed: Warning[] = []): Promise<T | undefined> {
  try {
    const r = await call(confirmed);
    await done(r);
    return r;
  } catch (e) {
    const body = (e as { body?: { invoiceRefusal?: string } }).body;
    const code = body?.invoiceRefusal as Warning | undefined;
    if (code && WARNINGS.includes(code) && !confirmed.includes(code)) {
      setUi({ dialog: { kind: 'warn', title, text: errorText(e), anyway: t(`sales.anyway.${code}`), run: () => withWarnings(nav, title, call, done, [...confirmed, code]) } });
      return undefined;
    }
    nav.toast(errorText(e));
    return undefined;
  }
}

/** «Auftrag erstellen», «Lieferschein erstellen», «Rechnung erstellen»: the new draft opens; nothing ticked is said by the API. */
/** `confirmed`: the warnings the dialog showed beside its button, which the person's click confirms. */
export function convert(nav: Nav, inv: Issued, to: DocumentKind, lines: Array<{ line: number; quantity: number }>, confirmed: readonly Warning[] = []): Promise<Draft | undefined> {
  return withWarnings(nav, t(`sales.convert.${to}` as 'sales.convert.invoice'), (confirm) => api.convert(inv.id, { to, lines, ...(confirm.length ? { confirm } : {}) }), async (draft) => {
    setUi({ dialog: null });
    put({ invoice: draft });
    await reloadInvoices();
    nav.select(invoicePath(draft));
    nav.toast(t('sales.converted', { number: inv.number }));
  }, [...confirmed]);
}

/** «Angenommen» or «Abgelehnt» on an Angebot, the person's click; null takes it back. */
export async function answer(nav: Nav, inv: Issued, a: 'accepted' | 'declined' | null): Promise<boolean> {
  const done = await run(nav, api.answer(inv.id, a));
  if (!done) return false;
  put({ invoice: done });
  await reloadInvoices();
  nav.toast(t(a ? `sales.answered.${a}` : 'sales.answered.none', { number: inv.number }));
  return true;
}

/** An Angebot or Auftrag back to draft; once sent, «Trotzdem bearbeiten» first. */
export function reopen(nav: Nav, inv: Issued): Promise<Draft | undefined> {
  return withWarnings(nav, t('sales.reopen'), (confirm) => api.reopen(inv.id, confirm.includes('sentVersion')), async (draft) => {
    setUi({ dialog: null });
    await reloadInvoices();
    nav.select(invoicePath(draft));
    nav.toast(t('sales.reopened', { number: inv.number }));
  });
}

/** Storno of an Auftrag or Lieferschein: no notice, nothing booked; an Auftrag with a Lieferschein asks «Trotzdem stornieren». */
export function cancelDocument(nav: Nav, inv: Issued, input: { date: string; reason: string }): Promise<unknown> {
  return withWarnings(nav, t('sales.cancelTitle', { number: inv.number }), (confirm) => api.cancelInvoice(inv.id, { ...input, notify: false, ...(confirm.length ? { confirm } : {}) }), async () => {
    setUi({ dialog: null });
    await reloadInvoices();
    nav.toast(t('sales.cancelledDoc', { number: inv.number }));
  });
}

export async function cancel(nav: Nav, inv: Issued, input: { date: string; reason: string; notify: boolean; confirm?: 'paid' }, email?: MailMessage): Promise<boolean> {
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

/** Sends the Mahnung written as a draft, by e-mail or as a download (its PDF saved); kept as sent. */
export async function sendReminder(nav: Nav, inv: Issued, email?: MailMessage): Promise<boolean> {
  const done = await run(nav, api.sendReminder(inv.id, email ? { email } : { to: 'download' }));
  if (!done) return false;
  if (!email) download(sentPdfUrl(done.sent.id), `${done.sent.title}.pdf`);
  await reloadInvoices();
  const title = reminderTitle(done.reminder, inv.language);
  nav.toast(email ? t('invoices.reminderMailed', { title, number: inv.number, to: done.sent.to }) : t('invoices.reminderSent', { title, number: inv.number }));
  return true;
}

/** «Mahnen»: the next Mahnung written as a draft, shown on the sheet to edit before it is sent. */
export async function remind(nav: Nav, inv: Issued): Promise<boolean> {
  const r = await run(nav, api.draftReminder(inv.id, { date: localToday() }));
  if (!r) return false;
  await reloadInvoices();
  setUi({ preview: false, sheet: 'reminder' });
  return true;
}

/** A change to the Mahnung's draft (its texts on the sheet, its fee, interest, dates in the margin). */
export async function editReminder(nav: Nav, inv: Issued, patch: ReminderPatch): Promise<boolean> {
  if (!(await run(nav, api.editReminder(inv.id, patch)))) return false;
  await reloadInvoices();
  return true;
}

/** Deletes the unsent Mahnung: its level goes back. */
export async function deleteReminder(nav: Nav, inv: Issued): Promise<boolean> {
  if (!(await run(nav, api.deleteReminder(inv.id)))) return false;
  await reloadInvoices();
  nav.toast(t('invoices.reminderDeleted', { number: inv.number }));
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

export async function saveContact(nav: Nav, id: string | undefined, fields: ContactInput): Promise<Contact | undefined> {
  const c = await run(nav, id ? api.patchContact(id, fields) : api.createContact(fields));
  if (!c) return undefined;
  put({ contact: c });
  await reloadInvoices();
  return c;
}

/** «Archivieren» or «Löschen»: a contact a document names is archived, one without documents deleted; the toast says which, its undo restores an archived one. */
export async function removeContact(nav: Nav, c: Contact): Promise<boolean> {
  const out = await run(nav, api.removeContact(c.id));
  if (!out) return false;
  await reloadInvoices();
  if (out.outcome === 'archived') nav.toast(t('contacts.archived', { name: c.name }), () => { void restoreContact(nav, c); });
  else nav.toast(t('contacts.deleted', { name: c.name }));
  return true;
}

export async function restoreContact(nav: Nav, c: Contact): Promise<boolean> {
  if (!(await run(nav, api.patchContact(c.id, { archived: false })))) return false;
  await reloadInvoices();
  nav.toast(t('contacts.restored', { name: c.name }));
  return true;
}

/** After a change that booked: the records and the books are read again. */
async function booked(nav: Nav): Promise<void> {
  await reloadInvoices();
  nav.refresh();
}

/** «Zahlungseingang erfassen»: a hand movement on a bank or the cash box; the toast's undo takes it back. */
export async function handPayment(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, input: { date: string; account: string; amount: number }): Promise<boolean> {
  const out = await run(nav, api.handPayment(inv.id, input));
  if (!out) return false;
  await booked(nav);
  nav.toast(t('invoices.handPaid', { number: inv.number }), () => { void removeHandPayment(nav, inv, out.transaction.ref); });
  return true;
}

export async function removeHandPayment(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, ref: string): Promise<boolean> {
  if (!(await run(nav, api.removeHandPayment(inv.id, ref)))) return false;
  await booked(nav);
  nav.toast(t('invoices.handRemoved', { number: inv.number }));
  return true;
}

/** «Rest ausbuchen»; `anyway`: «Trotzdem ausbuchen» over more than is open. Refused for more than open: the caller offers «Trotzdem». */
export async function writeOff(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, input: { reason: WriteOffReason; date?: string; amount?: number; note?: string }, anyway = false): Promise<WriteOff | 'aboveOpen' | undefined> {
  try {
    const out = await api.writeOff(inv.id, { ...input, ...(anyway ? { confirm: 'aboveOpen' as const } : {}) });
    await booked(nav);
    nav.toast(t('invoices.writtenOff', { number: inv.number, reason: t(`invoices.reason.${input.reason}`) }), () => { void removeWriteOff(nav, inv, out.writeOff.id); });
    return out.writeOff;
  } catch (e) {
    if ((e as { body?: { invoiceRefusal?: string } }).body?.invoiceRefusal === 'aboveOpen') return 'aboveOpen';
    nav.toast(errorText(e));
    return undefined;
  }
}

export async function removeWriteOff(nav: Nav, inv: Pick<Issued, 'id' | 'number'>, id: string): Promise<boolean> {
  if (!(await run(nav, api.removeWriteOff(inv.id, id)))) return false;
  await booked(nav);
  nav.toast(t('invoices.writeOffRemoved', { number: inv.number }));
  return true;
}

/** «Buchen» of the Ausziffern dialog. */
export async function allocate(nav: Nav, ref: string, parts: AllocationPart[]): Promise<boolean> {
  const out = await run(nav, api.allocate(ref, parts));
  if (!out) return false;
  await booked(nav);
  nav.toast(t('invoices.allocated', { n: out.paid.length }));
  return true;
}

/**
 * The Kontoauszug of a contact goes out by e-mail, or is saved here first and recorded as
 * downloaded (spec 4.4.5); the sent log keeps it as kind `statement`. A failed e-mail records nothing.
 */
export async function sendStatement(nav: Nav, contactId: string, period: { from: string; to: string }, email?: MailMessage): Promise<boolean> {
  if (!email && !(await run(nav, saveFile(api.statementPdfUrl(contactId, period.from, period.to), `${t('statement.file')}.pdf`)))) return false;
  const doc = await run(nav, api.sendStatement(contactId, { ...period, ...(email ? { email } : { recipient: 'download' }) }));
  if (!doc) return false;
  await reloadInvoices();
  nav.toast(email ? t('statement.mailed', { to: doc.to }) : t('statement.saved'));
  return true;
}
