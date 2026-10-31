/**
 * Rechnungen as the list shows them: each invoice's state, the groups in the mockup's order, the
 * status filters, what is open, and the link of each record. Computed with src/invoices/rules.ts,
 * the rules the API and the PDF use.
 */
import type { Period } from '../../../accounting/periods.js';
import type { Customer, Draft, Invoice, InvoiceBook, Issued, SentDocument } from '../../../invoices/model.js';
import type { DraftChange } from '../../lib/api.js';
import { isOverdue, namesNumber, openAmount, totals } from '../../../invoices/rules.js';
import type { BankTransaction, Index } from '../../../types/index.js';
import type { InvoiceList } from '../../lib/api.js';
import type { InvoiceStatus } from '../../shell/route.js';
import { baseCurrency, chargesVat, invoiceRates, invoicing } from '../../../engines/index.js';

/** What a row and its group say: an issued invoice is open or overdue until paid; a credit note and a cancelled invoice are their own groups. */
export type RowState = 'overdue' | 'open' | 'draft' | 'paid' | 'credit' | 'cancelled';
export const GROUPS: RowState[] = ['overdue', 'open', 'draft', 'paid', 'credit', 'cancelled'];

export function rowState(inv: Invoice, invoices: readonly Invoice[], today: string): RowState {
  if (inv.status === 'draft') return 'draft';
  if (inv.cancelled) return 'cancelled';
  if (inv.kind === 'credit-note') return 'credit';
  if (openAmount(inv, invoices) === 0) return 'paid';
  return isOverdue(inv, invoices, today) ? 'overdue' : 'open';
}

/** The invoice or credit note itself went to the customer (by e-mail or as a saved PDF), not only a reminder or notice. */
export const wasSent = (sent: readonly SentDocument[], inv: Invoice): boolean => sent.some((x) => x.invoiceId === inv.id && (x.kind === 'invoice' || x.kind === 'credit-note' || x.kind === 'resend'));

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

/** `open`: what the customer still owes on it (0 for a draft, a credit note, a paid or cancelled one). */
export interface InvoiceRow { inv: Invoice; state: RowState; gross: number; open: number; customer: string }

/**
 * The invoices of a period (by invoice date), every draft, and every invoice of an earlier period
 * still open (an overdue invoice from last quarter is still owed), searched by number, subject,
 * customer and amount.
 */
export function rowsOf(d: InvoiceList, period: Period, q: string | undefined, today: string): InvoiceRow[] {
  const needle = q?.trim().toLowerCase();
  return d.invoices
    .filter((inv) => inv.status === 'draft' || (inv.date >= period.from && inv.date <= period.to) || (inv.date < period.from && openAmount(inv, d.invoices) > 0))
    .map((inv) => ({ inv, state: rowState(inv, d.invoices, today), gross: totals(inv.lines).gross, open: openAmount(inv, d.invoices), customer: customerOf(d, inv)?.name ?? '' }))
    .filter((r) => !needle || [r.inv.status === 'issued' ? r.inv.number : '', r.inv.subject ?? '', r.customer, r.gross.toFixed(2)].join(' ').toLowerCase().includes(needle));
}

/** `?status=open` takes the overdue ones too, as the mockup counts them. */
export const passes = (state: RowState, status: InvoiceStatus | undefined) => !status || state === status || (status === 'open' && state === 'overdue');

export function counts(rows: readonly InvoiceRow[]): Record<InvoiceStatus | 'all', number> {
  const n = (s: RowState) => rows.filter((r) => r.state === s).length;
  return { all: rows.length, open: n('open') + n('overdue'), overdue: n('overdue'), draft: n('draft'), paid: n('paid') };
}

export function groupsOf(rows: readonly InvoiceRow[], status: InvoiceStatus | undefined): Array<{ state: RowState; rows: InvoiceRow[] }> {
  return GROUPS.map((state) => ({
    state,
    rows: rows.filter((r) => r.state === state && passes(r.state, status)).sort((a, b) => b.inv.date.localeCompare(a.inv.date) || b.inv.createdAt.localeCompare(a.inv.createdAt)),
  })).filter((g) => g.rows.length);
}

export interface OpenSums { open: number; overdue: number; foreign: Array<{ currency: string; open: number; overdue: number }> }

/** What customers still owe in CHF and how much of it is overdue; an invoice in another currency counts in its own, beside it (r8c-9). */
export function openSums(rows: readonly InvoiceRow[], invoices: readonly Invoice[]): OpenSums {
  const sum = (currency: string, states: RowState[]) => Math.round(rows.filter((r) => states.includes(r.state) && r.inv.currency === currency).reduce((s, r) => s + openAmount(r.inv, invoices), 0) * 100) / 100;
  const of = (currency: string) => ({ open: sum(currency, ['open', 'overdue']), overdue: sum(currency, ['overdue']) });
  const currencies = [...new Set(rows.filter((r) => (r.state === 'open' || r.state === 'overdue') && r.inv.currency !== baseCurrency()).map((r) => r.inv.currency))].sort();
  return { ...of(baseCurrency()), foreign: currencies.map((currency) => ({ currency, ...of(currency) })) };
}

/** A customer's open invoices in CHF, for the customer list. */
export function customerOpen(d: InvoiceList, id: string): number {
  return Math.round(d.invoices.filter((i) => i.status === 'issued' && i.customerId === id && i.currency === baseCurrency()).reduce((s, i) => s + openAmount(i, d.invoices), 0) * 100) / 100;
}

/** The sent documents, newest first, searched by title, customer and recipient. */
export function sentRows(d: InvoiceList, q: string | undefined): SentDocument[] {
  const needle = q?.trim().toLowerCase();
  const name = (doc: SentDocument) => { const inv = d.invoices.find((i) => i.id === doc.invoiceId); return inv ? customerOf(d, inv)?.name ?? '' : ''; };
  return [...d.sent].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).filter((doc) => !needle || [doc.title, name(doc), doc.to].join(' ').toLowerCase().includes(needle));
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
  if (abroad) return { customerId: c.id, language: c.language, lines: inv.lines.map((l) => ({ ...l, vatRate: 0 })), exemption: 'abroad', ...(['DE', 'FR', 'IT', 'AT'].includes(c.address.country) ? { currency: 'EUR' } : {}) };
  const allZero = inv.lines.length > 0 && inv.lines.every((l) => l.vatRate === 0);
  return { customerId: c.id, language: c.language, ...(allZero && chargesVat() ? { lines: inv.lines.map((l) => ({ ...l, vatRate: invoiceRates()[0] })), exemption: null, currency: 'CHF' } : {}) };
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
