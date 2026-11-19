/**
 * What the lists of Verkauf show as facts (docs/specs/invoicing.md 4.4.2, 4.4.12, 4.8): what the
 * sent log says of each document, the status of a Rechnung and of a Gutschrift, which status tab a
 * document belongs to, and the open items on a reference date with their age. Pure functions over
 * invoices.json, built on the rules of rules.ts; nothing here is set by a click.
 */
import { fromRappen, toRappen } from '../accounting/rappen.js';
import type { Invoice, Issued, SentDocument, SentKind } from './model.js';
import { creditBeyond, creditable, openOn, paidAmount, refundDue, status, totals } from './rules.js';
import { accepted, madeFrom, positions } from './chain.js';
import { baseCurrency } from '../engines/index.js';

// ─── the sent log ────────────────────────────────────────────────────────────

export type Channel = 'email' | 'download';

/** How a document went out; an entry recorded before the app sent e-mail has no channel, its `to` tells. */
export const channelOf = (doc: Pick<SentDocument, 'channel' | 'to'>): Channel => doc.channel ?? (doc.to === 'download' ? 'download' : 'email');

/** The kinds that are the document itself going out (not a reminder or a notice about it). */
const OWN_KINDS: readonly SentKind[] = ['invoice', 'credit-note', 'resend', 'quote', 'sales-order', 'delivery-note'];

/** Every entry of the sent log for a document, its reminders and notices included, oldest first. */
export const sendsOf = (sent: readonly SentDocument[], inv: Pick<Invoice, 'id'>): SentDocument[] =>
  sent.filter((x) => x.invoiceId === inv.id && !x.deleted).sort((a, b) => a.sentAt.localeCompare(b.sentAt));

/** The entries that sent the document itself, oldest first. */
export const ownSends = (sent: readonly SentDocument[], inv: Pick<Invoice, 'id'>): SentDocument[] =>
  sendsOf(sent, inv).filter((x) => OWN_KINDS.includes(x.kind));

/** The document itself went to the customer, by e-mail or as a download. */
export const wasSent = (sent: readonly SentDocument[], inv: Pick<Invoice, 'id'>): boolean => ownSends(sent, inv).length > 0;

export interface SentFacts {
  /** The document itself went out at least once. */
  sent: boolean;
  /** Its last send, by e-mail or download. */
  last?: SentDocument;
  /** Every entry of the log for it, reminders and notices included, oldest first. */
  all: SentDocument[];
  /** The last Mahnung that went out: its level and day. */
  reminder?: { level: number; date: string };
}

export function sentFacts(sent: readonly SentDocument[], inv: Invoice): SentFacts {
  const all = sendsOf(sent, inv);
  const own = all.filter((x) => OWN_KINDS.includes(x.kind));
  const reminders = inv.status === 'issued' ? inv.reminders : [];
  const lastReminder = all.filter((x) => x.kind === 'reminder').at(-1);
  const level = lastReminder && reminders.find((r) => r.documentId === lastReminder.id)?.level;
  return {
    sent: own.length > 0,
    ...(own.length ? { last: own.at(-1) } : {}),
    all,
    ...(lastReminder && level ? { reminder: { level, date: lastReminder.sentAt.slice(0, 10) } } : {}),
  };
}

// ─── statuses ────────────────────────────────────────────────────────────────

/**
 * A Rechnung's status (4.4.2): Überfällig is derived beside it, see `isOverdue`. One closed with a
 * loss written off (Verlust) reads «Ausgebucht», whatever was paid before: the customer did not pay
 * it all. A Skonto, Rabatt, Spesen or Rundung rest keeps «Bezahlt» (decision 56). Ausgebucht counts
 * in the tab «Bezahlt», the closed ones, as the market leader keeps no tab of its own for it.
 */
export type InvoiceListStatus = 'draft' | 'open' | 'partly-paid' | 'paid' | 'written-off' | 'cancelled';
export const closedByLoss = (inv: Invoice): boolean => inv.status === 'issued' && (inv.writeOffs ?? []).some((w) => w.reason === 'loss');
export const invoiceStatus = (inv: Invoice, invoices: readonly Invoice[]): InvoiceListStatus => {
  const s = status(inv, invoices);
  if (s === 'paid' && closedByLoss(inv)) return 'written-off';
  return s === 'issued' ? 'open' : s;
};

/** A Gutschrift's status (4.4.2): Offen while something is still to pay back or set off, Teilweise once part of it went back, Abgerechnet when nothing is left. */
export type CreditListStatus = 'draft' | 'open' | 'partly' | 'settled' | 'cancelled';

/**
 * What of a credit note is still to pay back or set off against another invoice: the part its own
 * invoice does not absorb, less what went back. A note set off (`settlement: 'offset'`) counts the
 * same way: nothing carries it to the next invoice yet, so its rest stays open (slice C applies it).
 */
export function creditRest(cn: Invoice, invoices: readonly Invoice[]): number {
  if (cn.status !== 'issued' || cn.kind !== 'credit-note' || cn.cancelled) return 0;
  return refundDue(cn.settlement === 'offset' ? { ...cn, settlement: 'refund' } : cn, invoices);
}

/**
 * The one place a Gutschrift's status is decided (spec 4.4.2): Abgerechnet once nothing of it waits
 * (applied to its invoice at once, the rest paid back); Teilweise while a rest waits and something
 * of it is applied to its invoice (Verrechnung, after that invoice's payments and write-offs) or
 * paid back; Offen while all of it waits. A rest set off against a next invoice waits for phase 4.
 */
export function creditNoteStatus(cn: Invoice, invoices: readonly Invoice[]): CreditListStatus {
  if (cn.status === 'draft') return 'draft';
  if (cn.cancelled) return 'cancelled';
  const rest = creditRest(cn, invoices);
  if (rest === 0) return 'settled';
  const applied = -toRappen(totals(cn).gross) - toRappen(creditBeyond(cn, invoices)) > 0;
  return applied || paidAmount(cn) > 0 ? 'partly' : 'open';
}

/** An Angebot's status (4.4.2): Angenommen and Abgelehnt are the two of the customer, the person's click; Abgelaufen is derived. */
export type QuoteListStatus = 'draft' | 'open' | 'accepted' | 'declined' | 'expired';

/**
 * The one place an Angebot's status is decided: Angenommen by the person's click or as a fact (an
 * Auftrag or Rechnung made from it, which wins over a decline: «Trotzdem erstellen» made it); Abgelehnt
 * by her click; Abgelaufen once `validUntil` passed while it was open; else Offen.
 */
export function quoteStatus(q: Invoice, docs: readonly Invoice[], today: string): QuoteListStatus {
  if (q.status === 'draft') return 'draft';
  if (accepted(q, docs)) return 'accepted';
  if (q.declined) return 'declined';
  return q.validUntil && q.validUntil < today ? 'expired' : 'open';
}

/** An Auftrag's status (4.4.2). */
export type OrderListStatus = 'draft' | 'open' | 'partly' | 'done' | 'cancelled';

/**
 * The one place an Auftrag's status is decided, from the documents made from it: Erledigt once every
 * position (options left out) is invoiced in full and, where a Lieferschein exists, delivered in full;
 * Teilweise once something of it is delivered or invoiced; else Offen. Storniert with its Storno.
 */
export function orderStatus(o: Invoice, docs: readonly Invoice[]): OrderListStatus {
  if (o.status === 'draft') return 'draft';
  if (o.cancelled) return 'cancelled';
  const ps = positions(o, docs).filter((p) => !p.item.optional);
  const delivers = ps.some((p) => p.delivered > 0);
  if (ps.length && ps.every((p) => p.invoiced >= p.item.quantity && (!delivers || p.delivered >= p.item.quantity))) return 'done';
  return ps.some((p) => p.delivered > 0 || p.invoiced > 0) ? 'partly' : 'open';
}

/** A Lieferschein's status (4.4.2): issued is ausgeführt. */
export type DeliveryListStatus = 'draft' | 'done' | 'cancelled';
export const deliveryStatus = (n: Invoice): DeliveryListStatus => (n.status === 'draft' ? 'draft' : n.cancelled ? 'cancelled' : 'done');

/**
 * Whether an Auftrag may be cancelled (4.4.2): refused while an issued Rechnung of it stands, not
 * cancelled and not credited in full (the claim stays; a Gutschrift or the Rechnung's Storno first), a warning while a Lieferschein does
 * (`orderDelivered`, «Trotzdem stornieren»). Undefined: nothing in the way.
 */
export function orderCancelBlock(o: Invoice, docs: readonly Invoice[]): { code: 'orderInvoiced' | 'orderDelivered'; numbers: string[] } | undefined {
  const made = madeFrom(o, docs).filter((d): d is Issued => d.status === 'issued' && !d.cancelled);
  // A Rechnung credited in full (or cancelled) claims nothing any more: it no longer holds the Auftrag.
  const invoices = made.filter((d) => d.kind === 'invoice' && creditable(d, docs) > 0).map((d) => d.number);
  if (invoices.length) return { code: 'orderInvoiced', numbers: invoices };
  const notes = made.filter((d) => d.kind === 'delivery-note').map((d) => d.number);
  return notes.length ? { code: 'orderDelivered', numbers: notes } : undefined;
}

// ─── the status tabs ─────────────────────────────────────────────────────────

/** The tabs of Rechnungen beside «Alle», in their order, and «Nicht gesendet» after them. */
export const INVOICE_TABS = ['draft', 'open', 'overdue', 'partly-paid', 'paid', 'cancelled', 'unsent'] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number];
/** The tabs of Gutschriften beside «Alle» (Storniert counts what a total leaves out), and «Nicht gesendet». */
export const CREDIT_TABS = ['draft', 'open', 'partly', 'settled', 'cancelled', 'unsent'] as const;
export type CreditTab = (typeof CREDIT_TABS)[number];
/** The tabs of Angebote, Aufträge and Lieferscheine beside «Alle» (spec 4.8), and «Nicht gesendet». */
export const QUOTE_TABS = ['draft', 'open', 'accepted', 'declined', 'expired', 'unsent'] as const;
export const ORDER_TABS = ['draft', 'open', 'partly', 'done', 'cancelled', 'unsent'] as const;
export const DELIVERY_TABS = ['draft', 'done', 'cancelled', 'unsent'] as const;

/** Issued, not cancelled, and never sent itself: what «Nicht gesendet» holds. */
export const unsent = (inv: Invoice, sent: readonly SentDocument[]): boolean => inv.status === 'issued' && !inv.cancelled && !wasSent(sent, inv);

// ─── open items ──────────────────────────────────────────────────────────────

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);

/**
 * The age bands of the Debitorenliste, by the days past the due date (the column «Tage überfällig»
 * beside them): not yet due, then 1–30, 31–60, 61–90 and more than 90 days overdue
 * (docs/specs/invoicing.md section 7, decision 23 as changed on 2026-11-19).
 */
export const AGE_BANDS = ['not-due', '1-30', '31-60', '61-90', '90+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const ageBand = (overdue: number): AgeBand => (overdue <= 0 ? 'not-due' : overdue <= 30 ? '1-30' : overdue <= 60 ? '31-60' : overdue <= 90 ? '61-90' : '90+');

export interface OpenItem {
  inv: Issued;
  /** What is open on the reference date: `openOn`, the year end's own figure. */
  open: number;
  /** Days since the invoice date. */
  age: number;
  band: AgeBand;
  /** Days past the due date; 0 while not yet due. */
  overdue: number;
}

/** Every Rechnung with something open on `date`, oldest first. */
export function openItems(invoices: readonly Invoice[], date: string): OpenItem[] {
  return invoices
    .filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice' && !i.deleted)
    .map((inv) => {
      const age = Math.max(0, daysBetween(inv.date, date));
      const overdue = Math.max(0, daysBetween(inv.dueDate, date));
      return { inv, open: openOn(inv, invoices, date), age, band: ageBand(overdue), overdue };
    })
    .filter((x) => x.open > 0)
    .sort((a, b) => a.inv.date.localeCompare(b.inv.date) || a.inv.number.localeCompare(b.inv.number));
}

export type BandSums = Record<AgeBand, number>;
const noBands = (): BandSums => ({ 'not-due': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });

export interface OpenGroup { customerId: string; name: string; currency: string; items: OpenItem[]; total: number; bands: BandSums }
export interface OpenTotal { currency: string; total: number; bands: BandSums; count: number }

const sum = (xs: readonly number[]) => fromRappen(xs.reduce((s, x) => s + toRappen(x), 0));
function bandsOf(items: readonly OpenItem[]): BandSums {
  const out = noBands();
  for (const band of AGE_BANDS) out[band] = sum(items.filter((x) => x.band === band).map((x) => x.open));
  return out;
}

/** The open items by contact and currency (a contact owing in two currencies has a group for each), with subtotals, and the totals per currency, the books' currency first. */
export function openItemGroups(items: readonly OpenItem[]): { groups: OpenGroup[]; totals: OpenTotal[] } {
  const by = new Map<string, OpenItem[]>();
  for (const x of items) {
    const key = `${x.inv.customerId}\u0000${x.inv.currency}`;
    by.set(key, [...(by.get(key) ?? []), x]);
  }
  const groups = [...by.values()].map((xs) => ({
    customerId: xs[0].inv.customerId, name: xs[0].inv.customer.name, currency: xs[0].inv.currency, items: xs,
    total: sum(xs.map((x) => x.open)), bands: bandsOf(xs),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.currency.localeCompare(b.currency));
  const base = baseCurrency();
  const currencies = [...new Set(items.map((x) => x.inv.currency))].sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  const totals = currencies.map((currency) => {
    const xs = items.filter((x) => x.inv.currency === currency);
    return { currency, total: sum(xs.map((x) => x.open)), bands: bandsOf(xs), count: xs.length };
  });
  return { groups, totals };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** A table as CSV the way the app's exports write it: UTF-8 with its BOM, semicolons, CRLF; numbers with two decimals. */
export function csvOf(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    const s = typeof v === 'number' ? v.toFixed(2) : v;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
