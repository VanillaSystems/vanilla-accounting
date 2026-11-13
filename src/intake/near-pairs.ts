/**
 * Near pairs (#397): a supplier's receipt and money out that belong together although the amounts or
 * the facts are not the same to the cent, found by what is written, without a model. Pure and
 * browser-safe: the chain links what is certain (pair-chain.ts), the rest is offered with what
 * differs, in «Beleg suchen», on the receipt and in the drop.
 *
 * A wrong link is worse than none: it books a receipt's VAT onto the wrong payment. So code links a
 * near pair only when
 * - `number`: the payment's text names the receipt's own number (ownNumbers: the number an invoice
 *   word labels, a whole token, no year, no customer number) and no other payment names it and no
 *   other receipt carries it, the amounts differ by rounding to 0.05 at most, or by exactly a cash
 *   discount the payment's text states or the receipt offers («abzgl. 2% Skonto», «2 % Skonto innert
 *   10 Tagen»), and the payment is on or after the receipt's day, within the receipt's terms or
 *   BOUNDS.daysAfter; past them, whatever the days between, only on the exact amount and a number that
 *   tells one bill apart (`telling`: six characters at least, not the amount nor a date written as
 *   digits): a compensation fund's quarterly bill paid at the quarter's end (#426);
 * - `supplier`: the payment names the receipt's business (its file, or every word of the payee's
 *   name in the receipt's head), the amount is the same to the cent, and the receipt is dated before
 *   the payment within the payment terms it states (45 days when it states none);
 * and nothing else could be either of the two: the receipt has no other near pair and no other
 * candidate of the chain, nor has the payment. Never money in, a credit note, the firm's own
 * invoice, a filed payment, a pair a person took apart or the model doubted.
 */
import type { BankTransaction, Receipt } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { HEAD, wordsRe } from '../core/modules/words.js';
import { baseCurrency, documents, invoicing } from '../engines/index.js';
import { squash, tokensIn } from '../accounting/document-numbers.js';
import { BANK_WORDS, BOUNDS, namedNumbers, pairablePayment, paymentText, paysIn, takenPayments } from './pairing.js';
import { issuedByFirm, ownNumbers, type Firm } from './own-invoice.js';
import type { Businesses } from './batch-payers.js';
import type { NearOffer } from './pairing.js';

/** How a payment's amount stands to a receipt's, in one currency. */
export type Gap =
  | { kind: 'same' }
  /** Off by no more than rounding to 0.05 (a bank or a person rounding the total). */
  | { kind: 'rounded'; diff: number }
  /** Less by a cash discount: `percent` stated by the payment's text or offered by the receipt's, `discount` the amount taken off. */
  | { kind: 'discount'; percent: number; discount: number; by: 'payment' | 'receipt' }
  /** The receipt's total rounded to a whole unit: never linked by code, only offered. */
  | { kind: 'franc'; diff: number };

/** What rounding to 0.05 leaves at most. */
export const ROUNDING = 0.05;
/** A discount above this share is no cash discount; an invoice offers no more than OFFERED_DISCOUNT, a payment's own text may state up to MAX_DISCOUNT. */
const MAX_DISCOUNT = 10;
const OFFERED_DISCOUNT = 5;
/** Payment terms when the receipt states none (days after its date), and the longest read off it. */
export const DEFAULT_TERMS = 45;
const MAX_TERMS = 90;
/** How far a receipt may lie before its payment to be offered at all; after it, BOUNDS.daysBefore. */
const OFFER_DAYS = 120;

const r2 = (n: number) => Math.round(n * 100) / 100;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length).map(escape).join('|');

/**
 * The cash discounts a text states, in percent: a percentage standing right beside a discount word
 * («abzgl. 2% Skonto», «2 % Skonto innert 10 Tagen», «Skonto: 3 %»), never after a word that negates
 * it («ohne Skonto», «kein Skontoabzug»), never a VAT rate of the jurisdiction (8.1 % next to the
 * word is the VAT), at most `max` percent.
 */
export function discountsIn(text: string, words: DocumentsData = documents(), max = MAX_DISCOUNT): number[] {
  if (!words.discount?.length) return [];
  const word = `(?<![\\p{L}])(?:${alt(words.discount)})(?![\\p{L}])`;
  const none = words.discountNone?.length ? `(?<!(?<![\\p{L}])(?:${alt(words.discountNone)})\\s+)` : '';
  const pct = '(?<![\\d.,])(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*%';
  // The percentage before the word («2 % Skonto») and after it («Skonto: 3 %»), each read on its own: one does not hide the other.
  const before = new RegExp(`${none}${pct}\\s*${word}`, 'giu');
  const after = new RegExp(`${none}${word}\\s*:?\\s*${pct}`, 'giu');
  const vatRates = new Set(invoicing().rates.filter((r) => r > 0));
  const out = new Set<number>();
  for (const m of [...text.matchAll(before), ...text.matchAll(after)]) {
    const n = Number(m[1].replace(',', '.'));
    if (n > 0 && n <= max && !vatRates.has(n)) out.add(n);
  }
  return [...out];
}

/** The discounts of a payment's or a receipt's text, read once per record and words (the search weighs every pair). */
const discountCache = new WeakMap<object, { words: DocumentsData; percents: number[] }>();
function discountsOf(record: object, text: () => string, words: DocumentsData, max: number): number[] {
  const hit = discountCache.get(record);
  if (hit?.words === words) return hit.percents;
  const percents = discountsIn(text(), words, max);
  discountCache.set(record, { words, percents });
  return percents;
}

/**
 * How `tx` pays `r` in the receipt's currency: the same, rounded (≤ ROUNDING), less by a discount
 * stated (the payment's text) or offered (the receipt's text) to within rounding, the total rounded
 * to the franc; undefined otherwise, across currencies, or money the wrong way.
 */
export function gapOf(r: Pick<Receipt, 'amount' | 'currency' | 'extractedText'>, tx: BankTransaction, words: DocumentsData = documents()): Gap | undefined {
  if (!r.amount || r.amount < 0 || (r.currency || baseCurrency()) !== tx.currency) return undefined;
  const want = r2(r.amount);
  const paid = r2(Math.abs(tx.amount));
  const diff = r2(paid - want);
  if (diff === 0) return { kind: 'same' };
  if (Math.abs(diff) <= ROUNDING) return { kind: 'rounded', diff };
  if (diff < 0) {
    for (const [by, of] of [['payment', tx], ['receipt', r]] as const) {
      for (const percent of discountsOf(of, by === 'payment' ? () => paymentText(tx) : () => r.extractedText ?? '', words, by === 'payment' ? MAX_DISCOUNT : OFFERED_DISCOUNT)) {
        if (Math.abs(r2(want * (1 - percent / 100)) - paid) <= ROUNDING) return { kind: 'discount', percent, discount: r2(want - paid), by };
      }
    }
  }
  if (Number.isInteger(paid) && Math.round(want) === paid) return { kind: 'franc', diff };
  return undefined;
}

const wordsOf = (s: string) => fold(s).match(/\p{L}{4,}/gu) ?? [];
/** The telling words of the firm's and the owner's names (no legal form): a payment to them never tells a supplier, a line with them is the addressee. */
const ownWords = (firm: Firm | undefined, words: DocumentsData) => {
  const legal = new Set((words.legalForms ?? []).map(fold));
  return new Set([...wordsOf(firm?.name ?? ''), ...wordsOf(firm?.owner ?? '')].filter((w) => !legal.has(w)));
};

/** The words of a payee's name that tell who it is: four letters or more, no bank word, no legal form, no word of the firm's or the owner's name. */
function nameKeys(name: string, firm: Firm | undefined, words: DocumentsData): string[] {
  const own = ownWords(firm, words);
  const legal = new Set((words.legalForms ?? []).map(fold));
  return [...new Set(wordsOf(name))].filter((w) => !BANK_WORDS.has(w) && !legal.has(w) && !own.has(w));
}

/** A single name word this long tells a payee apart («Swisscom», «Farbmix»); a shorter one («Post») is a common word of receipts. */
const ONE_WORD = 6;

/**
 * The issuer's block of a receipt: its letterhead, the lines before the addressee (the first line
 * that names the firm or its owner), at most its first four lines when it names neither; its vendor
 * as read. The addressee block, the lines and the footer below are none of it.
 */
function issuerOf(r: Pick<Receipt, 'extractedText' | 'title'>, firm: Firm | undefined, words: DocumentsData): string {
  const own = ownWords(firm, words);
  const lines = (r.extractedText ?? '').slice(0, HEAD).split('\n').filter((l) => l.trim());
  const at = lines.findIndex((l) => wordsOf(l).some((w) => own.has(w)));
  return [...lines.slice(0, at >= 0 ? at : 4), r.title?.vendor ?? ''].join(' ');
}

/**
 * Whether the payee is the receipt's issuer: every telling word of its name stands in the receipt's
 * issuer block (issuerOf), and its name has two such words or one of ONE_WORD letters at least.
 */
export function namesSupplier(r: Pick<Receipt, 'extractedText' | 'title'>, tx: Pick<BankTransaction, 'counterparty'>, firm?: Firm, words: DocumentsData = documents()): boolean {
  const keys = nameKeys(tx.counterparty ?? '', firm, words);
  if (!keys.length || (keys.length === 1 && keys[0].length < ONE_WORD)) return false;
  const hay = new Set(fold(issuerOf(r, firm, words)).match(/\p{L}+/gu) ?? []);
  return keys.every((k) => hay.has(k));
}

/** The months a text names (1–12), by the jurisdiction's month words. */
function monthsIn(text: string, words: DocumentsData): Set<number> {
  const out = new Set<number>();
  (words.months ?? []).forEach((names, i) => { if (names.length && wordsRe(names).test(text)) out.add(i + 1); });
  return out;
}

/**
 * The payment terms a receipt states, in days after its date: the longest after a due word, a number
 * right before a day word («Zahlbar innert 30 Tagen») or a date («zahlbar bis 30.10.2026»), at most
 * MAX_TERMS; DEFAULT_TERMS when none.
 */
export function termsOf(r: Pick<Receipt, 'extractedText' | 'date'>, words: DocumentsData = documents()): number {
  const text = r.extractedText ?? '';
  let best: number | undefined;
  if (words.receipt.due.length) {
    const due = new RegExp(wordsRe(words.receipt.due).source, 'giu');
    for (const m of text.matchAll(due)) {
      // The rest of its sentence: an IBAN or the amounts below are no terms.
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100).split(/\n|\.\s/)[0];
      const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(after);
      if (date && r.date) {
        const days = Math.round((Date.UTC(+date[3], +date[2] - 1, +date[1]) - Date.parse(r.date)) / 864e5);
        if (days > 0) best = Math.max(best ?? 0, Math.min(days, MAX_TERMS));
      }
      // A number of days: an integer right before a day word, no amount, no account number.
      if (!words.days?.length) continue;
      const re = new RegExp(`(?<![\\p{L}\\d.,'’-])(\\d{1,3})\\s*(?:${alt(words.days)})(?![\\p{L}])`, 'giu');
      for (const n of after.matchAll(re)) {
        const days = Number(n[1]);
        if (days > 0) best = Math.max(best ?? 0, Math.min(days, MAX_TERMS));
      }
    }
  }
  return best ?? DEFAULT_TERMS;
}

/** One near pair: what it rests on and what differs. */
export interface NearPair {
  receipt: string;
  payment: string;
  gap: Gap;
  /** The payment's day minus the receipt's; undefined for an undated receipt. */
  days?: number;
  /** The receipt's own number the payment names (squashed). */
  number?: string;
  /** The payment names the receipt's business. */
  supplier: boolean;
  /** The payment lies in a filed period: offered as a pointer, never linked. */
  filed: boolean;
  /** Code links it (see the header): by the number, or by the supplier and the exact amount. */
  sure?: 'number' | 'supplier';
}

type Books = { receipts: readonly Receipt[]; transactions: readonly BankTransaction[]; mappings: ReadonlyArray<{ receiptId: string; transactionRef: string }> };

export interface NearOptions {
  isClosed: (date: string) => boolean;
  firm?: Firm;
  businesses?: Businesses;
  noReceipt?: (t: BankTransaction) => boolean;
  noPayment?: (r: Receipt) => boolean;
  /** Only the near pairs of this receipt or this payment, none marked sure (what code links is decided against the whole books, without `only`). */
  only?: { receipt: string } | { payment: string };
  words?: DocumentsData;
  /** False: no pair is marked sure (offers only, as with `only`). */
  decide?: boolean;
}

/** A receipt that may have a near pair: a supplier's read invoice with an amount, kept or still in the inbox, nothing linked or pointed at, not the firm's own, no credit note. */
function nearReceipt(r: Receipt, linked: ReadonlySet<string>, firm: Firm | undefined, noPayment?: (r: Receipt) => boolean): boolean {
  return !linked.has(r.id) && !r.filedPayment && (!r.kind || r.kind === 'invoice') && !!r.amount && r.amount > 0
    && !r.payout && !r.order && !paysIn(r) && !issuedByFirm(r, firm) && !noPayment?.(r);
}

/**
 * Every near pair of the books' free supplier receipts and free money out (or of `only`'s one
 * receipt or payment), each marked `sure` where code may link it. A pair is near when the amount
 * fits (gapOf) and the payment names the receipt's number or its business; an undated receipt only
 * by its business and an amount the same or rounded; a dated one lying from OFFER_DAYS before the
 * payment to BOUNDS.daysBefore after it.
 */
export function nearPairs(books: Books, opts: NearOptions): NearPair[] {
  const words = opts.words ?? documents();
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const taken = takenPayments(books as Parameters<typeof takenPayments>[0]);
  const only = opts.only;
  const receipts = books.receipts.filter((r) => (!only || !('receipt' in only) || r.id === only.receipt) && nearReceipt(r, linked, opts.firm, opts.noPayment));
  const payments = books.transactions.filter((t) => (!only || !('payment' in only) || t.ref === only.payment) && t.direction === 'DBIT' && pairablePayment(t, taken, opts.noReceipt));
  const all: NearPair[] = [];
  for (const r of receipts) {
    const apart = new Set([...(r.notPaidBy ?? []), ...(r.pairDoubted ?? [])]);
    const mine = ownNumbers(r);
    for (const tx of payments) {
      if (apart.has(tx.ref)) continue;
      const gap = gapOf(r, tx, words);
      if (!gap) continue;
      const days = r.date ? Math.round((Date.parse(tx.date) - Date.parse(r.date)) / 864e5) : undefined;
      if (days !== undefined && days < -BOUNDS.daysBefore) continue;
      const number = mine.length ? namedNumbers(r, tx)[0] : undefined;
      // Further than OFFER_DAYS only a payment that names a telling number with the exact amount: it is linked whatever the days between (#426).
      if (days !== undefined && days > OFFER_DAYS && !(number && gap.kind === 'same' && telling(number, r))) continue;
      const of = opts.businesses?.ofReceipt(r);
      const supplier = (!!of && opts.businesses!.ofPayment(tx) === of) || namesSupplier(r, tx, opts.firm, words);
      if (!number && !supplier) continue;
      if (days === undefined && (!supplier || (gap.kind !== 'same' && gap.kind !== 'rounded' && gap.kind !== 'franc'))) continue;
      all.push({ receipt: r.id, payment: tx.ref, gap, ...(days !== undefined && { days }), ...(number && { number }), supplier, filed: opts.isClosed(tx.date) });
    }
  }
  if (!only && opts.decide !== false) markSure(all, books, receipts, words);
  return all;
}

/**
 * Why a pair by its supplier alone is held back, offered instead of linked: the payment names
 * another month than the receipt (its date's, or one its text names): last month's bill against
 * this month's charge; the payee was paid this amount more than once (a recurring charge: which bill
 * a payment pays the amount does not tell); the receipt is dated before the first payment of the
 * books (its own payment may lie before them).
 */
function heldBack(r: Receipt, t: BankTransaction, first: string, inSeries: number, words: DocumentsData): boolean {
  const named = monthsIn(paymentText(t), words);
  const own = monthsIn((r.extractedText ?? '').slice(0, HEAD * 2), words);
  if (r.date) own.add(Number(r.date.slice(5, 7)));
  return [...named].some((m) => !own.has(m)) || inSeries > 1 || !r.date || r.date < first;
}

/** Shorter than this, a number may stand in another payment's text by chance: past the terms it links nothing. */
const TELLING = 6;

/**
 * A receipt's own number (squashed) that tells one bill apart past its terms (#426): TELLING
 * characters at least, and, when only digits, neither the receipt's amount (in cents or whole
 * units) nor a date (yyyymmdd, ddmmyyyy).
 */
export function telling(n: string, r: Pick<Receipt, 'amount'>): boolean {
  if (n.length < TELLING) return false;
  if (!/^\d+$/.test(n)) return true;
  const amount = Math.abs(r.amount ?? 0);
  if (n === String(Math.round(amount * 100)) || n === String(Math.round(amount))) return false;
  return !isDate(n.slice(0, 4), n.slice(4, 6), n.slice(6, 8)) && !isDate(n.slice(4, 8), n.slice(2, 4), n.slice(0, 2));
}
const isDate = (y: string, m: string, d: string): boolean => {
  if (!/^(?:19|20)\d{2}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return false;
  const day = new Date(Date.UTC(+y, +m - 1, +d));
  return day.getUTCMonth() === +m - 1 && day.getUTCDate() === +d;
};

/** Marks the pairs code may link: the rule of the header, then alone both ways among all near pairs. */
function markSure(all: NearPair[], books: Books, receipts: readonly Receipt[], words: DocumentsData): void {
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const byId = new Map(receipts.map((r) => [r.id, r]));
  // How many payments name each number, and how many receipts carry it as their own.
  const named = new Map<string, number>();
  for (const t of books.transactions) for (const w of tokensIn(paymentText(t))) named.set(w, (named.get(w) ?? 0) + 1);
  const carried = new Map<string, number>();
  for (const r of books.receipts) if (r.kind !== 'duplicate') for (const n of ownNumbers(r)) carried.set(n, (carried.get(n) ?? 0) + 1);
  // The first day the books' payments cover: a receipt before it may have been paid before the books.
  const first = books.transactions.reduce((d, t) => (t.date < d ? t.date : d), '9999-12-31');
  // How many payments go to each payee with each amount: a recurring charge pays one bill of a series each time.
  const series = new Map<string, number>();
  const seriesOf = (t: BankTransaction) => `${fold(t.counterparty ?? '')}|${t.currency}|${Math.round(Math.abs(t.amount) * 100)}`;
  for (const t of books.transactions) if (t.counterparty) series.set(seriesOf(t), (series.get(seriesOf(t)) ?? 0) + 1);
  for (const p of all) {
    const r = byId.get(p.receipt)!;
    const t = byRef.get(p.payment)!;
    // A receipt still in the inbox is linked by the run that archives it (it hands it over as kept): offered until then.
    if (p.filed || p.days === undefined || p.days < 0 || r.location !== 'archived') continue;
    const alone = !!p.number && named.get(p.number) === 1 && carried.get(p.number) === 1;
    const inTerms = p.days <= Math.max(BOUNDS.daysAfter, termsOf(r, words));
    if (alone && (p.gap.kind === 'same' || p.gap.kind === 'rounded' || p.gap.kind === 'discount') && (inTerms || (p.gap.kind === 'same' && telling(p.number!, r)))) p.sure = 'number';
    else if (p.supplier && p.gap.kind === 'same' && p.days <= termsOf(r, words) && !heldBack(r, t, first, series.get(seriesOf(t)) ?? 0, words)) p.sure = 'supplier';
  }
  const count = (key: (p: NearPair) => string) => { const m = new Map<string, number>(); for (const p of all) m.set(key(p), (m.get(key(p)) ?? 0) + 1); return m; };
  const perReceipt = count((p) => p.receipt);
  const perPayment = count((p) => p.payment);
  for (const p of all) if (p.sure && (perReceipt.get(p.receipt) !== 1 || perPayment.get(p.payment) !== 1)) delete p.sure;
}

/** The near pairs of one receipt or one payment as offered to the person (Found.near), every one: those naming the number first, then the closest. */
export function nearOffers(books: Books, only: { receipt: string } | { payment: string }, opts: Omit<NearOptions, 'only'>): NearOffer[] {
  return nearPairs(books, { ...opts, only }).sort(offerOrder).map(({ sure: _s, ...p }) => p);
}

const offerOrder = (a: NearPair, b: NearPair) => Number(!!b.number) - Number(!!a.number) || Math.abs(a.days ?? 0) - Math.abs(b.days ?? 0) || a.receipt.localeCompare(b.receipt) || a.payment.localeCompare(b.payment);

/**
 * The offers the app shows from the books it holds (the receipt's page, the drop's rows, the hand
 * form), for `only`. Only payments the server marked as waiting for their receipt are offered
 * (`waitsForReceipt`): a wage, a payment to the owner, an own transfer take none, which the server
 * decides (src/booking/receipt-wait.ts). Every pair of the books is found once per books and firm.
 */
export function offersInBooks(books: Books & { config?: { closedThrough?: string } }, only: { receipt: string } | { payment: string }, firm?: Firm): NearOffer[] {
  const key = JSON.stringify([books.config?.closedThrough, firm?.uid, firm?.name, firm?.owner]);
  let hit = shown.get(books);
  if (hit?.key !== key) {
    const closed = books.config?.closedThrough;
    const all = nearPairs(books, { isClosed: (d) => !!closed && d <= closed, firm, noReceipt: (t) => !t.waitsForReceipt, decide: false }).sort(offerOrder).map(({ sure: _s, ...p }) => p);
    const index = (k: 'receipt' | 'payment') => { const m = new Map<string, NearOffer[]>(); for (const p of all) (m.get(p[k]) ?? m.set(p[k], []).get(p[k])!).push(p); return m; };
    hit = { key, receipt: index('receipt'), payment: index('payment') };
    shown.set(books, hit);
  }
  return 'receipt' in only ? hit.receipt.get(only.receipt) ?? [] : hit.payment.get(only.payment) ?? [];
}
const shown = new WeakMap<object, { key: string; receipt: Map<string, NearOffer[]>; payment: Map<string, NearOffer[]> }>();

/** At most this many near pairs are shown for one receipt or payment, the closest; the rest is named by its count (pair.cut). */
export const OFFERED = 5;

/** A receipt's number as the payment writes it («FM-79010»), found by its squashed form. */
export function writtenNumber(tx: Pick<BankTransaction, 'description' | 'reference' | 'remarks'>, number: string): string {
  const words = [tx.description, tx.reference ?? '', tx.remarks ?? ''].join(' ').split(/[\s,;:()[\]«»"']+/).map((w) => w.replace(/^[-/#]+|[-/#.]+$/g, ''));
  return words.find((w) => squash(w) === number) ?? number;
}
