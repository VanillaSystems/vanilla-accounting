/**
 * Several receipts that pay one payment (#27, #190): a marketplace's orders, a courier's freight
 * and customs invoices, paid together. Code links them when they add up to the payment exactly: to
 * the centime, from one vendor, dated near the payment, and no other set of receipts fits it or
 * them. A set that comes close but not exactly, or one of two that fit, is a proposal the person
 * links with one click (the payment's line in Kontoauszüge), never a link. Never more than the
 * payment: a set owes what it paid, or it is no link. Browser-safe and pure.
 *
 * What a set is compared with (Due): the payment's own amount in its currency, or the amount the
 * bank names in the currency the charge was made in (originalOf: Wise's «Card transaction of 19.30
 * GBP» on a EUR balance), to the centime (2a). A card charge split across balances is one charge
 * (src/intake/charges.ts): its set is compared with the charge's original amount and linked to
 * every leg (2b). Two documents of one charge (the receipt and the invoice PDF of one card payment,
 * src/intake/duplicates.ts) count once (2e).
 *
 * A batch payer (`grouped: true` in its business's file, src/intake/batch-payers.ts) pays its open
 * receipts together: for its payments code also tries runs in date order, the oldest open receipt
 * first, adding one at a time (2c). A run may be longer than the free combinations (MAX_RUN), and,
 * where the bank names no original amount, it may meet the payment at the official daily rate
 * within BAND. Every fit is still linked only when it is the only one.
 */
import { madeByHand } from '../workspace/money-accounts.js';
import type { BankTransaction, Index, Mapping, Receipt } from '../types/index.js';
import { baseCurrency, documents } from '../engines/index.js';
import { creditSigned } from '../accounting/credit-signed.js';
import { duplicatesIn } from './duplicates.js';
import { chargesOf, type Charge } from './charges.js';
import { NO_BATCH_PAYERS, type BatchPayers } from './batch-payers.js';
import type { ToChf } from './pairing.js';

/** At most this many receipts of one vendor are tried for one payment, nearest first: every subset of them (4096 at most). A vendor with more near the payment is only proposed, never linked, since a set among the others could fit as well. */
export const MAX_TRIED = 12;
/** A batch payer's run takes at most this many of its open receipts, oldest first; with more open, the newer ones are not tried, and the person is told. */
export const MAX_RUN = 40;
/** A receipt dated up to this many days before the payment, or after it, is near it. */
const DAYS_BEFORE = 31;
const DAYS_AFTER = 7;
/** A batch payer's open receipts are looked for this many days before its payment. */
const RUN_DAYS_BEFORE = 92;
/** A batch payer's run without an original amount meets the payment at the official daily rate within this share (a bank's rate is not the official one). */
export const BAND = 0.015;
/** A proposal's sum lies within this share of what is left to pay, or a franc, from it. */
const CLOSE = 0.02;
const DAY = 864e5;

/**
 * Receipts for one payment, linked by code or proposed. `payment` is the charge's first movement,
 * `legs` every movement the set is linked to (more than one for a charge split across balances).
 * `sum` and `paid` in `currency`, money out positive; `sum` counts the receipts linked already.
 * `basis`: what the sum was compared with, the payment's own amount, the original amount its bank
 * names, or (a batch payer's run) the payment at the official daily rate. `exact`: it adds up (at
 * the rate: within BAND). `run`: a batch payer's run in date order.
 */
export interface ReceiptSet { payment: string; legs: string[]; receipts: string[]; sum: number; paid: number; currency: string; basis: Due['basis']; exact: boolean; run?: true }

/** Where code stopped looking for one payment: of `near` receipts of a vendor near it, it tried the `tried` nearest (MAX_TRIED), or a batch payer's `tried` oldest open ones (MAX_RUN). */
export interface SetCut { near: number; tried: number; limit: 'combinations' | 'run' }

/** What the set search needs beside the books: which days are open, and, in the match step, the batch payers and the official daily rates. */
export interface SetSearch {
  isOpen: (date: string) => boolean;
  payers?: BatchPayers;
  toChf?: ToChf;
}

type Books = Pick<Index, 'receipts' | 'transactions' | 'mappings'>;

const cents = (n: number) => Math.round(n * 100);

/** What the receipt asks to be paid, in centimes, money out positive: a credit note below zero (creditSigned). */
const owedCents = (r: Receipt): number => cents(creditSigned(r) ?? 0);

const sign = (tx: BankTransaction) => (tx.direction === 'DBIT' ? 1 : -1);

/** Who issued the receipt, as one key: its VAT number, else the vendor of its title. None: the receipt joins no set. */
function vendorOf(r: Receipt): string | undefined {
  return r.vatId?.replace(/[^0-9]/g, '') || r.title?.vendor?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || undefined;
}

const currencyOf = (r: Receipt) => r.currency ?? baseCurrency();
const daysFrom = (r: Receipt, tx: BankTransaction) => (Date.parse(tx.date) - Date.parse(r.date!)) / DAY;

/**
 * What a set must add up to for one charge, in the receipts' currency, in centimes, money out
 * positive: the payment's own amount, the original amount the bank names, or (`rate`) the payment
 * at the official daily rate in the books' currency, which only a batch payer's run may meet.
 */
interface Due { currency: string; cents: number; basis: 'paid' | 'original' | 'rate' }

/** The amounts a charge can be compared with. A charge split across balances has its original amount only: its legs are in other currencies. */
function duesOf(charge: Charge, toChf: ToChf | undefined): Due[] {
  const [first] = charge.legs;
  const way = sign(first);
  const dues: Due[] = [];
  const whole = charge.legs.length === 1;
  if (whole) dues.push({ currency: first.currency, cents: way * cents(Math.abs(first.amount)), basis: 'paid' });
  const o = charge.original;
  if (o && (!whole || o.currency !== first.currency)) dues.push({ currency: o.currency, cents: way * cents(o.amount), basis: 'original' });
  if (whole && !o && toChf && first.currency !== baseCurrency()) {
    const at = toChf(Math.abs(first.amount), first.currency, first.date);
    if (at !== undefined) dues.push({ currency: baseCurrency(), cents: way * cents(at), basis: 'rate' });
  }
  return dues;
}

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

/** The runs of a batch payer's open receipts in date order, the oldest first, one more each time, with their sums. */
function* runs(items: readonly Receipt[], min: number): Generator<{ set: Receipt[]; sum: number }> {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += owedCents(items[i]);
    if (i + 1 >= min) yield { set: items.slice(0, i + 1), sum };
  }
}

/** Of receipts that are one document twice (duplicatesIn), the copies: a set counts each document once (2e). The one linked, else the earlier, stays. */
function copiesAmong(receipts: readonly Receipt[], linked: ReadonlySet<string>): Set<string> {
  if (receipts.length < 2) return new Set();
  return new Set(duplicatesIn(receipts, linked, documents()).keys());
}

/** The receipts no payment holds that may join a set: archived invoices with an amount, a date in the open period and a vendor; of two documents of one charge, one (2e). */
function freeReceipts(books: Books, isOpen: (date: string) => boolean): Receipt[] {
  const held = new Set(books.mappings.map((m) => m.receiptId));
  const free = books.receipts.filter((r) => r.location === 'archived' && !held.has(r.id) && (!r.kind || r.kind === 'invoice')
    && !!r.amount && !!r.date && isOpen(r.date) && !!vendorOf(r));
  const byVendor = new Map<string, Receipt[]>();
  for (const r of free) byVendor.set(vendorOf(r)!, [...(byVendor.get(vendorOf(r)!) ?? []), r]);
  const copies = new Set([...byVendor.values()].flatMap((group) => [...copiesAmong(group, new Set())]));
  return free.filter((r) => !copies.has(r.id));
}

/** A set found for a charge. `partial`: found among the nearest MAX_TRIED of a batch payer's receipts, while it had more: a set among the others may fit too, so code does not link it (its runs it tried in full). */
interface Candidate { set: Receipt[]; sum: number; due: Due; linkedCents: number; run: boolean; exact: boolean; partial?: true }

/**
 * What fits one charge: the sets that add up, and the closest set that does not quite. `untried`:
 * the receipts of a vendor that had more near the payment than were tried; a set among them may fit
 * it too. `cut`: where code stopped looking, for the person.
 */
export interface Fit { charge: Charge; exact: Candidate[]; close?: Candidate; untried: Set<string>; cut?: SetCut }

const alone = (set: readonly Receipt[]) => set.map((r) => r.id).sort().join(' ');

/**
 * The sets of `free` receipts that pay charge `charge` together with the receipts linked to it
 * already: from one vendor (the linked receipts' too), in the currency of what it is compared with
 * (duesOf), near its date. None for a charge of a filed period, a movement made by hand (from its
 * receipt), or one whose linked receipts are in no such currency or owe it all.
 */
export function fitOf(books: Books, charge: Charge, free: readonly Receipt[], search: SetSearch): Fit | undefined {
  const { isOpen, payers = NO_BATCH_PAYERS, toChf } = search;
  const [first] = charge.legs;
  if (charge.legs.some((t) => t.amount === 0 || t.type === 'wise-fee' || madeByHand(t) || !isOpen(t.date))) return undefined;
  const refs = new Set(charge.refs);
  const linkedIds = new Set(books.mappings.filter((m) => refs.has(m.transactionRef)).map((m) => m.receiptId));
  const linkedAll = [...linkedIds].map((id) => books.receipts.find((r) => r.id === id));
  if (linkedAll.some((r) => !r || r.amount === undefined)) return undefined;
  const linkedCopies = copiesAmong(linkedAll as Receipt[], linkedIds);
  const linked = (linkedAll as Receipt[]).filter((r) => !linkedCopies.has(r.id));
  const batch = charge.legs.map((t) => payers.ofPayment(t)).find(Boolean);
  const fit: Fit = { charge, exact: [], untried: new Set() };
  for (const due of duesOf(charge, toChf)) {
    if (linked.some((r) => currencyOf(r) !== due.currency)) continue;
    const linkedCents = linked.reduce((s, r) => s + owedCents(r), 0);
    const need = due.cents - linkedCents;
    if (need === 0 || Math.sign(need) !== Math.sign(due.cents)) continue;
    const vendors = new Map<string, Receipt[]>();
    for (const r of free) {
      const days = daysFrom(r, first);
      if (currencyOf(r) !== due.currency || days > RUN_DAYS_BEFORE || days < -DAYS_AFTER) continue;
      const v = vendorOf(r)!;
      if (linked.some((l) => vendorOf(l) !== v)) continue;
      vendors.set(v, [...(vendors.get(v) ?? []), r]);
    }
    const tolerance = Math.max(CLOSE * Math.abs(need), 100);
    const take = (set: Receipt[], sum: number, run: boolean, exact: boolean, partial = false): Candidate => ({ set, sum, due, linkedCents, run, exact, ...(partial ? { partial: true as const } : {}) });
    for (const all of vendors.values()) {
      // A free receipt that repeats one linked to the charge already is no part of a set.
      const copies = linked.length ? copiesAmong([...linked, ...all], linkedIds) : new Set<string>();
      const group = all.filter((r) => !copies.has(r.id));
      // On its own a set is two receipts at least; one receipt that completes those linked already is a set too.
      const min = linked.length ? 1 : 2;
      if (due.basis !== 'rate') {
        const near = group.filter((r) => daysFrom(r, first) <= DAYS_BEFORE);
        const tried = [...near].sort((a, b) => Math.abs(daysFrom(a, first)) - Math.abs(daysFrom(b, first))).slice(0, MAX_TRIED);
        const flagged = !!batch && near.some((r) => payers.ofReceipt(r) === batch);
        if (near.length > MAX_TRIED) {
          fit.cut = { near: near.length, tried: MAX_TRIED, limit: 'combinations' };
          // A batch payer's runs try its receipts in their order instead: a set among the others holds back only the free combinations (Candidate.partial).
          if (!flagged) for (const r of near) fit.untried.add(r.id);
        }
        for (const { set, sum } of subsets(tried, min)) {
          const off = Math.abs(sum - need);
          if (off === 0) fit.exact.push(take(set, sum, false, true, flagged && near.length > MAX_TRIED));
          else if (off <= tolerance && set.length + linked.length >= 2 && (!fit.close || off < Math.abs(fit.close.sum - (fit.close.due.cents - fit.close.linkedCents)))) fit.close = take(set, sum, false, false);
        }
      }
      if (!batch) continue;
      // A batch payer's open receipts in date order, the oldest first (2c).
      const open = group.filter((r) => payers.ofReceipt(r) === batch).sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id));
      if (open.length > MAX_RUN) {
        fit.cut = { near: open.length, tried: MAX_RUN, limit: 'run' };
        for (const r of open) fit.untried.add(r.id);
      }
      const band = due.basis === 'rate' ? Math.abs(due.cents) * BAND : 0;
      for (const { set, sum } of runs(open.slice(0, MAX_RUN), min)) {
        if (Math.abs(sum - need) > band) continue;
        // A free combination that is also a run was tried in full after all.
        const same = fit.exact.find((c) => alone(c.set) === alone(set));
        if (same) { delete same.partial; same.run = true; } else fit.exact.push(take(set, sum, true, true));
      }
    }
  }
  return fit.exact.length || fit.close || fit.untried.size || fit.cut ? fit : undefined;
}

const asSet = (c: Candidate, charge: Charge): ReceiptSet => ({
  payment: charge.refs[0], legs: charge.refs, receipts: c.set.map((r) => r.id).sort(), sum: (c.linkedCents + c.sum) / 100, paid: c.due.cents / 100,
  currency: c.due.currency, basis: c.due.basis, exact: c.exact, ...(c.run ? { run: true as const } : {}),
});

const searchOf = (s: SetSearch | ((date: string) => boolean)): SetSearch => (typeof s === 'function' ? { isOpen: s } : s);

/** What code offers for one payment, for its line in Kontoauszüge: every set that fits it, exact ones first, and where code stopped looking (named to the person). */
export function proposalsFor(books: Books, tx: BankTransaction, search: SetSearch | ((date: string) => boolean)): { sets: ReceiptSet[]; cut?: SetCut } {
  const s = searchOf(search);
  const fit = fitOf(books, chargesOf(books.transactions).of(tx), freeReceipts(books, s.isOpen), s);
  if (!fit) return { sets: [] };
  return { sets: [...fit.exact, ...(fit.close ? [fit.close] : [])].map((c) => asSet(c, fit.charge)), ...(fit.cut ? { cut: fit.cut } : {}) };
}

/**
 * What code links: a charge's set when it is its only set that adds up (of a batch payer, its only
 * run that does, when one does), every receipt near it was tried (a batch payer's in its runs), and none of its receipts fits another charge's set or lies
 * among the receipts another charge could not try every set of. A set with a receipt a person took
 * apart from one of the charge's movements (Receipt.notPaidBy) is never linked. Every other fit
 * stays a proposal (proposalsFor).
 */
export function receiptSetsToLink(books: Books, search: SetSearch | ((date: string) => boolean)): { sets: ReceiptSet[]; cuts: SetCut[] } {
  const s = searchOf(search);
  const free = freeReceipts(books, s.isOpen);
  const charges = chargesOf(books.transactions);
  const seen = new Set<string>();
  const all: Fit[] = [];
  for (const tx of books.transactions) {
    const charge = charges.of(tx);
    if (seen.has(charge.refs[0])) continue;
    seen.add(charge.refs[0]);
    const fit = fitOf(books, charge, free, s);
    if (fit) all.push(fit);
  }
  // A receipt a charge could not try every set of may belong to that charge: no set takes it by code.
  const untried = new Set(all.flatMap((fit) => [...fit.untried]));
  // A batch payer's runs come before any free combination: when one of them fits, the combinations are not its candidates (2c).
  const fits = all.flatMap((fit) => { const runs = fit.exact.filter((c) => c.run); const pick = runs.length ? runs : fit.exact; return pick.length ? [{ fit, pick }] : []; });
  const claims = new Map<string, number>();
  for (const { pick } of fits) for (const id of new Set(pick.flatMap((c) => c.set.map((r) => r.id)))) claims.set(id, (claims.get(id) ?? 0) + 1);
  const sets = fits.filter(({ fit, pick }) => pick.length === 1 && !fit.untried.size && !pick[0].partial && pick[0].set.every((r) => claims.get(r.id) === 1 && !untried.has(r.id) && !fit.charge.refs.some((ref) => r.notPaidBy?.includes(ref))))
    .map(({ fit, pick }) => asSet(pick[0], fit.charge));
  return { sets, cuts: all.flatMap((fit) => (fit.cut ? [fit.cut] : [])) };
}

/** The match step's link by code (src/intake/match.ts): every set receiptSetsToLink finds, linked to each of its movements as links of the rule `receipt-set`. Returns them, and where code stopped looking. */
export function linkReceiptSets(books: Books & { mappings: Mapping[] }, search: SetSearch | ((date: string) => boolean)): { sets: ReceiptSet[]; cuts: SetCut[] } {
  const found = receiptSetsToLink(books, search);
  for (const s of found.sets) for (const transactionRef of s.legs) for (const receiptId of s.receipts) books.mappings.push({ transactionRef, receiptId, by: 'rule', rule: 'receipt-set' });
  return found;
}

/**
 * The legs of a split card charge that wait while another leg of it holds its receipts (2b): a
 * person, the model or an older run linked only one. When the receipts on the charge add up to its
 * original amount to the centime (a copy counted once), they are linked to every leg of it that is
 * open and holds none, unless a person took one of them apart from that leg. Returns what it linked.
 */
export function linkSplitLegs(books: Books & { mappings: Mapping[] }, isOpen: (date: string) => boolean): Array<{ legs: string[]; receipts: string[] }> {
  const done: Array<{ legs: string[]; receipts: string[] }> = [];
  for (const charge of chargesOf(books.transactions).splits) {
    const o = charge.original!;
    const holding = (ref: string) => books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId);
    const waiting = charge.legs.filter((t) => !holding(t.ref).length && isOpen(t.date) && !t.noReceiptNeeded);
    if (!waiting.length || waiting.length === charge.legs.length) continue;
    const ids = new Set(charge.refs.flatMap(holding));
    const receipts = [...ids].map((id) => books.receipts.find((r) => r.id === id));
    if (receipts.some((r) => !r || r.amount === undefined || currencyOf(r) !== o.currency)) continue;
    const copies = copiesAmong(receipts as Receipt[], ids);
    const own = (receipts as Receipt[]).filter((r) => !copies.has(r.id));
    if (own.reduce((s, r) => s + owedCents(r), 0) !== sign(charge.legs[0]) * cents(o.amount)) continue;
    const legs = waiting.filter((t) => !own.some((r) => r.notPaidBy?.includes(t.ref))).map((t) => t.ref);
    if (!legs.length) continue;
    for (const transactionRef of legs) for (const r of own) books.mappings.push({ transactionRef, receiptId: r.id, by: 'rule', rule: 'split-charge' });
    done.push({ legs, receipts: own.map((r) => r.id) });
  }
  return done;
}
