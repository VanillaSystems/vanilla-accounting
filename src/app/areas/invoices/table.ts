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
  CREDIT_TABS, INVOICE_TABS, creditNoteStatus, creditRest, daysBetween, invoiceStatus, sentFacts, unsent,
  type CreditListStatus, type CreditTab, type InvoiceListStatus, type InvoiceTab, type SentFacts,
} from '../../../invoices/lists.js';
import type { InvoiceList } from '../../lib/api.js';
import type { InvoiceView } from '../../shell/route.js';
import { baseCurrency } from '../../../engines/index.js';
import { customerOf, routeId } from './model.js';

export type DocKind = Invoice['kind'];
/** The views that are a table of documents. */
export type DocView = Extract<InvoiceView, 'list' | 'credit-notes'>;
export const kindOfView = (view: DocView): DocKind => (view === 'credit-notes' ? 'credit-note' : 'invoice');
export const viewOfKind = (kind: DocKind): DocView => (kind === 'credit-note' ? 'credit-notes' : 'list');

export const PAGE_SIZE = 50;

export interface DocRow {
  inv: Invoice;
  /** Its id in a link (number or draft-<id>). */
  id: string;
  customer: string;
  status: InvoiceListStatus | CreditListStatus;
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
  /** A Gutschrift's Rechnung. */
  target?: Issued;
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
      const open = kind === 'invoice' ? openAmount(inv, d.invoices) : creditRest(inv, d.invoices);
      const target = inv.creditFor ? d.invoices.find((i): i is Issued => i.id === inv.creditFor && i.status === 'issued') : undefined;
      const status = kind === 'invoice' ? invoiceStatus(inv, d.invoices) : creditNoteStatus(inv, d.invoices);
      const due = inv.status === 'issued' && kind === 'invoice' && isOverdue(inv, d.invoices, today) ? daysBetween(inv.dueDate, today) : 0;
      return {
        inv, id: routeId(inv), customer: customerOf(d, inv)?.name ?? '', status, overdue: due, unsent: unsent(inv, d.sent),
        sent: sentFacts(d.sent, inv), gross: totals(inv.lines).gross, open,
        level: inv.status === 'issued' ? inv.reminders.reduce((m, r) => Math.max(m, r.level), 0) : 0,
        ...(target ? { target } : {}),
      };
    })
    .filter((r) => r.inv.status === 'draft' || (r.inv.date >= period.from && r.inv.date <= period.to) || (r.inv.date < period.from && r.open > 0))
    .filter((r) => !needle || matches(r, needle));
}

export type Tab = 'all' | InvoiceTab | CreditTab;
export const tabsOf = (kind: DocKind): readonly Tab[] => ['all', ...(kind === 'invoice' ? INVOICE_TABS : CREDIT_TABS)];

/** A row in a tab: Überfällig overlaps Offen and Teilbezahlt, as the mark beside the status does. */
export function inTab(r: DocRow, tab: Tab | undefined): boolean {
  if (!tab || tab === 'all') return true;
  if (tab === 'unsent') return r.unsent;
  if (tab === 'overdue') return r.overdue > 0;
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

export const SORT_KEYS = ['date', 'number', 'contact', 'invoice', 'status', 'sent', 'due', 'currency', 'gross', 'open', 'level'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort { key: SortKey; dir: 1 | -1 }
export const DEFAULT_SORT: Sort = { key: 'date', dir: -1 };

const STATUS_ORDER = ['draft', 'open', 'partly-paid', 'partly', 'paid', 'settled', 'cancelled'];
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
  }
}

/** Sorted by `sort`, then newest first, then by number: the same order every time. */
export function sortRows(rows: readonly DocRow[], sort: Sort): DocRow[] {
  return [...rows].sort((a, b) => compare(a, b, sort.key) * sort.dir || b.inv.date.localeCompare(a.inv.date) || b.inv.createdAt.localeCompare(a.inv.createdAt));
}
