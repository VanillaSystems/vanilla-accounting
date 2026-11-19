/**
 * Rechnungen and Gutschriften as their tables show them (docs/specs/invoicing.md 4.8 «Overview table»):
 * one row per document with its status, what the sent log says, what is open; the status tabs with
 * count and total; sorting; the totals of what is shown; the facts line. Every value comes from
 * src/invoices/rules.ts and lists.ts, so a tab is a fact, never a click.
 */
import type { Period } from '../../../accounting/periods.js';
import { fromRappen, toRappen } from '../../../accounting/rappen.js';
import type { Invoice, Issued } from '../../../invoices/model.js';
import { isOverdue, openAmount, totals } from '../../../invoices/rules.js';
import {
  CREDIT_TABS, DELIVERY_TABS, INVOICE_TABS, ORDER_TABS, QUOTE_TABS, creditNoteStatus, creditRest, daysBetween, deliveryStatus, invoiceStatus, orderStatus, quoteStatus, sentFacts, unsent,
  type CreditListStatus, type CreditTab, type DeliveryListStatus, type InvoiceListStatus, type InvoiceTab, type OrderListStatus, type QuoteListStatus, type SentFacts,
} from '../../../invoices/lists.js';
import { doneShare } from '../../../invoices/chain.js';
import { reminderDraftOf, sentReminders } from '../../../invoices/dunning.js';
import { reminderTitle } from '../../../invoices/texts.js';
import type { InvoiceList } from '../../lib/api.js';
import type { InvoiceView } from '../../shell/route.js';
import { baseCurrency } from '../../../engines/index.js';
import { customerOf, routeId } from './model.js';

export type DocKind = Invoice['kind'];
/** The views that are a table of documents, one per kind. */
export type DocView = Extract<InvoiceView, 'list' | 'credit-notes' | 'quotes' | 'orders' | 'deliveries'>;
const VIEW_OF: Record<DocKind, DocView> = { invoice: 'list', 'credit-note': 'credit-notes', quote: 'quotes', 'sales-order': 'orders', 'delivery-note': 'deliveries' };
export const kindOfView = (view: DocView): DocKind => (Object.keys(VIEW_OF) as DocKind[]).find((k) => VIEW_OF[k] === view)!;
export const viewOfKind = (kind: DocKind): DocView => VIEW_OF[kind];
export const DOC_VIEWS: readonly DocView[] = Object.values(VIEW_OF);
/** The word group of a kind's statuses and tabs in the dictionaries (sales.status.<group>.…, sales.tab.<group>.…). */
export const groupOf = (kind: DocKind): 'invoice' | 'credit' | 'quote' | 'order' | 'delivery' =>
  ({ invoice: 'invoice', 'credit-note': 'credit', quote: 'quote', 'sales-order': 'order', 'delivery-note': 'delivery' } as const)[kind];

export const PAGE_SIZE = 50;

export interface DocRow {
  inv: Invoice;
  /** Its id in a link (number or draft-<id>). */
  id: string;
  customer: string;
  status: InvoiceListStatus | CreditListStatus | QuoteListStatus | OrderListStatus | DeliveryListStatus;
  /** Days past the due date while something is open; 0 otherwise. */
  overdue: number;
  /** Issued, not cancelled, never sent itself. */
  unsent: boolean;
  sent: SentFacts;
  gross: number;
  /** A Rechnung: what the customer still owes. A Gutschrift: what is still to pay back or set off. */
  open: number;
  /** The Mahnstufe reached (the last Mahnung's level); 0 without one. */
  level: number;
  /** Its name as the last Mahnung printed it, and whether the next is written and not sent yet. */
  levelTitle?: string;
  reminderDraft?: string;
  /** A Gutschrift's Rechnung, a Lieferschein's Auftrag. */
  target?: Issued;
  /** An Auftrag: the share of its value delivered and invoiced, 0 to 1 (chain.ts doneShare). */
  delivered?: number;
  invoiced?: number;
}

/** The Mahnstufe a row shows: the last Mahnung sent, and one written but not sent. */
function levelOf(inv: Invoice): Pick<DocRow, 'level' | 'levelTitle' | 'reminderDraft'> {
  if (inv.status !== 'issued') return { level: 0 };
  const last = sentReminders(inv).at(-1);
  const draft = reminderDraftOf(inv);
  return { level: last?.level ?? 0, ...(last ? { levelTitle: reminderTitle(last, inv.language) } : {}), ...(draft ? { reminderDraft: reminderTitle(draft, inv.language) } : {}) };
}

/** A document's status in the list of its kind: the one function of lists.ts each kind has. */
export function statusOfKind(inv: Invoice, invoices: readonly Invoice[], today: string): DocRow['status'] {
  switch (inv.kind) {
    case 'invoice': return invoiceStatus(inv, invoices);
    case 'credit-note': return creditNoteStatus(inv, invoices);
    case 'quote': return quoteStatus(inv, invoices, today);
    case 'sales-order': return orderStatus(inv, invoices);
    case 'delivery-note': return deliveryStatus(inv);
  }
}

const matches = (r: DocRow, needle: string) =>
  [r.inv.status === 'issued' ? r.inv.number : '', r.inv.subject ?? '', r.customer, r.gross.toFixed(2), r.target?.number ?? ''].join(' ').toLowerCase().includes(needle);

/**
 * The documents of one kind for a period: those dated in it, every draft, and every one of an earlier
 * period with something still open (an overdue invoice from last quarter is still owed), searched by
 * number, subject, contact, amount and (a Gutschrift) its Rechnung's number.
 */
export function docRows(d: InvoiceList, kind: DocKind, period: Period, q: string | undefined, today: string): DocRow[] {
  const needle = q?.trim().toLowerCase();
  return d.invoices
    .filter((inv) => inv.kind === kind && !inv.deleted)
    .map((inv): DocRow => {
      const open = kind === 'invoice' ? openAmount(inv, d.invoices) : kind === 'credit-note' ? creditRest(inv, d.invoices) : 0;
      const targetId = inv.creditFor ?? (kind === 'delivery-note' ? inv.from?.id : undefined);
      const target = targetId ? d.invoices.find((i): i is Issued => i.id === targetId && i.status === 'issued') : undefined;
      const status = statusOfKind(inv, d.invoices, today);
      const due = inv.status === 'issued' && kind === 'invoice' && isOverdue(inv, d.invoices, today) ? daysBetween(inv.dueDate, today) : 0;
      return {
        inv, id: routeId(inv), customer: customerOf(d, inv)?.name ?? '', status, overdue: due, unsent: unsent(inv, d.sent),
        sent: sentFacts(d.sent, inv), gross: totals(inv).gross, open,
        ...levelOf(inv),
        ...(target ? { target } : {}),
        ...(kind === 'sales-order' && inv.status === 'issued' ? { delivered: doneShare(inv, d.invoices, 'delivered'), invoiced: doneShare(inv, d.invoices, 'invoiced') } : {}),
      };
    })
    // An earlier period's document still counts while something of it waits: money open, an Angebot open, an Auftrag not done.
    .filter((r) => r.inv.status === 'draft' || (r.inv.date >= period.from && r.inv.date <= period.to) || (r.inv.date < period.from && (r.open > 0 || ((kind === 'quote' || kind === 'sales-order') && (r.status === 'open' || r.status === 'partly')))))
    .filter((r) => !needle || matches(r, needle));
}

export type Tab = 'all' | InvoiceTab | CreditTab | (typeof QUOTE_TABS)[number] | (typeof ORDER_TABS)[number] | (typeof DELIVERY_TABS)[number];
const TABS: Record<DocKind, readonly Tab[]> = { invoice: INVOICE_TABS, 'credit-note': CREDIT_TABS, quote: QUOTE_TABS, 'sales-order': ORDER_TABS, 'delivery-note': DELIVERY_TABS };
export const tabsOf = (kind: DocKind): readonly Tab[] => ['all', ...TABS[kind]];

/** A row in a tab: Überfällig overlaps Offen and Teilbezahlt, as the mark beside the status does. */
export function inTab(r: DocRow, tab: Tab | undefined): boolean {
  if (!tab || tab === 'all') return true;
  if (tab === 'unsent') return r.unsent;
  if (tab === 'overdue') return r.overdue > 0;
  // Ausgebucht is closed: it stands with Bezahlt (decision 56).
  if (tab === 'paid') return r.status === 'paid' || r.status === 'written-off';
  return r.status === tab;
}

/** The tab a `?status=` names in this view; a value of the other kind's tabs shows «Alle». */
export const tabOf = (kind: DocKind, status: string | undefined): Tab => (status && (tabsOf(kind) as readonly string[]).includes(status) ? status as Tab : 'all');

export interface Sum { currency: string; gross: number; open: number }

const add = (a: number, b: number) => fromRappen(toRappen(a) + toRappen(b));

/** Brutto and Offen per currency, the books' currency first; a cancelled document counts only where all are (the tab Storniert). */
export function sumsOf(rows: readonly DocRow[]): Sum[] {
  const by = new Map<string, Sum>();
  const all = rows.every((r) => r.status === 'cancelled');
  for (const r of rows) {
    if (r.status === 'cancelled' && !all) continue;
    const s = by.get(r.inv.currency) ?? { currency: r.inv.currency, gross: 0, open: 0 };
    by.set(r.inv.currency, { ...s, gross: add(s.gross, r.gross), open: add(s.open, r.open) });
  }
  const base = baseCurrency();
  return [...by.values()].sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
}

export interface TabCount { tab: Tab; n: number; sums: Sum[] }

/** Each tab with how many documents are in it and their total; a tab with none is still counted. */
export const tabCounts = (rows: readonly DocRow[], kind: DocKind): TabCount[] =>
  tabsOf(kind).map((tab) => { const xs = rows.filter((r) => inTab(r, tab)); return { tab, n: xs.length, sums: sumsOf(xs) }; });

export interface Facts { currency: string; open: number; overdue: number }

/** The facts line: what is open and what of it is overdue, per currency (a Gutschrift: what is still to pay back). */
export function factsOf(rows: readonly DocRow[]): Facts[] {
  const by = new Map<string, Facts>();
  for (const r of rows) {
    if (r.open <= 0) continue;
    const f = by.get(r.inv.currency) ?? { currency: r.inv.currency, open: 0, overdue: 0 };
    by.set(r.inv.currency, { ...f, open: add(f.open, r.open), overdue: r.overdue > 0 ? add(f.overdue, r.open) : f.overdue });
  }
  const base = baseCurrency();
  return [...by.values()].sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
}

export const SORT_KEYS = ['date', 'number', 'contact', 'invoice', 'status', 'sent', 'due', 'currency', 'gross', 'open', 'level', 'validUntil', 'delivered', 'invoiced', 'order'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort { key: SortKey; dir: 1 | -1 }
export const DEFAULT_SORT: Sort = { key: 'date', dir: -1 };

const STATUS_ORDER = ['draft', 'open', 'expired', 'partly-paid', 'partly', 'accepted', 'declined', 'paid', 'written-off', 'settled', 'done', 'cancelled'];
const text = (a: string, b: string) => a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

function compare(a: DocRow, b: DocRow, key: SortKey): number {
  switch (key) {
    case 'date': return a.inv.date.localeCompare(b.inv.date);
    case 'number': return text(a.inv.status === 'issued' ? a.inv.number : '', b.inv.status === 'issued' ? b.inv.number : '');
    case 'contact': return text(a.customer, b.customer);
    case 'invoice': return text(a.target?.number ?? '', b.target?.number ?? '');
    case 'status': return (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)) || (a.overdue - b.overdue);
    case 'sent': return (a.sent.last?.sentAt ?? '').localeCompare(b.sent.last?.sentAt ?? '');
    case 'due': return (a.inv.dueDate ?? '').localeCompare(b.inv.dueDate ?? '');
    case 'currency': return a.inv.currency.localeCompare(b.inv.currency);
    case 'gross': return a.gross - b.gross;
    case 'open': return a.open - b.open;
    case 'level': return a.level - b.level;
    case 'validUntil': return (a.inv.validUntil ?? '').localeCompare(b.inv.validUntil ?? '');
    case 'delivered': return (a.delivered ?? 0) - (b.delivered ?? 0);
    case 'invoiced': return (a.invoiced ?? 0) - (b.invoiced ?? 0);
    case 'order': return text(a.target?.number ?? '', b.target?.number ?? '');
  }
}

/** Sorted by `sort`, then newest first, then by number: the same order every time. */
export function sortRows(rows: readonly DocRow[], sort: Sort): DocRow[] {
  return [...rows].sort((a, b) => compare(a, b, sort.key) * sort.dir || b.inv.date.localeCompare(a.inv.date) || b.inv.createdAt.localeCompare(a.inv.createdAt));
}
