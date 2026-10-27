/**
 * One card charge as the bank moved it (#190 2b). Mostly one movement; but a card on a
 * multi-currency account (Wise) takes a charge from several balances when the first does not
 * cover it: one leg per balance, each on its own statement with its own ref, each naming the whole
 * charge in the currency it was made in («Card transaction of 156.86 USD issued by …»). For
 * matching such legs are one unit: a receipt (or a set) pays the charge, and is linked to every
 * leg, as a person links them. Each leg is then booked on its own: its share, in its currency.
 *
 * Legs are one charge when the bank says so (one ref, or one bank id across balances), or when
 * everything about them is the same but the balance: the day, the money's way, the original amount
 * and its currency, and the merchant, each balance once, and no leg in the charge's own currency
 * that already paid all of it. Anything less certain stays a movement of its own. Pure and
 * browser-safe.
 */
import type { BankTransaction } from '../types/index.js';
import { merchantOf } from '../knowledge/counterparties.js';
import { madeByHand } from '../workspace/money-accounts.js';
import { originalOf } from './pairing.js';

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
function oneCharge(legs: readonly BankTransaction[]): boolean {
  const original = originalOf(legs[0])!;
  const currencies = new Set(legs.map((t) => t.currency));
  if (currencies.size !== legs.length || currencies.size < 2) return false;
  // A leg in the charge's own currency took a part of it, never all: the whole charge from one balance is a charge of its own.
  if (legs.some((t) => t.currency === original.currency && cents(t.amount) >= cents(original.amount))) return false;
  // Two different bank ids are two charges, whatever else they share.
  const ids = new Set(legs.flatMap((t) => (t.bankTxId ? [t.bankTxId] : [])));
  return ids.size <= 1;
}

const splittable = (t: BankTransaction) => t.amount !== 0 && t.type !== 'wise-fee' && !madeByHand(t);

export function chargesOf(transactions: readonly BankTransaction[]): Charges {
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
    if (legs.length < 2 || !oneCharge(legs)) continue;
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
