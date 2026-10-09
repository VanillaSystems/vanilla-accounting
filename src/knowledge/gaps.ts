/**
 * Where the knowledge base is still thin: the transactions that route to no supplier, customer
 * or authority file, grouped by the merchant text of the bank line. Such a transaction is booked
 * by the generic rules alone; a file for its counterparty is what makes the next quarter right.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from './counterparties.js';

export interface Gap {
  /** The merchant text, lowercased, without what changes per payment: digits (card numbers, order ids), month names, punctuation. */
  merchant: string;
  count: number;
  /** One bank ref of the group, to find it in the books. */
  example: string;
}

const MONTHS = /\b(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december)\b/g;

const groupKey = (merchant: string) =>
  merchant.toLowerCase().replace(MONTHS, ' ').replace(/[\d*#,.:;/()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/** The unrouted transactions among `txs`, most frequent merchant first. Wise fee rows never count. */
export function knowledgeGaps(
  txs: readonly BankTransaction[],
  books: { mappings: readonly Mapping[]; receipts: readonly Receipt[] },
  counterparties: readonly Counterparty[],
): Gap[] {
  const receipts = new Map(books.receipts.map((r) => [r.id, r]));
  const linked = (ref: string) => books.mappings.filter((m) => m.transactionRef === ref).flatMap((m) => receipts.get(m.receiptId) ?? []);
  const gaps = new Map<string, Gap>();
  for (const tx of txs) {
    if (tx.type === 'wise-fee') continue;
    if (identify(signalsOfTransaction(tx, linked(tx.ref)), counterparties).kind !== 'unknown') continue;
    const merchant = groupKey(merchantOf(tx.description)) || '(no text)';
    const gap = gaps.get(merchant);
    if (gap) gap.count++;
    else gaps.set(merchant, { merchant, count: 1, example: tx.ref });
  }
  return [...gaps.values()].sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant));
}
