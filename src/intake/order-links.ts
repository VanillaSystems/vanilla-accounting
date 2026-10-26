/**
 * Order documents linked to the payout they went into, in code (issue #26). An order document
 * names its payouts by date and amount (Receipt.order); the documents naming the same payout add
 * up to what the bank received, less the refunds deducted from it. A payment in the open period
 * that is the one money-in of that sum and currency within PAYOUT_DAYS of the named date gets
 * every one of those documents linked; anything less certain links nothing, so a payout never
 * holds orders worth more or less than it paid. A payout a person took an order apart from is left to her.
 */
import type { Books } from '../books/store.js';
import { periodLock } from '../books/store.js';
import { toRappen } from '../accounting/rappen.js';
import { onPayout } from '../booking/payout-orders.js';

/** The rule a link by code names (Mapping.rule). */
export const ORDER_LINK_RULE = 'payout-orders';

export function linkOrdersToPayouts(index: Books): Array<{ receipt: string; payment: string }> {
  const lock = periodLock(index);
  const named = new Map<string, { date: string; currency: string; rappen: number; receipts: Set<string> }>();
  for (const r of index.receipts) {
    if (!r.order || r.kind === 'duplicate') continue;
    const shares = [...r.order.payouts.map((s) => ({ ...s, sign: 1 })), ...r.order.refunds.map((s) => ({ ...s, sign: -1 }))];
    for (const s of shares) {
      const key = `${s.date}|${r.order.currency}`;
      const payout = named.get(key) ?? named.set(key, { date: s.date, currency: r.order.currency, rappen: 0, receipts: new Set() }).get(key)!;
      payout.rappen += s.sign * toRappen(s.amount);
      payout.receipts.add(r.id);
    }
  }
  const made: Array<{ receipt: string; payment: string }> = [];
  for (const payout of named.values()) {
    const fits = index.transactions.filter((t) => t.direction === 'CRDT' && t.currency === payout.currency && toRappen(t.amount) === payout.rappen
      && onPayout(payout, t.date) && t.type !== 'wise-fee');
    if (fits.length !== 1 || lock.isClosed(fits[0].date)) continue;
    const [tx] = fits;
    // A person took one of these orders apart from the payout (Receipt.notPaidBy): the payout is hers, none is linked again.
    if (index.receipts.some((r) => payout.receipts.has(r.id) && r.notPaidBy?.includes(tx.ref))) continue;
    for (const receipt of payout.receipts) {
      if (index.mappings.some((m) => m.transactionRef === tx.ref && m.receiptId === receipt)) continue;
      index.mappings.push({ transactionRef: tx.ref, receiptId: receipt, by: 'rule', rule: ORDER_LINK_RULE });
      made.push({ receipt, payment: tx.ref });
    }
  }
  return made;
}
