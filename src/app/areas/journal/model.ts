/**
 * Buchungen as the list and the detail show them, derived from the books and never stored: each
 * entry with its payment, its receipts and whether it is locked; the period's rows newest first,
 * filtered and searched. Pure, so the list, the keys and the tests read the same order.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import { derivePeriod, filingKeyOf, type FilingLength, type Period } from '../../../accounting/periods.js';
import { chfAmount } from '../../../accounting/index.js';
import { evidenceCheck, lineBillsOf, type EvidenceCheck, type LineBills } from '../../../accounting/evidence-check.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { hasVat } from '../codes/model.js';
import { baseCurrency, chart, vat } from '../../../engines/index.js';
import { isManualRef } from '../../../books/refs.js';
import { bookedInFiled } from '../../../books/twins.js';
import { lockedThrough } from '../../../books/lock-line.js';
import { applyChips, type Chip, type Field } from '../../shell/chips.js';
import { isBankFee } from '../../../booking/separate-fee.js';

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
  /** Its VAT code contradicts its receipts, with the code a click would set. */
  evidence?: EvidenceCheck;
  /** Its text split for the list and the head: "Sunrise" and "Mobilabo Sep 2026". */
  title: string;
  sub: string;
}

/**
 * The receipts a booking without a payment (#89: a depreciation, an accrual) can take: those no
 * payment or booking holds yet, not set aside as a duplicate or noise; a receipt of one of its
 * amounts first, then the nearest in date. None for an entry of a payment: its receipt hangs on the
 * payment (Belege › «Zahlung verknüpfen»).
 */
export function receiptsFor(books: Pick<Index, 'transactions' | 'mappings' | 'receipts'>, entries: readonly JournalEntry[]): Receipt[] {
  const [e] = entries;
  if (!e || !isManualRef(e.transactionRef) || books.transactions.some((t) => t.ref === e.transactionRef)) return [];
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const same = (r: Receipt) => r.amount != null && entries.some((x) => (x.exchangeCurrency ?? baseCurrency()) === (r.currency || baseCurrency()) && Math.abs(x.amount - Math.abs(r.amount!)) < 0.005);
  const near = (r: Receipt) => (r.date ? Math.abs(Date.parse(r.date) - Date.parse(e.date)) : Infinity);
  return books.receipts
    .filter((r) => !linked.has(r.id) && r.kind !== 'duplicate' && r.kind !== 'noise')
    .sort((a, b) => Number(same(b)) - Number(same(a)) || near(a) - near(b) || a.id.localeCompare(b.id))
    .slice(0, 30);
}

export interface Journal {
  views: EntryView[];
  byId: Map<string, EntryView>;
  byRef: Map<string, EntryView[]>;
  /** Per payment, the bills of its card statement's lines (#409): evidence of their own lines only. */
  bills: Map<string, LineBills>;
  closedThrough?: string;
}

/** A payment needs a receipt unless it is a fee, zero, or marked as needing none. */
export const needsReceipt = (tx: BankTransaction, receipts: number) =>
  !isBankFee(tx) && tx.amount !== 0 && !tx.noReceiptNeeded && receipts === 0;

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
  const bills = new Map<string, LineBills>();
  for (const ref of new Set(books.mappings.filter((m) => m.line !== undefined).map((m) => m.transactionRef))) bills.set(ref, lineBillsOf(books.mappings, ref));
  const linesByRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) (linesByRef.get(e.transactionRef) ?? linesByRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  const views = (books.journalEntries ?? []).map((e): EntryView => {
    const tx = txByRef.get(e.transactionRef);
    const receipts = receiptsByRef.get(e.transactionRef) ?? [];
    const [title, sub] = splitText(e.description || e.transactionRef);
    const evidence = evidenceCheck(e, receipts, closedThrough, tx?.inputTaxProof, linesByRef.get(e.transactionRef), bills.get(e.transactionRef));
    return { e, tx, receipts, missing: !!tx && needsReceipt(tx, receipts.length), locked: !!closedThrough && e.date <= closedThrough, ...(evidence && { evidence }), title, sub };
  });
  const byRef = new Map<string, EntryView[]>();
  for (const v of views) (byRef.get(v.e.transactionRef) ?? byRef.set(v.e.transactionRef, []).get(v.e.transactionRef)!).push(v);
  return { views, byId: new Map(views.map((v) => [v.e.id, v])), byRef, bills, closedThrough };
}

/** A booking of a filed period whose code contradicts its receipts, with what the check proposes. */
export interface Unsettled { v: EntryView; check: EvidenceCheck }

/**
 * The bookings of the period filed last that contradict their receipts and that no correction
 * names (a correction's text names the payment, journal.correctionText): filing did not settle
 * them, and they stay as filed; a correction in the open period does (r5h-33). Undefined before
 * the first filing.
 */
export function unsettledAtFiling(j: Journal, length: FilingLength): { period: string; items: Unsettled[] } | undefined {
  const closed = j.closedThrough;
  if (!closed) return undefined;
  const period = filingKeyOf(closed, length);
  const from = derivePeriod(period)?.from ?? closed;
  const corrected = (ref: string) => j.views.some((x) => x.e.corrects === period && (x.e.description ?? '').includes(ref));
  const items = j.views.flatMap((v): Unsettled[] => {
    if (v.e.date < from || v.e.date > closed || v.e.corrects || corrected(v.e.transactionRef)) return [];
    const check = evidenceCheck(v.e, v.receipts, undefined, v.tx?.inputTaxProof, (j.byRef.get(v.e.transactionRef) ?? []).map((x) => x.e), j.bills.get(v.e.transactionRef));
    return check ? [{ v, check }] : [];
  });
  return { period, items };
}

/**
 * With no entry under the link: whether the first row takes the selection. A link that names none
 * hands it to the first row; an entry just booked or just deleted (its place kept with «Rückgängig»,
 * r6h-28) holds it; an entry shown before that went away hands it on; a link to an entry that never
 * was here keeps its place, and the detail says so (urls.md rule 5).
 */
export function firstRowTakesOver(link: string | undefined, held: readonly (string | undefined)[], seen: string | undefined): boolean {
  if (!link) return true;
  return !held.includes(link) && seen === link;
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

/** Who booked an entry: Claude (the classifier), a company rule, the app's code, a person, the AI sidebar on her wish, an invoice, the year-end; what the AI did is reviewed as a list (treuhaender-43). */
export const JOURNAL_ORIGINS = ['classify', 'rule', 'code', 'manual', 'assistant', 'invoice', 'year-close'] as const;
export type JournalOrigin = typeof JOURNAL_ORIGINS[number];
/**
 * A change the AI sidebar made is origin manual (a person's decision) and `by` the assistant: it counts as KI, not as by
 * hand (r6h-29). A booking of origin classify that a rule or the app's code decided is theirs, not Claude's (r9n-32).
 */
export const whoOf = (e: JournalEntry): string | undefined =>
  (e.by?.kind === 'assistant' ? 'assistant' : e.by?.kind === 'rule' || e.by?.kind === 'code' ? (e.origin === 'manual' ? 'manual' : e.by.kind) : e.origin);

export interface Rows { rows: EntryView[]; counts: Counts; origins: Record<JournalOrigin, number> }

/**
 * The period's entries, newest first, those of one payment together; counts before the code filter,
 * the chips and the search. `candidates`: what the chips choose from (the code filter and the search applied).
 */
export function rowsOf(j: Journal, period: Period, chips: readonly Chip[] | undefined, fields: readonly Field<EntryView>[], vat: string | undefined, q: string | undefined, accountName: (n: string) => string): Rows & { pool: EntryView[]; candidates: EntryView[] } {
  const pool = j.views.filter((v) => v.e.date >= period.from && v.e.date <= period.to);
  const counts: Counts = { alle: pool.length, ohneBeleg: pool.filter(FILTERS.ohneBeleg).length, korrekturen: pool.filter(FILTERS.korrekturen).length };
  const origins = Object.fromEntries(JOURNAL_ORIGINS.map((o) => [o, pool.filter((v) => whoOf(v.e) === o).length])) as Record<JournalOrigin, number>;
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const coded = vat ? hasVat(vat) : () => true;
  const candidates = pool
    .filter((v) => coded(v.e))
    .filter((v) => { if (!words.length) return true; const h = haystack(v, accountName); return words.every((w) => h.includes(w)); })
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || a.e.transactionRef.localeCompare(b.e.transactionRef));
  return { rows: applyChips(candidates, chips ?? [], fields), counts, origins, pool, candidates };
}

/** The rows by month, newest first: ['2026-09', [...]]. */
export function byMonth(rows: readonly EntryView[]): Array<[string, EntryView[]]> {
  const out = new Map<string, EntryView[]>();
  for (const v of rows) { const k = v.e.date.slice(0, 7); (out.get(k) ?? out.set(k, []).get(k)!).push(v); }
  return [...out];
}

/**
 * Why the classifier booked an entry, from what it saw: each receipt linked when it booked, with the
 * VAT facts that set the code, or none (no receipt: no input tax on a purchase; on a sale the
 * payment set the code). Undefined for another writer's entry, or one booked before entries
 * recorded their receipts. The model's words are `e.reason`. `sale`: the entry books revenue.
 */
export type WhySeen =
  | { kind: 'receipt'; id: string; name: string; date?: string; vat: { rate: number; tax: number; vatId?: string } | 'none' | 'unread'; sale: boolean }
  | { kind: 'noReceipt'; sale: boolean; untaxed?: string };

export function whySeen(e: JournalEntry, receipts: readonly Receipt[]): WhySeen[] | undefined {
  if (e.origin !== 'classify' || !e.receipts) return undefined;
  const sale = chart().typeOf(e.accountCredit) === 'revenue';
  // A sale booked without output tax (an export code, an answer's or a rule's V0) says so, not that it carries VAT (r4c-35).
  if (!e.receipts.length) return [{ kind: 'noReceipt', sale, ...(sale && !((vat().codes.parse(e.vatCode ?? '')?.rate ?? 0) > 0) ? { untaxed: e.vatCode ?? '' } : {}) }];
  return e.receipts.flatMap((id): WhySeen[] => {
    const r = receipts.find((x) => x.id === id);
    if (!r) return [];
    const group = r.vatSummary?.find((g) => g.ratePercent > 0);
    const vat = r.hasSwissVat === false ? 'none' as const
      : group ? { rate: group.ratePercent, tax: group.vat, ...(r.vatId && { vatId: r.vatId }) }
        : 'unread' as const;
    return [{ kind: 'receipt', id, name: r.description || r.filename, ...(r.date && { date: r.date }), vat, sale }];
  });
}


/**
 * The payments a new entry in Buchungen › N may book (treuhaender-22): not booked yet, not filed,
 * not zero, whose date, amount, text, counterparty, bank or ref hold every word typed. Those of the
 * typed amount first, then newest first.
 */
export function unbookedPayments(books: Pick<Index, 'transactions' | 'journalEntries' | 'config'>, q: string, amount: number | undefined, accounts: readonly LedgerBankAccount[]): BankTransaction[] {
  const closed = lockedThrough(books.config);
  const booked = bookedStates(books, accounts);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const same = (t: BankTransaction) => amount !== undefined && Math.abs(t.amount - Math.abs(amount)) < 0.005;
  return books.transactions
    .filter((t) => booked(t.ref) !== 'booked' && !bookedInFiled(t) && t.amount !== 0 && !(closed && t.date <= closed))
    .filter((t) => {
      const h = [formatDate(t.date), t.date, fmt(t.amount), t.amount.toFixed(2), t.description, t.counterparty, t.reference, t.bank, t.currency, t.ref].join(' ').toLowerCase();
      return words.every((w) => h.includes(w));
    })
    .sort((a, b) => Number(same(b)) - Number(same(a)) || b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref));
}
