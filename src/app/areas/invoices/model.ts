/**
 * Rechnungen as the list shows them: each invoice's state, the groups in the mockup's order, the
 * status filters, what is open, and the link of each record. Computed with src/invoices/rules.ts,
 * the rules the API and the PDF use.
 */
import type { Period } from '../../../accounting/periods.js';
import type { Customer, Draft, Invoice, InvoiceBook, SentDocument } from '../../../invoices/model.js';
import type { DraftChange } from '../../lib/api.js';
import { isOverdue, openAmount, totals } from '../../../invoices/rules.js';
import type { InvoiceList } from '../../lib/api.js';
import type { InvoiceStatus } from '../../shell/route.js';

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

export interface InvoiceRow { inv: Invoice; state: RowState; gross: number; customer: string }

/** The invoices of a period (by invoice date; drafts always), searched by number, subject, customer and amount. */
export function rowsOf(d: InvoiceList, period: Period, q: string | undefined, today: string): InvoiceRow[] {
  const needle = q?.trim().toLowerCase();
  return d.invoices
    .filter((inv) => inv.status === 'draft' || (inv.date >= period.from && inv.date <= period.to))
    .map((inv) => ({ inv, state: rowState(inv, d.invoices, today), gross: totals(inv.lines).gross, customer: customerOf(d, inv)?.name ?? '' }))
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

/** What customers still owe in CHF, and how much of it is overdue (EUR invoices are shown in their rows). */
export function openSums(rows: readonly InvoiceRow[], invoices: readonly Invoice[]): { open: number; overdue: number } {
  const sum = (states: RowState[]) => Math.round(rows.filter((r) => states.includes(r.state) && r.inv.currency === 'CHF').reduce((s, r) => s + openAmount(r.inv, invoices), 0) * 100) / 100;
  return { open: sum(['open', 'overdue']), overdue: sum(['overdue']) };
}

/** A customer's open invoices in CHF, for the customer list. */
export function customerOpen(d: InvoiceList, id: string): number {
  return Math.round(d.invoices.filter((i) => i.status === 'issued' && i.customerId === id && i.currency === 'CHF').reduce((s, i) => s + openAmount(i, d.invoices), 0) * 100) / 100;
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
  return { customerId: c.id, language: c.language, ...(allZero ? { lines: inv.lines.map((l) => ({ ...l, vatRate: 8.1 })), exemption: null, currency: 'CHF' } : {}) };
}
