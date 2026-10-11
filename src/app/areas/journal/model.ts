/**
 * Buchungen as the list and the detail show them, derived from the books and never stored: each
 * entry with its payment, its receipts and whether it is locked; the period's rows newest first,
 * filtered and searched. Pure, so the list, the keys and the tests read the same order.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { Period } from '../../../accounting/periods.js';
import { chfAmount } from '../../../accounting/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { hasVat } from '../codes/model.js';

export interface EntryView {
  e: JournalEntry;
  /** The bank payment it books, if it books one. */
  tx?: BankTransaction;
  /** The receipts linked to its payment (or to its manual ref). */
  receipts: Receipt[];
  /** Its payment still waits for a receipt. */
  missing: boolean;
  /** Dated in a filed quarter: it never changes again (golden rule 1). */
  locked: boolean;
  /** Its text split for the list and the head: "Sunrise" and "Mobilabo Sep 2026". */
  title: string;
  sub: string;
}

export interface Journal {
  views: EntryView[];
  byId: Map<string, EntryView>;
  byRef: Map<string, EntryView[]>;
  closedThrough?: string;
}

/** A payment needs a receipt unless it is a fee, zero, or marked as needing none. */
export const needsReceipt = (tx: BankTransaction, receipts: number) =>
  tx.type !== 'wise-fee' && tx.amount !== 0 && !tx.noReceiptNeeded && receipts === 0;

/** "Vendor, what" (or " — ", " - ", ": "): the first part and the rest. */
export function splitText(text: string): [string, string] {
  const m = /^(.*?)(?:,\s|\s—\s|\s-\s|:\s)(.*)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

export function journalOf(books: Index): Journal {
  const closedThrough = books.config?.closedThrough;
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const receiptById = new Map(books.receipts.map((r) => [r.id, r]));
  const receiptsByRef = new Map<string, Receipt[]>();
  for (const m of books.mappings) {
    const r = receiptById.get(m.receiptId);
    if (r) (receiptsByRef.get(m.transactionRef) ?? receiptsByRef.set(m.transactionRef, []).get(m.transactionRef)!).push(r);
  }
  const views = (books.journalEntries ?? []).map((e): EntryView => {
    const tx = txByRef.get(e.transactionRef);
    const receipts = receiptsByRef.get(e.transactionRef) ?? [];
    const [title, sub] = splitText(e.description || e.transactionRef);
    return { e, tx, receipts, missing: !!tx && needsReceipt(tx, receipts.length), locked: !!closedThrough && e.date <= closedThrough, title, sub };
  });
  const byRef = new Map<string, EntryView[]>();
  for (const v of views) (byRef.get(v.e.transactionRef) ?? byRef.set(v.e.transactionRef, []).get(v.e.transactionRef)!).push(v);
  return { views, byId: new Map(views.map((v) => [v.e.id, v])), byRef, closedThrough };
}

export const JOURNAL_FILTERS = ['ohneBeleg', 'korrekturen'] as const;
export type JournalFilter = typeof JOURNAL_FILTERS[number];
export type Counts = Record<'alle' | JournalFilter, number>;

const FILTERS: Record<JournalFilter, (v: EntryView) => boolean> = {
  ohneBeleg: (v) => v.missing,
  korrekturen: (v) => !!v.e.corrects,
};

/** The text a search looks in: text, accounts with their names, code, ref, date, amount and CHF. */
function haystack(v: EntryView, accountName: (n: string) => string): string {
  const { e } = v;
  return [e.description, e.accountDebit, e.accountCredit, accountName(e.accountDebit), accountName(e.accountCredit), e.vatCode, e.transactionRef,
    formatDate(e.date), fmt(e.amount), fmt(chfAmount(e))].join(' ').toLowerCase();
}

export interface Rows { rows: EntryView[]; counts: Counts }

/** The period's entries, newest first, those of one payment together; counts before the code filter and the search. */
export function rowsOf(j: Journal, period: Period, filter: JournalFilter | undefined, vat: string | undefined, q: string | undefined, accountName: (n: string) => string): Rows {
  const pool = j.views.filter((v) => v.e.date >= period.from && v.e.date <= period.to);
  const counts: Counts = { alle: pool.length, ohneBeleg: pool.filter(FILTERS.ohneBeleg).length, korrekturen: pool.filter(FILTERS.korrekturen).length };
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const coded = vat ? hasVat(vat) : () => true;
  const rows = pool
    .filter((v) => !filter || FILTERS[filter](v))
    .filter((v) => coded(v.e))
    .filter((v) => { if (!words.length) return true; const h = haystack(v, accountName); return words.every((w) => h.includes(w)); })
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || a.e.transactionRef.localeCompare(b.e.transactionRef));
  return { rows, counts };
}

/** The rows by month, newest first: ['2026-09', [...]]. */
export function byMonth(rows: readonly EntryView[]): Array<[string, EntryView[]]> {
  const out = new Map<string, EntryView[]>();
  for (const v of rows) { const k = v.e.date.slice(0, 7); (out.get(k) ?? out.set(k, []).get(k)!).push(v); }
  return [...out];
}
