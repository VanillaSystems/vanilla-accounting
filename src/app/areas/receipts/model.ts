/**
 * Belege as the list and detail show them, derived from the books and never stored: which
 * receipts a period holds, the groups ("Braucht dich" first), what is locked, and the payments a
 * receipt could belong to, ranked. Pure, so the list, the keys and the tests read the same order.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EstvRates } from '../../../accounting/fx-conversion.js';
import type { Period } from '../../../accounting/periods.js';
import type { ReceiptFilter } from '../../shell/route.js';
import { baseCurrency } from '../../../engines/index.js';

/** The kinds of document that are not a receipt of their own. */
const NON_RECEIPT_KINDS: ReadonlyArray<Receipt['kind']> = ['supporting', 'statement', 'noise', 'duplicate'];

export interface ReceiptView {
  r: Receipt;
  /** The receipt's date, else the YYYYMMDD- its file name starts with. */
  date?: string;
  /** The day it counts in a period: its date, else the day it was read. */
  day?: string;
  vendor: string;
  desc: string;
  /** The payments (or bookings without one) it is linked to. */
  links: string[];
  /**
   * Needs no payment: typed as supporting/statement/noise/duplicate, or worth exactly 0 (not
   * merely unread) with no VAT and no link (brochures, labels, blank captures).
   */
  none: boolean;
  /** Linked to a payment or entry of a filed quarter: it never changes again (golden rule 1). */
  locked: boolean;
}

export interface Ledger {
  views: ReceiptView[];
  byId: Map<string, ReceiptView>;
  txByRef: Map<string, BankTransaction>;
  entriesByRef: Map<string, JournalEntry[]>;
  /** The receipts linked to each ref. */
  receiptsByRef: Map<string, string[]>;
  closedThrough?: string;
  /** The first day of the open quarter: receipts from here on are still being worked on. */
  openFrom: string;
}

const FILE_DATE = /^(20\d\d)(\d\d)(\d\d)-/;

/** "Vendor, what" (or " — ", " - "): the vendor and the rest; else the whole text is the vendor. */
export function splitTitle(text: string): [string, string] {
  const m = /^(.*?)(?:,\s|\s—\s|\s-\s)(.*)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

export function ledgerOf(books: Index, openFrom: string): Ledger {
  const closedThrough = books.config?.closedThrough;
  const isClosed = (d: string | undefined) => !!closedThrough && !!d && d <= closedThrough;
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const entriesByRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) {
    const list = entriesByRef.get(e.transactionRef);
    if (list) list.push(e); else entriesByRef.set(e.transactionRef, [e]);
  }
  const linksOf = new Map<string, string[]>();
  const receiptsByRef = new Map<string, string[]>();
  for (const m of books.mappings) {
    (linksOf.get(m.receiptId) ?? linksOf.set(m.receiptId, []).get(m.receiptId)!).push(m.transactionRef);
    (receiptsByRef.get(m.transactionRef) ?? receiptsByRef.set(m.transactionRef, []).get(m.transactionRef)!).push(m.receiptId);
  }
  const refClosed = (ref: string) => isClosed(txByRef.get(ref)?.date) || (entriesByRef.get(ref) ?? []).some((e) => isClosed(e.date));

  const views = books.receipts.map((r): ReceiptView => {
    const links = linksOf.get(r.id) ?? [];
    const fileDate = FILE_DATE.exec(r.filename);
    const date = r.date ?? (fileDate ? `${fileDate[1]}-${fileDate[2]}-${fileDate[3]}` : undefined);
    const [vendor, desc] = splitTitle(r.description || r.filename.replace(/\.pdf$/i, ''));
    const none = NON_RECEIPT_KINDS.includes(r.kind)
      || (r.amount === 0 && !(r.vatSummary ?? []).some((g) => g.vat > 0) && links.length === 0);
    return { r, date, day: date ?? (r.indexedAt.slice(0, 10) || undefined), vendor, desc, links, none, locked: links.some(refClosed) };
  });
  return { views, byId: new Map(views.map((v) => [v.r.id, v])), txByRef, entriesByRef, receiptsByRef, closedThrough, openFrom };
}

export const isOpen = (v: ReceiptView) => v.links.length === 0;

/** Still waiting for its payment in the open quarter or later: what the dock's badge counts. */
export const needsYou = (v: ReceiptView, l: Ledger) => !v.none && isOpen(v) && !v.locked && !!v.date && v.date >= l.openFrom;

export const badgeCount = (l: Ledger) => l.views.filter((v) => needsYou(v, l)).length;

export type Counts = Record<'alle' | ReceiptFilter, number>;

const FILTERS: Record<ReceiptFilter, (v: ReceiptView) => boolean> = {
  zugeordnet: (v) => !isOpen(v),
  offen: isOpen,
  ohneDatum: (v) => !v.date,
};

/** The text a search looks in: vendor, description, file, note, date, amount, VAT number. */
function haystack(v: ReceiptView): string {
  const { r } = v;
  return [r.description, r.filename, r.remarks, v.date, v.date && v.date.split('-').reverse().join('.'), r.amount?.toFixed(2), r.vatId].join(' ').toLowerCase();
}

export interface Visible {
  rows: ReceiptView[];
  counts: Counts;
  /** Files of the period that are no receipt (statements live with the bank). */
  hidden: ReceiptView[];
}

export function visible(l: Ledger, period: Period, filter: ReceiptFilter | undefined, q: string | undefined): Visible {
  const pool = l.views.filter((v) => !!v.day && v.day >= period.from && v.day <= period.to);
  const receipts = pool.filter((v) => !v.none);
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const match = (v: ReceiptView) => { const h = haystack(v); return words.every((w) => h.includes(w)); };
  const counts: Counts = {
    alle: receipts.length,
    zugeordnet: receipts.filter(FILTERS.zugeordnet).length,
    offen: receipts.filter(FILTERS.offen).length,
    ohneDatum: receipts.filter(FILTERS.ohneDatum).length,
  };
  const by = filter ? FILTERS[filter] : () => true;
  return {
    rows: receipts.filter(by).filter(match),
    counts,
    hidden: pool.filter((v) => v.none && v.r.kind !== 'statement').filter(match),
  };
}

export type GroupKey = 'need' | 'noDate' | `month:${string}`;
export interface Group { key: GroupKey; rows: ReceiptView[] }

const byDateDesc = (a: ReceiptView, b: ReceiptView) => (b.date ?? '').localeCompare(a.date ?? '') || a.r.filename.localeCompare(b.r.filename);

/**
 * The list's groups in order, which is also the ↑↓ order: what needs you (a suggestion first),
 * then each month, newest first. Undated receipts come last as `later`, unless the filter asks
 * for them.
 */
export function groups(rows: ReceiptView[], l: Ledger, filter: ReceiptFilter | undefined, suggested: (v: ReceiptView) => boolean): { groups: Group[]; later: ReceiptView[] } {
  const later = filter === 'ohneDatum' ? [] : rows.filter((v) => !v.date);
  const dated = rows.filter((v) => !later.includes(v));
  const need = dated.filter((v) => needsYou(v, l)).sort((a, b) => Number(suggested(b)) - Number(suggested(a)) || byDateDesc(a, b));
  const rest = dated.filter((v) => !need.includes(v)).sort(byDateDesc);
  const out: Group[] = need.length ? [{ key: 'need', rows: need }] : [];
  const byMonth = new Map<GroupKey, ReceiptView[]>();
  for (const v of rest) {
    const key: GroupKey = v.date ? `month:${v.date.slice(0, 7)}` : 'noDate';
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(v);
  }
  for (const [key, rs] of byMonth) out.push({ key, rows: rs });
  return { groups: out, later };
}

/** A receipt's amount and a payment's, in CHF, for ranking: the ESTV rate of the payment day, else the amount itself. */
export type ToChf = (amount: number, currency: string, date: string) => number;

export const chfOf = (rates: EstvRates | null): ToChf => (amount, currency, date) =>
  currency === baseCurrency() ? amount : amount * (rates?.on(currency, date)?.rate ?? 1);

export interface Candidate {
  tx: BankTransaction;
  score: number;
  /** Same amount in the same currency. */
  sameAmount: boolean;
  /** The payment moved in another currency than the receipt's. */
  otherCurrency: boolean;
  /** Days from the receipt's date, negative when the payment came first; absent without a date. */
  days?: number;
  /** Other receipts already linked to it (a grouped payment can hold several). */
  taken: number;
}

const DAY = 864e5;

/**
 * The open-period payments a receipt could belong to, best first: close in amount (in CHF),
 * close in date, the same currency. A payment that already has a receipt ranks lower but stays
 * findable (AliExpress, FedEx and Amazon put several receipts on one payment). Fees never need
 * a receipt. With a query, every payment it finds; else up to 3 best and 12 more.
 */
export function candidates(v: ReceiptView, l: Ledger, toChf: ToChf, query = ''): { best: Candidate[]; more: Candidate[] } {
  const { r } = v;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cur = r.currency || baseCurrency();
  const all: Candidate[] = [];
  for (const tx of l.txByRef.values()) {
    if (tx.amount === 0 || tx.type === 'wise-fee' || v.links.includes(tx.ref)) continue;
    if (l.closedThrough && tx.date <= l.closedThrough) continue;
    if (words.length) {
      const h = [tx.description, tx.bank, tx.date, tx.date.split('-').reverse().join('.'), Math.abs(tx.amount).toFixed(2), tx.remarks].join(' ').toLowerCase();
      if (!words.every((w) => h.includes(w))) continue;
    }
    const otherCurrency = tx.currency !== cur;
    const sameAmount = r.amount != null && !otherCurrency && Math.abs(Math.abs(tx.amount) - Math.abs(r.amount)) < 0.005;
    const days = v.date ? Math.round((Date.parse(tx.date) - Date.parse(v.date)) / DAY) : undefined;
    const want = r.amount == null ? undefined : Math.abs(toChf(r.amount, cur, tx.date));
    const dAmt = want === undefined ? 1 : Math.abs(Math.abs(toChf(tx.amount, tx.currency, tx.date)) - want) / Math.max(1, want);
    const taken = (l.receiptsByRef.get(tx.ref) ?? []).length;
    const score = dAmt * 100 + Math.abs(days ?? 0) * 0.6 + (otherCurrency ? 8 : 0) + (taken ? 30 : 0);
    all.push({ tx, score, sameAmount, otherCurrency, days, taken });
  }
  all.sort((a, b) => a.score - b.score || b.tx.date.localeCompare(a.tx.date));
  if (words.length) return { best: [], more: all.slice(0, 40) };
  const best = all.filter((c) => c.score < 25).slice(0, 3);
  return { best, more: all.filter((c) => !best.includes(c)).slice(0, 12) };
}

/**
 * The payment to offer with one key: the only open payment of exactly this amount, in this
 * currency, within a month of the receipt, that has no receipt yet.
 */
export function suggestion(v: ReceiptView, l: Ledger, toChf: ToChf): Candidate | undefined {
  if (!needsYou(v, l) || v.r.amount == null) return undefined;
  const fits = candidates(v, l, toChf).best.filter((c) => c.sameAmount && !c.taken && Math.abs(c.days ?? 99) <= 31);
  return fits.length === 1 ? fits[0] : undefined;
}
