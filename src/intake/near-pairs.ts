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
 *   10 Tagen»), and the payment is on or after the receipt's day;
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
import { baseCurrency, documents } from '../engines/index.js';
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
/** A discount above this share is no cash discount. */
const MAX_DISCOUNT = 10;
/** Payment terms when the receipt states none (days after its date). */
export const DEFAULT_TERMS = 45;
/** How far a receipt may lie before its payment to be offered at all; after it, BOUNDS.daysBefore. */
const OFFER_DAYS = 120;

const r2 = (n: number) => Math.round(n * 100) / 100;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The cash discounts a text states, in percent: a percentage within a few words of a discount word («abzgl. 2% Skonto», «2 % Skonto innert 10 Tagen», «Skonto 3 %»). */
export function discountsIn(text: string, words: DocumentsData = documents()): number[] {
  if (!words.discount?.length) return [];
  const re = new RegExp(wordsRe(words.discount).source, 'giu');
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25);
    for (const p of around.matchAll(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/g)) {
      const n = Number(p[1].replace(',', '.'));
      if (n > 0 && n <= MAX_DISCOUNT) out.add(n);
    }
  }
  return [...out];
}

/** The discounts of a payment's or a receipt's text, read once per record and words (the search weighs every pair). */
const discountCache = new WeakMap<object, { words: DocumentsData; percents: number[] }>();
function discountsOf(record: object, text: () => string, words: DocumentsData): number[] {
  const hit = discountCache.get(record);
  if (hit?.words === words) return hit.percents;
  const percents = discountsIn(text(), words);
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
      for (const percent of discountsOf(of, by === 'payment' ? () => paymentText(tx) : () => r.extractedText ?? '', words)) {
        if (Math.abs(r2(want * (1 - percent / 100)) - paid) <= ROUNDING) return { kind: 'discount', percent, discount: r2(want - paid), by };
      }
    }
  }
  if (Number.isInteger(paid) && Math.round(want) === paid) return { kind: 'franc', diff };
  return undefined;
}

/** Words of a firm's name that say nothing of who it is. */
const LEGAL = new Set(['gmbh', 'sarl', 'sagl', 'corp', 'limited', 'company', 'holding', 'gruppe', 'group', 'genossenschaft', 'stiftung', 'verein']);

/** The words of a payee's name that tell who it is: four letters or more, no bank word, no legal form, no word of the firm's own name. */
function nameKeys(name: string, firm?: Firm): string[] {
  const own = new Set(fold(firm?.name ?? '').match(/\p{L}{4,}/gu) ?? []);
  return [...new Set(fold(name).match(/\p{L}{4,}/gu) ?? [])].filter((w) => !BANK_WORDS.has(w) && !LEGAL.has(w) && !own.has(w));
}

/** Whether every telling word of the payee's name stands as a word in the receipt's head, its vendor or its description. */
export function namesSupplier(r: Pick<Receipt, 'extractedText' | 'title' | 'description'>, tx: Pick<BankTransaction, 'counterparty'>, firm?: Firm): boolean {
  const keys = nameKeys(tx.counterparty ?? '', firm);
  if (!keys.length) return false;
  const hay = new Set(fold([(r.extractedText ?? '').slice(0, HEAD), r.title?.vendor ?? '', r.description ?? ''].join(' ')).match(/\p{L}+/gu) ?? []);
  return keys.every((k) => hay.has(k));
}

/** The payment terms a receipt states, in days after its date: the longest after a due word («Zahlbar innert 30 Tagen», «zahlbar bis 30.10.2026»); DEFAULT_TERMS when none. */
export function termsOf(r: Pick<Receipt, 'extractedText' | 'date'>, words: DocumentsData = documents()): number {
  const text = r.extractedText ?? '';
  let best: number | undefined;
  if (words.receipt.due.length) {
    const re = new RegExp(wordsRe(words.receipt.due).source, 'giu');
    for (const m of text.matchAll(re)) {
      // The rest of its sentence: an IBAN or the amounts below are no terms.
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100).split(/\n|\.\s/)[0];
      const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(after);
      if (date && r.date) {
        const days = Math.round((Date.UTC(+date[3], +date[2] - 1, +date[1]) - Date.parse(r.date)) / 864e5);
        if (days > 0 && days <= 365) best = Math.max(best ?? 0, days);
      }
      // A number of days: an integer that is no amount, no percentage and no part of a date.
      for (const n of after.replace(/\d{1,2}\.\d{1,2}\.\d{4}/g, ' ').matchAll(/(?<![\p{L}\d.,'’])(\d{1,3})(?![\d.,'’]|\s*%)/gu)) {
        const days = Number(n[1]);
        if (days > 0 && days <= 180) best = Math.max(best ?? 0, days);
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
      if (days !== undefined && (days < -BOUNDS.daysBefore || days > OFFER_DAYS)) continue;
      const number = mine.length ? namedNumbers(r, tx)[0] : undefined;
      const of = opts.businesses?.ofReceipt(r);
      const supplier = (!!of && opts.businesses!.ofPayment(tx) === of) || namesSupplier(r, tx, opts.firm);
      if (!number && !supplier) continue;
      if (days === undefined && (!supplier || (gap.kind !== 'same' && gap.kind !== 'rounded' && gap.kind !== 'franc'))) continue;
      all.push({ receipt: r.id, payment: tx.ref, gap, ...(days !== undefined && { days }), ...(number && { number }), supplier, filed: opts.isClosed(tx.date) });
    }
  }
  if (!only) markSure(all, books, receipts, words);
  return all;
}

/** Marks the pairs code may link: the rule of the header, then alone both ways among all near pairs. */
function markSure(all: NearPair[], books: Books, receipts: readonly Receipt[], words: DocumentsData): void {
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const byId = new Map(receipts.map((r) => [r.id, r]));
  // How many payments name each number, and how many receipts carry it as their own.
  const named = new Map<string, number>();
  for (const t of books.transactions) for (const w of tokensIn(paymentText(t))) named.set(w, (named.get(w) ?? 0) + 1);
  const carried = new Map<string, number>();
  for (const r of books.receipts) if (r.kind !== 'duplicate') for (const n of ownNumbers(r)) carried.set(n, (carried.get(n) ?? 0) + 1);
  for (const p of all) {
    // A receipt still in the inbox is linked by the run that archives it (it hands it over as kept): offered until then.
    if (p.filed || p.days === undefined || p.days < 0 || byId.get(p.receipt)?.location !== 'archived') continue;
    if (p.number && named.get(p.number) === 1 && carried.get(p.number) === 1 && (p.gap.kind === 'same' || p.gap.kind === 'rounded' || p.gap.kind === 'discount') && p.days <= Math.max(BOUNDS.daysAfter, termsOf(byId.get(p.receipt)!, words))) p.sure = 'number';
    else if (p.supplier && p.gap.kind === 'same' && p.days <= termsOf(byId.get(p.receipt)!, words) && byRef.has(p.payment)) p.sure = 'supplier';
  }
  const count = (key: (p: NearPair) => string) => { const m = new Map<string, number>(); for (const p of all) m.set(key(p), (m.get(key(p)) ?? 0) + 1); return m; };
  const perReceipt = count((p) => p.receipt);
  const perPayment = count((p) => p.payment);
  for (const p of all) if (p.sure && (perReceipt.get(p.receipt) !== 1 || perPayment.get(p.payment) !== 1)) delete p.sure;
}

/** The near pairs of one receipt or one payment as offered to the person (Found.near), every one: those naming the number first, then the closest. */
export function nearOffers(books: Books, only: { receipt: string } | { payment: string }, opts: Omit<NearOptions, 'only'>): NearOffer[] {
  return nearPairs(books, { ...opts, only })
    .sort((a, b) => Number(!!b.number) - Number(!!a.number) || Math.abs(a.days ?? 0) - Math.abs(b.days ?? 0) || a.receipt.localeCompare(b.receipt) || a.payment.localeCompare(b.payment))
    .map(({ sure: _s, ...p }) => p);
}

/** At most this many near pairs are shown for one receipt or payment, the closest; the rest is named by its count (pair.cut). */
export const OFFERED = 5;

/** A receipt's number as the payment writes it («FM-79010»), found by its squashed form. */
export function writtenNumber(tx: Pick<BankTransaction, 'description' | 'reference' | 'remarks'>, number: string): string {
  const words = [tx.description, tx.reference ?? '', tx.remarks ?? ''].join(' ').split(/[\s,;:()[\]«»"']+/).map((w) => w.replace(/^[-/#]+|[-/#.]+$/g, ''));
  return words.find((w) => squash(w) === number) ?? number;
}
