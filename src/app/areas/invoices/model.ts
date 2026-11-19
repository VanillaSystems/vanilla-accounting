/**
 * Rechnungen as the list shows them: each invoice's state, the groups in the mockup's order, the
 * status filters, what is open, and the link of each record. Computed with src/invoices/rules.ts,
 * the rules the API and the PDF use.
 */
import { heldByReconciliation } from '../../../books/reconcile.js';
import { bookedInFiled } from '../../../books/twins.js';
import { isItem, type Contact, type CustomerFields, type Draft, type Invoice, type InvoiceBook, type Issued, type SentDocument } from '../../../invoices/model.js';
import { billingAddress, documentsOf, recipientOf } from '../../../invoices/contacts.js';
import type { DraftChange } from '../../lib/api.js';
import { isOverdue, namesNumber, openAmount } from '../../../invoices/rules.js';
import { channelOf } from '../../../invoices/lists.js';
import type { BankTransaction, Index } from '../../../types/index.js';
import type { InvoiceList } from '../../lib/api.js';
import { baseCurrency, chargesVat, invoiceRates, invoicing } from '../../../engines/index.js';

/** What the detail's status line and actions go by: an issued invoice is open or overdue until paid; a credit note and a cancelled invoice are their own. */
export type RowState = 'overdue' | 'open' | 'draft' | 'paid' | 'credit' | 'cancelled';

export function rowState(inv: Invoice, invoices: readonly Invoice[], today: string): RowState {
  if (inv.status === 'draft') return 'draft';
  if (inv.cancelled) return 'cancelled';
  if (inv.kind === 'credit-note') return 'credit';
  if (openAmount(inv, invoices) === 0) return 'paid';
  return isOverdue(inv, invoices, today) ? 'overdue' : 'open';
}

/** The invoice or credit note itself went to the customer (by e-mail or as a saved PDF), not only a reminder or notice. */
export { wasSent } from '../../../invoices/lists.js';

/**
 * The last document issued in the draft's year with a later date: the draft would take the next
 * number with an earlier date, and the numbers would no longer follow the dates.
 */
export function issuedLater(invoices: readonly Invoice[], draft: Pick<Draft, 'date'> & { kind?: Draft['kind']; number?: string }): Issued | undefined {
  // A draft back from issue keeps its number («Zurück zum Entwurf»): it gets no higher one.
  if (draft.number) return undefined;
  const kind = draft.kind ?? 'invoice';
  // The same series: the same kind, or the other of a Rechnung and Gutschrift sharing today's series.
  const series = (k: Draft['kind']) => k === kind || ((k === 'invoice' || k === 'credit-note') && (kind === 'invoice' || kind === 'credit-note'));
  return invoices
    .filter((i): i is Issued => i.status === 'issued' && !i.deleted && series(i.kind) && i.date.slice(0, 4) === draft.date.slice(0, 4) && i.date > draft.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** The id an invoice has in a link: its number once issued, `draft-<id>` before (docs/urls.md). */
export const routeId = (inv: Invoice): string => (inv.status === 'issued' ? inv.number : `draft-${inv.id}`);

export function byRouteId(invoices: readonly Invoice[], id: string | undefined): Invoice | undefined {
  if (!id) return undefined;
  // A number's link still finds its document after it went back to draft (Draft.number).
  return id.startsWith('draft-') ? invoices.find((i) => i.status === 'draft' && i.id === id.slice(6)) : invoices.find((i) => i.number === id && !i.deleted);
}

export const bookOf = (d: InvoiceList): InvoiceBook => ({ schema: 1, contacts: d.contacts, articles: d.articles, invoices: d.invoices, sent: d.sent });

/** The contact a document names (archived ones too). */
export const contactOf = (d: InvoiceList, inv: Pick<Invoice, 'customerId'>): Contact | undefined => d.contacts.find((c) => c.id === inv.customerId);

/**
 * Who a document goes to as it prints: an issued one as it froze it, a draft as its contact, person
 * and address read now. `terms`: the firm's settings for the contact's days.
 */
export function customerOf(d: InvoiceList, inv: Invoice, terms?: Parameters<typeof recipientOf>[2]): CustomerFields | undefined {
  return inv.status === 'issued' ? inv.customer : recipientOf(contactOf(d, inv), inv, terms);
}

/** A contact's open invoices in the books' currency, for the contact list. */
export function customerOpen(d: InvoiceList, id: string): number {
  return Math.round(d.invoices.filter((i) => i.status === 'issued' && i.customerId === id && i.currency === baseCurrency()).reduce((s, i) => s + openAmount(i, d.invoices), 0) * 100) / 100;
}

/** The sent documents, newest first, searched by title, contact and recipient, and filtered by contact, kind and channel. */
export function sentRows(d: InvoiceList, q: string | undefined, filter: { customer?: string; kind?: string; channel?: string } = {}): SentDocument[] {
  const needle = q?.trim().toLowerCase();
  const invOf = (doc: SentDocument) => d.invoices.find((i) => i.id === doc.invoiceId);
  const name = (doc: SentDocument) => { const inv = invOf(doc); return inv ? customerOf(d, inv)?.name ?? '' : ''; };
  return [...d.sent]
    .filter((doc) => !doc.deleted)
    .filter((doc) => (!filter.customer || invOf(doc)?.customerId === filter.customer) && (!filter.kind || doc.kind === filter.kind) && (!filter.channel || channelOf(doc) === filter.channel))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .filter((doc) => !needle || [doc.title, name(doc), doc.to].join(' ').toLowerCase().includes(needle));
}

/** A row of Kontakte: the contact, its town, what it owes, how many documents name it. */
export interface ContactRow { contact: Contact; town: string; open: number; documents: number }

/** The tabs of Kontakte: the active contacts, firms, persons, the archived ones. */
export const CONTACT_TABS = ['all', 'firm', 'person', 'archived'] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];

/** The contacts of a tab by name, searched by name, number, town, e-mail, UID and tag. */
export function contactRows(d: InvoiceList, q: string | undefined, tab: ContactTab = 'all'): ContactRow[] {
  const needle = q?.trim().toLowerCase();
  return [...d.contacts]
    .filter((c) => (tab === 'archived' ? !!c.archived : !c.archived && (tab === 'all' || c.type === tab)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ contact: c, town: townOf(c), open: customerOpen(d, c.id), documents: documentsOf(d, c.id).length }))
    .filter((r) => !needle || [r.contact.name, r.contact.number, r.town, ...r.contact.emails, r.contact.vatId, ...(r.contact.tags ?? []), ...r.contact.persons.map((p) => p.name)]
      .filter(Boolean).join(' ').toLowerCase().includes(needle));
}

/** The town of a contact's billing address, with its country when abroad. */
export function townOf(c: Pick<Contact, 'addresses'>): string {
  const a = billingAddress(c);
  return a ? `${a.town}${a.country !== 'CH' ? `, ${a.country}` : ''}` : '';
}

/**
 * Another customer: the draft takes their language; a customer abroad gets 0 % with the reason
 * "service abroad" (and EUR for the neighbours), a Swiss one back the normal rate.
 */
export function customerChange(inv: Pick<Draft, 'lines' | 'currency'>, c: Pick<Contact, 'id' | 'language' | 'addresses' | 'currency'>): DraftChange {
  const country = billingAddress(c)?.country ?? 'CH';
  // Another contact: its person and address are its own, none picked yet.
  const base = { customerId: c.id, language: c.language, personId: null, addressId: null } as const;
  const abroad = country !== 'CH' && country !== 'LI';
  if (abroad) return { ...base, lines: inv.lines.map((l) => (isItem(l) ? { ...l, vatRate: 0 } : l)), exemption: 'abroad', ...(c.currency ? { currency: c.currency } : ['DE', 'FR', 'IT', 'AT'].includes(country) ? { currency: 'EUR' } : {}) };
  const items = inv.lines.filter(isItem);
  const allZero = items.length > 0 && items.every((l) => l.vatRate === 0);
  return { ...base, ...(c.currency ? { currency: c.currency } : {}), ...(allZero && chargesVat() ? { lines: inv.lines.map((l) => (isItem(l) ? { ...l, vatRate: invoiceRates()[0] } : l)), exemption: null, currency: c.currency ?? 'CHF' } : {}) };
}

/** A payment is linked to a document once an allocation names its ref. */
const allocatedRefs = (invoices: readonly Invoice[]): Set<string> =>
  new Set(invoices.flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));

/**
 * The open invoices an incoming payment can be linked to from the payment's page (r9c-3): issued,
 * not cancelled, in the payment's currency, still owed; none once the payment is allocated. Those
 * whose number the payment's text names come first.
 */
export function linkableInvoices(invoices: readonly Invoice[], tx: Pick<BankTransaction, 'ref' | 'direction' | 'currency' | 'description' | 'reference' | 'counterparty' | 'parts'>): Issued[] {
  if (tx.direction !== 'CRDT' || allocatedRefs(invoices).has(tx.ref)) return [];
  const text = [tx.description, tx.reference, tx.counterparty, ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference])].filter(Boolean).join(' ');
  return invoices
    .filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice' && !i.cancelled && i.currency === tx.currency && openAmount(i, invoices) > 0)
    .sort((a, b) => Number(namesNumber(text, b.number)) - Number(namesNumber(text, a.number)) || a.number.localeCompare(b.number));
}

/**
 * The incoming payments of the open period an invoice can be linked to from its page (r9c-3): in
 * its currency, not allocated to any document yet, the newest first. The proposals the API makes
 * are a subset; this lets a person pick any other, a prepayment before the invoice's date included.
 */
export function linkablePayments(books: Pick<Index, 'transactions' | 'config' | 'reconciliations'>, invoices: readonly Invoice[], inv: Issued): BankTransaction[] {
  const closed = books.config?.closedThrough ?? '';
  const allocated = allocatedRefs(invoices);
  // Held by a waiting reconciliation or booked in a filed period: no document may take it (refuseHeld, src/invoices/payments.ts).
  const held = heldByReconciliation(books);
  return books.transactions
    .filter((t) => t.direction === 'CRDT' && t.currency === inv.currency && t.date > closed && !allocated.has(t.ref) && t.amount > 0 && !held.has(t.ref) && !bookedInFiled(t))
    .sort((a, b) => b.date.localeCompare(a.date));
}
