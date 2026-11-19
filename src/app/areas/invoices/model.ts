/**
 * Rechnungen as the list shows them: each invoice's state, the groups in the mockup's order, the
 * status filters, what is open, and the link of each record. Computed with src/invoices/rules.ts,
 * the rules the API and the PDF use.
 */
import { isItem, type Customer, type Draft, type Invoice, type InvoiceBook, type Issued, type SentDocument } from '../../../invoices/model.js';
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
export function issuedLater(invoices: readonly Invoice[], draft: Pick<Draft, 'date'>): Issued | undefined {
  return invoices
    .filter((i): i is Issued => i.status === 'issued' && !i.deleted && i.number.startsWith(`${draft.date.slice(0, 4)}-`) && i.date > draft.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** The id an invoice has in a link: its number once issued, `draft-<id>` before (docs/urls.md). */
export const routeId = (inv: Invoice): string => (inv.status === 'issued' ? inv.number : `draft-${inv.id}`);

export function byRouteId(invoices: readonly Invoice[], id: string | undefined): Invoice | undefined {
  if (!id) return undefined;
  return id.startsWith('draft-') ? invoices.find((i) => i.status === 'draft' && i.id === id.slice(6)) : invoices.find((i) => i.status === 'issued' && i.number === id);
}

export const bookOf = (d: InvoiceList): InvoiceBook => ({ schema: 1, customers: d.customers, invoices: d.invoices, sent: d.sent });

export function customerOf(d: InvoiceList, inv: Invoice): Pick<Customer, 'name' | 'address' | 'email' | 'language' | 'paymentTermsDays' | 'vatId' | 'attn'> | undefined {
  return inv.status === 'issued' ? inv.customer : d.customers.find((c) => c.id === inv.customerId);
}

/** A customer's open invoices in CHF, for the customer list. */
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

/** The customers by name, searched by name and town. */
export function customerRows(d: InvoiceList, q: string | undefined): Customer[] {
  const needle = q?.trim().toLowerCase();
  return [...d.customers].sort((a, b) => a.name.localeCompare(b.name)).filter((c) => !needle || `${c.name} ${c.address.town}`.toLowerCase().includes(needle));
}

/**
 * Another customer: the draft takes their language; a customer abroad gets 0 % with the reason
 * "service abroad" (and EUR for the neighbours), a Swiss one back the normal rate.
 */
export function customerChange(inv: Pick<Draft, 'lines' | 'currency'>, c: { id: string; language: Draft['language']; address: { country: string } }): DraftChange {
  const abroad = c.address.country !== 'CH' && c.address.country !== 'LI';
  if (abroad) return { customerId: c.id, language: c.language, lines: inv.lines.map((l) => (isItem(l) ? { ...l, vatRate: 0 } : l)), exemption: 'abroad', ...(['DE', 'FR', 'IT', 'AT'].includes(c.address.country) ? { currency: 'EUR' } : {}) };
  const items = inv.lines.filter(isItem);
  const allZero = items.length > 0 && items.every((l) => l.vatRate === 0);
  return { customerId: c.id, language: c.language, ...(allZero && chargesVat() ? { lines: inv.lines.map((l) => (isItem(l) ? { ...l, vatRate: invoiceRates()[0] } : l)), exemption: null, currency: 'CHF' } : {}) };
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
export function linkablePayments(books: Pick<Index, 'transactions' | 'config'>, invoices: readonly Invoice[], inv: Issued): BankTransaction[] {
  const closed = books.config?.closedThrough ?? '';
  const allocated = allocatedRefs(invoices);
  return books.transactions
    .filter((t) => t.direction === 'CRDT' && t.currency === inv.currency && t.date > closed && !allocated.has(t.ref) && t.amount > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
}
