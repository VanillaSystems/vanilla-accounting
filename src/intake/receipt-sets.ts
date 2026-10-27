/**
 * Several receipts that pay one payment (#27, #190): a marketplace's orders, a courier's freight
 * and customs invoices, paid together. Code links them when they add up to the payment: from one
 * vendor, dated near the payment, and no other set of receipts fits it or them. A set that comes
 * close but not exactly, or one of two that fit, is a proposal the person links with one click (the
 * payment's line in Kontoauszüge), never a link. Browser-safe and pure.
 *
 * What a set is compared with (Due): the payment's own amount in its currency, or the amount the
 * bank names in the currency the charge was made in (originalOf: Wise's «Card transaction of 19.30
 * GBP» on a EUR balance), to the centime (2a). A card charge split across balances is one charge
 * (src/intake/charges.ts): its set is compared with the charge's original amount and linked to
 * every leg (2b). Two documents of one charge (the receipt and the invoice PDF of one card payment,
 * src/intake/duplicates.ts) count once (2e): a free receipt that repeats another free one or one a
 * payment holds is no part of any set. Receipts a person linked to a payment are the person's set:
 * code never takes one of them for a copy of another.
 *
 * Rounding (ROUNDING): a shop that rounds each order to the centime may charge a centime more or
 * less than its documents add up to. When no set adds up exactly, the one set within a centime per
 * receipt (the receipts linked already counted too) of what is due is linked, if it is the only
 * one within that reach; it is said so in the match step's log. Two such sets, or one beside an
 * exact one, are proposals.
 *
 * A batch payer (`grouped: true` in its business's file, src/intake/batch-payers.ts) pays its open
 * receipts together: for its payments code also tries runs in date order, the oldest open receipt
 * first, adding one at a time (2c). A run may be longer than the free combinations (MAX_RUN), and,
 * where the bank names no original amount, it may meet the payment at the official daily rate
 * within BAND, never above it, and only when the next longer run does not meet it too. A run
 * competes with the free combinations: when any other set fits as well, every one is a proposal.
 * The receipts of a batch payer form one vendor, by its business, whatever VAT number or title each shows.
 */
import { madeByHand } from '../workspace/money-accounts.js';
import type { BankTransaction, Index, Mapping, Receipt } from '../types/index.js';
import { baseCurrency, documents } from '../engines/index.js';
import { creditSigned } from '../accounting/credit-signed.js';
import { duplicatesIn } from './duplicates.js';
import { chargesOf, type Charge, type Charges } from './charges.js';
import { NO_BATCH_PAYERS, type BatchPayers } from './batch-payers.js';
import type { ToChf } from './pairing.js';

/** At most this many receipts of one vendor are tried for one payment, nearest first: every subset of them (4096 at most). A vendor with more near the payment is only proposed, never linked, since a set among the others could fit as well. */
export const MAX_TRIED = 12;
/** A batch payer's run takes at most this many of its open receipts, oldest first; with more open, its runs are only proposed, and the person is told. */
export const MAX_RUN = 40;
/** A receipt dated up to this many days before the payment, or after it, is near it. */
const DAYS_BEFORE = 31;
const DAYS_AFTER = 7;
/** A batch payer's open receipts are looked for this many days before its payment. */
const RUN_DAYS_BEFORE = 92;
/** A batch payer's run without an original amount meets the payment at the official daily rate within this share below it (a bank's rate is not the official one), never above. */
export const BAND = 0.015;
/** A set that is the only fit may differ from what is due by this many centimes per receipt: each order rounded on its own. */
export const ROUNDING = 1;
/** A proposal's sum lies within this share of what is left to pay, or a franc, from it. */
const CLOSE = 0.02;
const DAY = 864e5;

/**
 * Receipts for one payment, linked by code or proposed. `payment` is the charge's first movement,
 * `legs` every movement the set is linked to (more than one for a charge split across balances).
 * `sum` and `paid` in `currency`, money out positive; `sum` counts the receipts linked already.
 * `basis`: what the sum was compared with, the payment's own amount, the original amount its bank
 * names, or (a batch payer's run) the payment at the official daily rate. `exact`: it adds up (at
 * the rate: within BAND). `rounding`: it is within ROUNDING of it, not exact. `run`: a batch payer's
 * run in date order.
 */
export interface ReceiptSet { payment: string; legs: string[]; receipts: string[]; sum: number; paid: number; currency: string; basis: Due['basis']; exact: boolean; rounding?: true; run?: true }

/** Where code stopped looking for one payment, while a set of its own vendor was held back by it: of `near` receipts near it, it tried the `tried` nearest (MAX_TRIED), or a batch payer's `tried` oldest open ones (MAX_RUN). */
export interface SetCut { near: number; tried: number; limit: 'combinations' | 'run' }

/** What the set search needs beside the books: which days are open, and, in the match step, the batch payers and the official daily rates (without them no card charge counts as split across balances). */
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
const dayOf = (date: string) => Date.parse(date) / DAY;

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

/** The sum and size of every subset of `items` (MAX_TRIED at most), by its bit mask over them: each from a smaller subset's, nothing built until one is taken (setOf). */
function subsetSums(items: readonly Receipt[]): { sums: Float64Array; sizes: Uint8Array } {
  const owed = items.map(owedCents);
  const sums = new Float64Array(1 << items.length);
  const sizes = new Uint8Array(1 << items.length);
  for (let mask = 1; mask < sums.length; mask++) {
    const low = mask & -mask;
    const rest = mask ^ low;
    sums[mask] = sums[rest] + owed[31 - Math.clz32(low)];
    sizes[mask] = sizes[rest] + 1;
  }
  return { sums, sizes };
}

const setOf = (items: readonly Receipt[], mask: number): Receipt[] => items.filter((_, i) => mask & (1 << i));

/** Of receipts that are one document twice (duplicatesIn), the copies. The one linked, else the earlier, stays. */
function copiesAmong(receipts: readonly Receipt[], linked: ReadonlySet<string>): Set<string> {
  if (receipts.length < 2) return new Set();
  return new Set([...duplicatesIn(receipts, linked, documents())].filter(([, t]) => t.relation === 'duplicate').map(([id]) => id));
}

/** What the set search reads once per state of the books: the charges, the receipts that may join a set, and each receipt's vendor. */
interface SetContext {
  charges: Charges;
  /** Archived invoices with an amount, a date and a vendor that no payment holds, of any date (fitOf asks which are open), by their day. */
  free: Array<{ r: Receipt; day: number }>;
  /** Whether a free receipt repeats another free one or one a payment holds, among its vendor's invoices (2e): it joins no set. Found once per vendor, when first asked. */
  isCopy: (r: Receipt) => boolean;
  byId: Map<string, Receipt>;
  /** The links of each movement, by its ref. */
  linksOf: Map<string, Mapping[]>;
  /** A receipt's vendor key: a batch payer's business (`@id`), else vendorOf. */
  keyOf: (r: Receipt) => string | undefined;
}

/** The first of `items` (by day) on or after `day`. */
function firstFrom(items: ReadonlyArray<{ day: number }>, day: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].day < day) lo = mid + 1; else hi = mid; }
  return lo;
}

function contextOf(books: Books, payers: BatchPayers, toChf: ToChf | undefined): SetContext {
  const keys = new Map<string, string | undefined>();
  const keyOf = (r: Receipt) => {
    if (!keys.has(r.id)) { const business = payers.ofReceipt(r); keys.set(r.id, business ? `@${business}` : vendorOf(r)); }
    return keys.get(r.id);
  };
  const held = new Set(books.mappings.map((m) => m.receiptId));
  const invoices = books.receipts.filter((r) => r.location === 'archived' && (!r.kind || r.kind === 'invoice') && !!r.amount && !!r.date
    && !r.filedPayment && !r.payout && !r.order && !!keyOf(r));
  // Copies within a vendor, over the receipts payments hold and the free ones together: a free copy of either is dropped (2e).
  const byVendor = new Map<string, Receipt[]>();
  for (const r of invoices) { const k = keyOf(r)!; const group = byVendor.get(k); if (group) group.push(r); else byVendor.set(k, [r]); }
  const copies = new Map<string, Set<string>>();
  const isCopy = (r: Receipt) => {
    const k = keyOf(r)!;
    if (!copies.has(k)) copies.set(k, copiesAmong(byVendor.get(k) ?? [], held));
    return copies.get(k)!.has(r.id);
  };
  const linksOf = new Map<string, Mapping[]>();
  for (const m of books.mappings) { const links = linksOf.get(m.transactionRef); if (links) links.push(m); else linksOf.set(m.transactionRef, [m]); }
  return {
    charges: chargesOf(books.transactions, toChf),
    free: invoices.filter((r) => !held.has(r.id)).map((r) => ({ r, day: dayOf(r.date!) })).sort((a, b) => a.day - b.day),
    isCopy,
    byId: new Map(books.receipts.map((r) => [r.id, r])),
    linksOf,
    keyOf,
  };
}

/**
 * A set found for a charge. `off`: its sum less what was due, in centimes. `exact`: it adds up (a
 * batch payer's run at the rate: within BAND below); else it is within ROUNDING of it. `partial`:
 * found among only some of a vendor's receipts (the nearest MAX_TRIED of a batch payer's, its
 * oldest MAX_RUN open ones): a set among the others may fit too, so code does not link it.
 */
interface Candidate { set: Receipt[]; sum: number; off: number; due: Due; linkedCents: number; run: boolean; exact: boolean; partial?: true }

/**
 * What fits one charge: the sets that add up or round to it, and the closest set that does not
 * quite. `untried`: the receipts of a vendor (no batch payer) that had more near the payment than
 * were tried; a set among them may fit it too. `cut`: where code stopped looking while a set of the
 * payment's own vendor (its linked receipts', its batch payer's) was held back, for the person.
 */
export interface Fit { charge: Charge; found: Candidate[]; close?: Candidate; untried: Set<string>; cut?: SetCut }

const alone = (set: readonly Receipt[]) => set.map((r) => r.id).sort().join(' ');
/** How far from what is due a set of `n` receipts may round. */
const reach = (n: number) => n * ROUNDING;

/**
 * The sets of free receipts that pay charge `charge` together with the receipts linked to it
 * already: from one vendor (the linked receipts' too), in the currency of what it is compared with
 * (duesOf), near its date. None for a charge of a filed period, a movement made by hand (from its
 * receipt), or one whose linked receipts are in no such currency or owe it all.
 */
function fitOf(books: Books, ctx: SetContext, charge: Charge, search: SetSearch): Fit | undefined {
  const { isOpen, payers = NO_BATCH_PAYERS, toChf } = search;
  const { keyOf } = ctx;
  const [first] = charge.legs;
  if (charge.legs.some((t) => t.amount === 0 || t.type === 'wise-fee' || madeByHand(t) || !isOpen(t.date))) return undefined;
  const held = charge.refs.flatMap((ref) => ctx.linksOf.get(ref) ?? []);
  const linkedIds = new Set(held.map((m) => m.receiptId));
  const linkedAll = [...linkedIds].map((id) => ctx.byId.get(id));
  if (linkedAll.some((r) => !r || r.amount === undefined)) return undefined;
  // A person's links are the person's set: code takes none of them for a copy of another.
  const byPerson = held.some((m) => m.by === 'human');
  const linkedCopies = byPerson ? new Set<string>() : copiesAmong(linkedAll as Receipt[], linkedIds);
  const linked = (linkedAll as Receipt[]).filter((r) => !linkedCopies.has(r.id));
  const batch = charge.legs.map((t) => payers.ofPayment(t, linked)).find(Boolean);
  const own = new Set(linked.map(keyOf));
  if (batch) own.add(`@${batch}`);
  // The free receipts in reach of its day: RUN_DAYS_BEFORE before it to DAYS_AFTER after.
  const day = dayOf(first.date);
  const days = new Map<string, number>();
  for (let i = firstFrom(ctx.free, day - RUN_DAYS_BEFORE); i < ctx.free.length && ctx.free[i].day <= day + DAYS_AFTER; i++) {
    const { r, day: d } = ctx.free[i];
    if (isOpen(r.date!) && !linkedIds.has(r.id) && !ctx.isCopy(r)) days.set(r.id, day - d);
  }
  const free = [...days.keys()].map((id) => ctx.byId.get(id)!);
  const daysFrom = (r: Receipt) => days.get(r.id)!;
  const fit: Fit = { charge, found: [], untried: new Set() };
  for (const due of duesOf(charge, toChf)) {
    if (linked.some((r) => currencyOf(r) !== due.currency)) continue;
    const linkedCents = linked.reduce((s, r) => s + owedCents(r), 0);
    const need = due.cents - linkedCents;
    if (need === 0 || Math.sign(need) !== Math.sign(due.cents)) continue;
    const vendors = new Map<string, Receipt[]>();
    for (const r of free) {
      if (currencyOf(r) !== due.currency) continue;
      const v = keyOf(r)!;
      if (linked.some((l) => keyOf(l) !== v)) continue;
      const group = vendors.get(v);
      if (group) group.push(r); else vendors.set(v, [r]);
    }
    const tolerance = Math.max(CLOSE * Math.abs(need), 100);
    const take = (set: Receipt[], sum: number, run: boolean, exact: boolean, partial: boolean): Candidate => ({ set, sum, off: sum - need, due, linkedCents, run, exact, ...(partial ? { partial: true as const } : {}) });
    // On its own a set is two receipts at least; one receipt that completes those linked already is a set too.
    const min = linked.length ? 1 : 2;
    for (const [key, group] of vendors) {
      const mine = own.has(key);
      const flagged = !!batch && key === `@${batch}`;
      if (due.basis !== 'rate') {
        const near = group.filter((r) => daysFrom(r) <= DAYS_BEFORE);
        const tried = [...near].sort((a, b) => Math.abs(daysFrom(a)) - Math.abs(daysFrom(b))).slice(0, MAX_TRIED);
        const over = near.length > MAX_TRIED;
        // A batch payer's runs try its receipts in their order instead: a set among the others holds back only the free combinations (Candidate.partial).
        if (over && !flagged) for (const r of near) fit.untried.add(r.id);
        let back = false;
        const { sums, sizes } = subsetSums(tried);
        for (let mask = 1; mask < sums.length; mask++) {
          const size = sizes[mask];
          if (size < min) continue;
          const sum = sums[mask];
          const off = Math.abs(sum - need);
          if (off <= reach(size + linked.length)) { fit.found.push(take(setOf(tried, mask), sum, false, off === 0, over)); back ||= over; }
          else if (off <= tolerance && size + linked.length >= 2 && (!fit.close || off < Math.abs(fit.close.off))) fit.close = take(setOf(tried, mask), sum, false, false, false);
        }
        if (back && mine) fit.cut ??= { near: near.length, tried: MAX_TRIED, limit: 'combinations' };
      }
      if (!flagged) continue;
      // A batch payer's open receipts in date order, the oldest first (2c).
      const open = [...group].sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id));
      const over = open.length > MAX_RUN;
      const way = Math.sign(need);
      const band = Math.floor(Math.abs(due.cents) * BAND);
      // At the rate: within the band below what is due, never above it.
      const inBand = (sum: number) => { const under = way * (need - sum); return under >= 0 && under <= band; };
      const sums: number[] = [];
      for (let i = 0, s = 0; i < Math.min(open.length, MAX_RUN); i++) sums.push((s += owedCents(open[i])));
      let back = false;
      for (let i = min - 1; i < Math.min(open.length, MAX_RUN); i++) {
        const sum = sums[i];
        const set = open.slice(0, i + 1);
        let exact: boolean;
        if (due.basis === 'rate') {
          // Every run in the band competes: when the next longer run meets the payment too, neither is the one.
          if (!inBand(sum)) continue;
          exact = true;
        } else {
          const off = Math.abs(sum - need);
          if (off > reach(set.length + linked.length)) continue;
          exact = off === 0;
        }
        back ||= over;
        // A free combination that is also a run was tried in full after all, when the run took every open receipt.
        const same = fit.found.find((c) => alone(c.set) === alone(set));
        if (same) { same.run = true; same.exact ||= exact; if (!over) delete same.partial; } else fit.found.push(take(set, sum, true, exact, over));
      }
      if (back && mine) fit.cut ??= { near: open.length, tried: MAX_RUN, limit: 'run' };
    }
  }
  return fit.found.length || fit.close || fit.untried.size || fit.cut ? fit : undefined;
}

/** The sets of a fit that compete for its link: the exact ones; only when there is none, those within ROUNDING. */
const contenders = (fit: Fit): Candidate[] => { const exact = fit.found.filter((c) => c.exact); return exact.length ? exact : fit.found; };

const asSet = (c: Candidate, charge: Charge): ReceiptSet => ({
  payment: charge.refs[0], legs: charge.refs, receipts: c.set.map((r) => r.id).sort(), sum: (c.linkedCents + c.sum) / 100, paid: c.due.cents / 100,
  currency: c.due.currency, basis: c.due.basis, exact: c.exact, ...(!c.exact && c.off !== 0 && c.due.basis !== 'rate' ? { rounding: true as const } : {}), ...(c.run ? { run: true as const } : {}),
});

const searchOf = (s: SetSearch | ((date: string) => boolean)): SetSearch => (typeof s === 'function' ? { isOpen: s } : s);

/** The context of the books as they are, kept while they stay the same object with the same lists (the UI's books, a bench's): proposals for one payment after another read it once. */
const contexts = new WeakMap<object, { lists: unknown[]; payers: BatchPayers; toChf?: ToChf; ctx: SetContext }>();
function contextFor(books: Books, payers: BatchPayers, toChf: ToChf | undefined): SetContext {
  const lists = [books.receipts, books.receipts.length, books.mappings, books.mappings.length, books.transactions, books.transactions.length];
  const kept = contexts.get(books);
  if (kept && kept.payers === payers && kept.toChf === toChf && kept.lists.every((x, i) => x === lists[i])) return kept.ctx;
  const ctx = contextOf(books, payers, toChf);
  contexts.set(books, { lists, payers, toChf, ctx });
  return ctx;
}

/** What code offers for one payment, for its line in Kontoauszüge: every set that fits it, exact ones first, and where code stopped looking (named to the person). */
export function proposalsFor(books: Books, tx: BankTransaction, search: SetSearch | ((date: string) => boolean)): { sets: ReceiptSet[]; cut?: SetCut } {
  const s = searchOf(search);
  const ctx = contextFor(books, s.payers ?? NO_BATCH_PAYERS, s.toChf);
  const fit = fitOf(books, ctx, ctx.charges.of(tx), s);
  if (!fit) return { sets: [] };
  const ranked = [...fit.found.filter((c) => c.exact), ...fit.found.filter((c) => !c.exact), ...(fit.close ? [fit.close] : [])];
  return { sets: ranked.map((c) => asSet(c, fit.charge)), ...(fit.cut ? { cut: fit.cut } : {}) };
}

/**
 * What code links: a charge's set when it is its only set that adds up (or, with none that does,
 * its only set within ROUNDING), whether a free combination or a batch payer's run; every receipt
 * near it was tried (a batch payer's in its runs), and none of its receipts competes for another
 * charge or lies among the receipts another charge could not try every set of. A set with a receipt
 * a person took apart from one of the charge's movements (Receipt.notPaidBy) is never linked. Every
 * other fit stays a proposal (proposalsFor).
 */
export function receiptSetsToLink(books: Books, search: SetSearch | ((date: string) => boolean)): { sets: ReceiptSet[]; cuts: SetCut[] } {
  const s = searchOf(search);
  const ctx = contextOf(books, s.payers ?? NO_BATCH_PAYERS, s.toChf);
  const seen = new Set<string>();
  const all: Fit[] = [];
  for (const tx of books.transactions) {
    const charge = ctx.charges.of(tx);
    if (seen.has(charge.refs[0])) continue;
    seen.add(charge.refs[0]);
    const fit = fitOf(books, ctx, charge, s);
    if (fit) all.push(fit);
  }
  // A receipt a charge could not try every set of may belong to that charge: no set takes it by code.
  const untried = new Set(all.flatMap((fit) => [...fit.untried]));
  const fits = all.flatMap((fit) => { const pick = contenders(fit); return pick.length ? [{ fit, pick }] : []; });
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
 * original amount to the centime (a copy counted once, unless a person linked both), they are
 * linked to every leg of it that is open and holds none, unless a person took one of them apart
 * from that leg. `toChf`: the official daily rates, which tell the legs of one charge (chargesOf).
 * Returns what it linked.
 */
export function linkSplitLegs(books: Books & { mappings: Mapping[] }, isOpen: (date: string) => boolean, toChf: ToChf): Array<{ legs: string[]; receipts: string[] }> {
  const done: Array<{ legs: string[]; receipts: string[] }> = [];
  for (const charge of chargesOf(books.transactions, toChf).splits) {
    const o = charge.original!;
    const holding = (ref: string) => books.mappings.filter((m) => m.transactionRef === ref);
    const waiting = charge.legs.filter((t) => !holding(t.ref).length && isOpen(t.date) && !t.noReceiptNeeded);
    if (!waiting.length || waiting.length === charge.legs.length) continue;
    const held = charge.refs.flatMap(holding);
    const ids = new Set(held.map((m) => m.receiptId));
    const receipts = [...ids].map((id) => books.receipts.find((r) => r.id === id));
    if (receipts.some((r) => !r || r.amount === undefined || currencyOf(r) !== o.currency)) continue;
    const copies = held.some((m) => m.by === 'human') ? new Set<string>() : copiesAmong(receipts as Receipt[], ids);
    const own = (receipts as Receipt[]).filter((r) => !copies.has(r.id));
    if (own.reduce((s, r) => s + owedCents(r), 0) !== sign(charge.legs[0]) * cents(o.amount)) continue;
    const legs = waiting.filter((t) => !own.some((r) => r.notPaidBy?.includes(t.ref))).map((t) => t.ref);
    if (!legs.length) continue;
    for (const transactionRef of legs) for (const r of own) books.mappings.push({ transactionRef, receiptId: r.id, by: 'rule', rule: 'split-charge' });
    done.push({ legs, receipts: own.map((r) => r.id) });
  }
  return done;
}
