/**
 * A supplier's typical delay between its receipt and its payment (#190 part 3), from the books' own
 * links: a subscription is paid on the receipt's day, a courier's invoice weeks later. The pair
 * search counts a payment's day from that delay instead of from the receipt's day, and reaches as
 * far past the fixed window as the delay needs (src/intake/pairing.ts). Derived from the books on
 * every search, never stored. Pure and browser-safe.
 *
 * A supplier is the business a receipt is of by its file, else the vendor its title names. Its
 * delay counts once DELAY.after of its receipts are linked to a payment and the middle half of their
 * delays lies within DELAY.spread days: a pattern, not a scatter.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import type { Businesses } from './batch-payers.js';

export const DELAY = {
  /** Linked receipts of a supplier before its delay counts. */
  after: 3,
  /** The middle half of its delays lies within this many days. */
  spread: 7,
  /** How far past its typical delay a payment is still a candidate, when that reaches beyond the fixed window. */
  reach: 14,
} as const;

/** A receipt's supplier's typical delay in days (its payment's day minus its own), or undefined while the books show no pattern. */
export type Delays = (r: Receipt) => number | undefined;

export const NO_DELAYS: Delays = () => undefined;

const DAY = 864e5;

/** The vendor a receipt's title names, as one key («Muster AG» and «MUSTER AG.» are one). */
const vendorKey = (r: Receipt): string | undefined => {
  const words = (r.title?.vendor ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words?.length ? `vendor:${words.join(' ')}` : undefined;
};

type Books = { receipts: readonly Receipt[]; transactions: readonly BankTransaction[]; mappings: readonly Mapping[] };

/** The typical delays the books' links show, per supplier (the business by its file, else the title's vendor). */
export function delaysOf(books: Books, businesses?: Businesses): Delays {
  const supplier = (r: Receipt) => { const b = businesses?.ofReceipt(r); return b ? `business:${b}` : vendorKey(r); };
  const day = new Map(books.transactions.map((t) => [t.ref, Date.parse(t.date)]));
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  // Each receipt once, by its first payment.
  const paid = new Map<string, number>();
  for (const m of books.mappings) {
    const at = day.get(m.transactionRef);
    if (at === undefined || !Number.isFinite(at)) continue;
    paid.set(m.receiptId, Math.min(paid.get(m.receiptId) ?? Infinity, at));
  }
  const bySupplier = new Map<string, number[]>();
  for (const [id, at] of paid) {
    const r = receipt.get(id);
    const from = r?.date ? Date.parse(r.date) : NaN;
    const key = r && supplier(r);
    if (!key || !Number.isFinite(from)) continue;
    const list = bySupplier.get(key) ?? [];
    list.push(Math.round((at - from) / DAY));
    bySupplier.set(key, list);
  }
  const typical = new Map<string, number>();
  for (const [key, list] of bySupplier) {
    if (list.length < DELAY.after) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
    if (q(0.75) - q(0.25) <= DELAY.spread) typical.set(key, q(0.5));
  }
  if (!typical.size) return NO_DELAYS;
  return (r) => { const key = supplier(r); return key ? typical.get(key) : undefined; };
}
