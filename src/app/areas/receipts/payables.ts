/**
 * Zu bezahlen (#571): the supplier bills among the receipts, with the day each is due and where it
 * stands, as facts: open, overdue (its day has passed, nothing paid it) or paid (linked to a payment,
 * the day of that payment). A view of Belege, derived from the books on every read and never stored:
 * no bill object, no booking. The due date is a person's (`Receipt.dueDate`) or the one its text
 * states (src/books/due-date.ts). Pure, so the list, the print, the CSV and the tests read the same rows.
 */
import type { Period } from '../../../accounting/periods.js';
import type { DocumentsData } from '../../../core/modules/schema.js';
import { dueOf, type DueSource } from '../../../books/due-date.js';
import { issuedByFirm } from '../../../intake/own-invoice.js';
import type { Ledger, ReceiptView } from './model.js';

export const BILL_STATES = ['overdue', 'open', 'paid'] as const;
export type BillState = typeof BILL_STATES[number];

export interface Bill {
  v: ReceiptView;
  /** The day it is due, and whose that day is. */
  due: string;
  dueBy: DueSource;
  state: BillState;
  /** The day of the first payment it is linked to (or of the filed payment it pays), when paid. */
  paidOn?: string;
  amount: number;
  currency: string;
}

/**
 * The day a receipt was paid: its first linked payment's, else the payment of a filed quarter it pays
 * (`filedPayment`, which takes no link). A link to a booking without a payment (an accrual, a
 * depreciation) pays nothing.
 */
export function paidOn(v: ReceiptView, l: Pick<Ledger, 'txByRef'>): string | undefined {
  const days = v.links.flatMap((ref) => l.txByRef.get(ref)?.date ?? []);
  const filed = v.r.filedPayment ? l.txByRef.get(v.r.filedPayment)?.date : undefined;
  return [...days, ...(filed ? [filed] : [])].sort()[0];
}

/**
 * The receipt as a bill to pay, or undefined: a receipt (not set aside) of money owed, with an amount
 * above zero (a credit note is money back), not a sale, a payout or a provider's report, not the
 * firm's own invoice, not an order page or a VAT-only correction (no payment pays those), and with a
 * due date. A receipt without one is no bill here: a till receipt was paid on the spot.
 */
export function billOf(v: ReceiptView, l: Pick<Ledger, 'txByRef' | 'firm'>, today: string, words: DocumentsData): Bill | undefined {
  const { r } = v;
  if (v.none || r.amount == null || r.amount <= 0 || r.kind === 'sales-record' || r.payout || r.report || v.orderPage || v.vatCorrection) return undefined;
  if (issuedByFirm(r, l.firm)) return undefined;
  const due = dueOf({ dueDate: r.dueDate, extractedText: r.extractedText, date: v.date }, words);
  if (!due) return undefined;
  const paid = paidOn(v, l);
  const state: BillState = paid ? 'paid' : due.day < today ? 'overdue' : 'open';
  return { v, due: due.day, dueBy: due.by, state, ...(paid ? { paidOn: paid } : {}), amount: r.amount, currency: r.currency ?? '' };
}

/**
 * The bills of a period, by Belege's rule (placeDay): an unpaid one from before, or undated, stands in
 * the working period, a paid one in its payment's. Overdue first, then open, each by due day, then
 * paid, the latest payment first.
 */
export function billsOf(l: Ledger, period: Pick<Period, 'from' | 'to'>, today: string, words: DocumentsData): Bill[] {
  const out: Bill[] = [];
  for (const v of l.views) {
    if (!v.day || v.day < period.from || v.day > period.to) continue;
    const b = billOf(v, l, today, words);
    if (b) out.push(b);
  }
  const rank = (b: Bill) => BILL_STATES.indexOf(b.state);
  return out.sort((a, b) => rank(a) - rank(b) || (a.state === 'paid' ? (b.paidOn ?? '').localeCompare(a.paidOn ?? '') : a.due.localeCompare(b.due)) || a.v.r.filename.localeCompare(b.v.r.filename));
}

/** `open` counts the overdue ones too (passes). */
export type BillCounts = Record<'all' | BillState, number>;

export const billCounts = (bills: readonly Bill[]): BillCounts => ({
  all: bills.length,
  overdue: bills.filter((b) => b.state === 'overdue').length,
  open: bills.filter((b) => b.state !== 'paid').length,
  paid: bills.filter((b) => b.state === 'paid').length,
});

/** «open» holds the overdue ones too, as Rechnungen's does: everything not yet paid. */
export const passes = (b: Bill, status: BillState | undefined) => !status || (status === 'open' ? b.state !== 'paid' : b.state === status);

/** What is still to pay, and how much of it is overdue, per currency (the books' first): amounts as the bills state them. */
export function unpaidSums(bills: readonly Bill[], base: string): Array<{ currency: string; open: number; overdue: number }> {
  const by = new Map<string, { open: number; overdue: number }>();
  for (const b of bills) {
    if (b.state === 'paid') continue;
    const cur = b.currency || base;
    const s = by.get(cur) ?? { open: 0, overdue: 0 };
    s.open += b.amount;
    if (b.state === 'overdue') s.overdue += b.amount;
    by.set(cur, s);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...by].sort(([a], [b]) => Number(b === base) - Number(a === base) || a.localeCompare(b)).map(([currency, s]) => ({ currency, open: r2(s.open), overdue: r2(s.overdue) }));
}

/** The words of the table's head and states, given by the page (i18n), so the CSV and the print read as the list. */
export interface BillWords { head: [date: string, vendor: string, what: string, due: string, state: string, paidOn: string, currency: string, amount: string, file: string]; state: Record<BillState, string> }

/** The bills as a table: the CSV's rows and the print's, dates as the app writes them (dd.mm.yyyy), the amount as a number. */
export function billsTable(bills: readonly Bill[], w: BillWords, base: string): { head: string[]; rows: Array<Array<string | number>>; money: number[] } {
  const day = (iso: string | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
  return {
    head: [...w.head],
    rows: bills.map((b) => [day(b.v.date), b.v.vendor, b.v.desc, day(b.due), w.state[b.state], day(b.paidOn), b.currency || base, b.amount, b.v.r.filename]),
    money: [7],
  };
}
