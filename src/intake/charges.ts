/**
 * One card charge as the bank moved it (#190 2b). Mostly one movement; but a card on a
 * multi-currency account (Wise) takes a charge from several balances when the first does not
 * cover it: one leg per balance, each on its own statement with its own ref, each naming the whole
 * charge in the currency it was made in («Card transaction of 156.86 USD issued by …»). For
 * matching such legs are one unit: a receipt (or a set) pays the charge, and is linked to every
 * leg, as a person links them. Each leg is then booked on its own: its share, in its currency.
 *
 * Legs are one charge when the bank says so (one ref), or when everything about them is the same
 * but the balance: the day, the money's way, the original amount and its currency, and the
 * merchant, each balance once, no two bank ids, and their amounts, each at the official daily rate
 * of the day, add up to the original amount within SPLIT_BAND. A leg may be almost all of it (a
 * balance that held 1.50 EUR). Two whole charges of one amount at one shop on one day from two
 * balances add up to twice the amount: two charges, never one. Without the daily rates nothing is merged. Anything less
 * certain stays a movement of its own. Pure and browser-safe.
 */
import type { BankTransaction } from '../types/index.js';
import { merchantOf } from '../knowledge/counterparties.js';
import { madeByHand } from '../workspace/money-accounts.js';
import { originalOf, type ToChf } from './pairing.js';
import { isBankFee } from '../booking/separate-fee.js';

/** The legs of a split charge, each at the official daily rate, add up to its original amount within this share (a bank's rate is not the official one). */
export const SPLIT_BAND = 0.03;

export interface Charge {
  /** Its movements, by ref: one, or the legs of a charge split across balances. A shared ref is listed once. */
  refs: string[];
  legs: BankTransaction[];
  /** What the charge came to where it was made, as every leg names it (originalOf); for a single movement without one, none. */
  original?: { amount: number; currency: string };
}

export interface Charges {
  /** The charge a movement is a leg of (itself alone, when it is no leg of a split). */
  of(tx: BankTransaction): Charge;
  /** Every charge of more than one ref: the splits across balances. */
  splits: Charge[];
}

const cents = (n: number) => Math.round(Math.abs(n) * 100);
const merchant = (tx: BankTransaction) => (tx.counterparty?.trim() || merchantOf(tx.description)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Whether movements of different refs are the legs of one charge, by everything but the balance (see the module's comment). */
function oneCharge(legs: readonly BankTransaction[], toChf: ToChf): boolean {
  const original = originalOf(legs[0])!;
  const currencies = new Set(legs.map((t) => t.currency));
  if (currencies.size !== legs.length || currencies.size < 2) return false;
  // A leg in the charge's own currency took a part of it, never all: the whole charge from one balance is a charge of its own.
  if (legs.some((t) => t.currency === original.currency && cents(t.amount) >= cents(original.amount))) return false;
  // Two different bank ids are two charges, whatever else they share.
  const ids = new Set(legs.flatMap((t) => (t.bankTxId ? [t.bankTxId] : [])));
  if (ids.size > 1) return false;
  // Parts of one amount: together the original, each alone clearly less (two whole charges come to twice it, each to all of it).
  const whole = toChf(original.amount, original.currency, legs[0].date);
  const parts = legs.map((t) => toChf(Math.abs(t.amount), t.currency, t.date));
  if (whole === undefined || !whole || parts.some((p) => p === undefined)) return false;
  const sum = (parts as number[]).reduce((s, p) => s + p, 0);
  return Math.abs(sum - whole) <= whole * SPLIT_BAND;
}

const splittable = (t: BankTransaction) => t.amount !== 0 && !isBankFee(t) && !madeByHand(t);

/** The charges of `transactions`. `toChf`: the official daily rates; without them only a ref the bank shares makes legs one charge. */
export function chargesOf(transactions: readonly BankTransaction[], toChf?: ToChf): Charges {
  const byRef = new Map<string, BankTransaction[]>();
  for (const t of transactions) byRef.set(t.ref, [...(byRef.get(t.ref) ?? []), t]);
  // The candidates for a split: one movement per ref (a ref the bank shares is a split already), with an original amount.
  const buckets = new Map<string, BankTransaction[]>();
  for (const [, legs] of byRef) {
    const t = legs[0];
    const original = legs.length === 1 && splittable(t) ? originalOf(t) : undefined;
    const name = original && merchant(t);
    if (!original || !name) continue;
    const key = [t.date, t.direction, cents(original.amount), original.currency, name].join('|');
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }
  const charge = new Map<string, Charge>();
  const splits: Charge[] = [];
  for (const legs of buckets.values()) {
    if (!toChf || legs.length < 2 || !oneCharge(legs, toChf)) continue;
    const sorted = [...legs].sort((a, b) => a.ref.localeCompare(b.ref));
    const c: Charge = { refs: sorted.map((t) => t.ref), legs: sorted, original: originalOf(sorted[0]) };
    splits.push(c);
    for (const t of sorted) charge.set(t.ref, c);
  }
  return {
    of(tx) {
      const split = charge.get(tx.ref);
      if (split) return split;
      const legs = byRef.get(tx.ref) ?? [tx];
      const original = originalOf(legs[0]);
      return { refs: [tx.ref], legs, ...(original ? { original } : {}) };
    },
    splits,
  };
}

/** Whether two movements are one leg: one ref and one balance (the legs of a split under one ref differ by currency). */
export const sameLeg = (a: Pick<BankTransaction, 'ref' | 'currency'>, b: Pick<BankTransaction, 'ref' | 'currency'>): boolean => a.ref === b.ref && a.currency === b.currency;

/** What a leg is called in the model's prompt and answer: its ref, or with legs that share it its currency too (`CARD-1@USD`, #287). */
export const legKey = (tx: Pick<BankTransaction, 'ref' | 'currency'>, legs: readonly Pick<BankTransaction, 'ref'>[]): string =>
  legs.filter((t) => t.ref === tx.ref).length > 1 ? `${tx.ref}@${tx.currency}` : tx.ref;
