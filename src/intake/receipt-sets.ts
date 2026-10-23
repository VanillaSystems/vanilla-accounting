/**
 * Several receipts that pay one payment (#27): a marketplace's orders (AliExpress, Amazon), a
 * courier's freight and customs invoices, paid together. Code links them when they add up to the
 * payment exactly: to the centime, in the payment's currency, from one vendor, dated near the
 * payment, and no other set of receipts fits it or them. A set that comes close but not exactly, or
 * one of two that fit, is a proposal the person links with one click (the payment's line in
 * Kontoauszüge), never a link. Never more than the payment: a set owes what it paid, or it is no
 * link. Browser-safe and pure.
 */
import type { BankTransaction, Index, Mapping, Receipt } from '../types/index.js';
import { baseCurrency } from '../engines/index.js';
import { creditSigned } from '../accounting/credit-signed.js';

/** At most this many receipts of one vendor are tried for one payment, nearest first: every subset of them (4096 at most). A vendor with more near the payment is only proposed, never linked, since a set among the others could fit as well. */
const MAX_TRIED = 12;
/** A receipt dated up to this many days before the payment, or after it, is near it. */
const DAYS_BEFORE = 31;
const DAYS_AFTER = 7;
/** A proposal's sum lies within this share of what is left to pay, or a franc, from it. */
const CLOSE = 0.02;
const DAY = 864e5;

/** Receipts for one payment, linked by code (`exact`) or proposed. `sum` and `paid` in the payment's currency, money out positive; `sum` counts the receipts linked already. */
export interface ReceiptSet { payment: string; receipts: string[]; sum: number; paid: number; currency: string; exact: boolean }

type Books = Pick<Index, 'receipts' | 'transactions' | 'mappings'>;

const cents = (n: number) => Math.round(n * 100);

/** What the receipt asks to be paid, in centimes, money out positive: a credit note below zero (creditSigned). */
const owedCents = (r: Receipt): number => cents(creditSigned(r) ?? 0);

/** What the payment paid, in centimes, money out positive. */
const paidCents = (tx: BankTransaction): number => (tx.direction === 'DBIT' ? 1 : -1) * cents(Math.abs(tx.amount));

/** Who issued the receipt, as one key: its VAT number, else the vendor of its title. None: the receipt joins no set. */
function vendorOf(r: Receipt): string | undefined {
  return r.vatId?.replace(/[^0-9]/g, '') || r.title?.vendor?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || undefined;
}

const daysFrom = (r: Receipt, tx: BankTransaction) => (Date.parse(tx.date) - Date.parse(r.date!)) / DAY;

/** Every subset of `items` with `min` elements or more, with its sum. */
function* subsets(items: readonly Receipt[], min: number): Generator<{ set: Receipt[]; sum: number }> {
  const set: Receipt[] = [];
  function* walk(from: number, sum: number): Generator<{ set: Receipt[]; sum: number }> {
    if (set.length >= min) yield { set: [...set], sum };
    for (let i = from; i < items.length; i++) {
      set.push(items[i]);
      yield* walk(i + 1, sum + owedCents(items[i]));
      set.pop();
    }
  }
  yield* walk(0, 0);
}

/** The receipts no payment holds that may join a set: archived invoices with an amount, a date in the open period and a vendor. */
function freeReceipts(books: Books, isOpen: (date: string) => boolean): Receipt[] {
  const held = new Set(books.mappings.map((m) => m.receiptId));
  return books.receipts.filter((r) => r.location === 'archived' && !held.has(r.id) && (!r.kind || r.kind === 'invoice')
    && !!r.amount && !!r.date && isOpen(r.date) && !!vendorOf(r));
}

/**
 * What fits payment `tx`: its exact sets, and the closest set that does not quite fit. `untried`:
 * the receipts of a vendor that had more near the payment than were tried; a set among them may fit it too.
 */
export interface Fit { exact: Receipt[][]; close?: { set: Receipt[]; sum: number }; linkedCents: number; untried: Set<string> }

/**
 * The sets of `free` receipts that pay `tx` together with the receipts linked to it already: from one
 * vendor (the linked receipts' too), in its currency, near its date. None for a payment of a filed
 * period, a private outlay, or one whose linked receipts are in another currency or owe it all.
 */
export function fitOf(books: Books, tx: BankTransaction, free: readonly Receipt[], isOpen: (date: string) => boolean): Fit | undefined {
  if (tx.amount === 0 || tx.type === 'wise-fee' || tx.bank === 'manual' || !isOpen(tx.date)) return undefined;
  const linked = books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => books.receipts.find((r) => r.id === m.receiptId));
  if (linked.some((r) => !r || r.amount === undefined || (r.currency ?? baseCurrency()) !== tx.currency)) return undefined;
  const linkedCents = linked.reduce((s, r) => s + owedCents(r!), 0);
  const need = paidCents(tx) - linkedCents;
  if (need === 0 || Math.sign(need) !== Math.sign(paidCents(tx))) return undefined;
  const vendors = new Map<string, Receipt[]>();
  for (const r of free) {
    const days = daysFrom(r, tx);
    if ((r.currency ?? baseCurrency()) !== tx.currency || days > DAYS_BEFORE || days < -DAYS_AFTER) continue;
    const v = vendorOf(r)!;
    if (linked.some((l) => vendorOf(l!) !== v)) continue;
    vendors.set(v, [...(vendors.get(v) ?? []), r]);
  }
  const fit: Fit = { exact: [], linkedCents, untried: new Set() };
  const tolerance = Math.max(CLOSE * Math.abs(need), 100);
  for (const group of vendors.values()) {
    const tried = [...group].sort((a, b) => Math.abs(daysFrom(a, tx)) - Math.abs(daysFrom(b, tx))).slice(0, MAX_TRIED);
    if (group.length > MAX_TRIED) for (const r of group) fit.untried.add(r.id);
    // On its own a set is two receipts at least; one receipt that completes those linked already is a set too.
    for (const { set, sum } of subsets(tried, linked.length ? 1 : 2)) {
      const off = Math.abs(sum - need);
      if (off === 0) fit.exact.push(set);
      else if (off <= tolerance && set.length + linked.length >= 2 && (!fit.close || off < Math.abs(fit.close.sum - need))) fit.close = { set, sum };
    }
  }
  return fit.exact.length || fit.close || fit.untried.size ? fit : undefined;
}

const asSet = (tx: BankTransaction, set: readonly Receipt[], fit: Fit, sum: number, exact: boolean): ReceiptSet =>
  ({ payment: tx.ref, receipts: set.map((r) => r.id).sort(), sum: (fit.linkedCents + sum) / 100, paid: paidCents(tx) / 100, currency: tx.currency, exact });

const sumOf = (set: readonly Receipt[]) => set.reduce((s, r) => s + owedCents(r), 0);

/** The proposals for one payment, for its line in Kontoauszüge: every set that fits it, exact ones first. */
export function proposalsFor(books: Books, tx: BankTransaction, isOpen: (date: string) => boolean): ReceiptSet[] {
  const fit = fitOf(books, tx, freeReceipts(books, isOpen), isOpen);
  if (!fit) return [];
  return [...fit.exact.map((set) => asSet(tx, set, fit, sumOf(set), true)), ...(fit.close ? [asSet(tx, fit.close.set, fit, fit.close.sum, false)] : [])];
}

/**
 * What code links: a payment's set when it is its only exact set, every receipt near it was tried,
 * and none of its receipts fits another payment's exact set or lies among the receipts another
 * payment could not try every set of. Every other fit stays a proposal (proposalsFor).
 */
export function receiptSetsToLink(books: Books, isOpen: (date: string) => boolean): ReceiptSet[] {
  const free = freeReceipts(books, isOpen);
  const all = books.transactions.flatMap((tx) => { const fit = fitOf(books, tx, free, isOpen); return fit ? [{ tx, fit }] : []; });
  // A receipt a payment could not try every set of may belong to that payment: no set takes it by code.
  const untried = new Set(all.flatMap(({ fit }) => [...fit.untried]));
  const fits = all.filter(({ fit }) => fit.exact.length);
  const claims = new Map<string, number>();
  for (const { fit } of fits) for (const id of new Set(fit.exact.flat().map((r) => r.id))) claims.set(id, (claims.get(id) ?? 0) + 1);
  return fits.filter(({ fit }) => fit.exact.length === 1 && !fit.untried.size && fit.exact[0].every((r) => claims.get(r.id) === 1 && !untried.has(r.id)))
    .map(({ tx, fit }) => asSet(tx, fit.exact[0], fit, sumOf(fit.exact[0]), true));
}

/** The match step's link by code (src/intake/match.ts): every set receiptSetsToLink finds, as links of the rule `receipt-set`. Returns them. */
export function linkReceiptSets(books: Books & { mappings: Mapping[] }, isOpen: (date: string) => boolean): ReceiptSet[] {
  const sets = receiptSetsToLink(books, isOpen);
  for (const s of sets) for (const receiptId of s.receipts) books.mappings.push({ transactionRef: s.payment, receiptId, by: 'rule', rule: 'receipt-set' });
  return sets;
}
