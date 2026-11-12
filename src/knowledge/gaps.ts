/**
 * Where the knowledge base is still thin: the transactions that route to no supplier, customer
 * or authority file, grouped by the merchant text of the bank line. Such a transaction is booked
 * by the generic rules alone; a file for its counterparty is what makes the next quarter right.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from './counterparties.js';
import { isBankFee } from '../booking/separate-fee.js';

export interface Gap {
  /** The merchant text, lowercased, without what changes per payment: digits (card numbers, order ids), month names, punctuation. */
  merchant: string;
  count: number;
  /** One bank ref of the group, to find it in the books. */
  example: string;
}

const MONTHS = /\b(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december)\b/g;

/**
 * The words of a payment's text that stay the same from one payment of its kind to the next (#344):
 * without the month names and the words that carry digits (a year, an invoice or card number), the
 * last run of what is left («Lohn Juli 2026» → «Lohn», «Karte 5412 Tanken» → «Tanken»). A rule
 * drafted from one payment starts with them, so it holds for the others too. Empty: nothing stays.
 */
export function stableWords(text: string): string {
  const runs: string[][] = [[]];
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word || /\d/.test(word) || new RegExp(`^${MONTHS.source}$`, 'i').test(word)) { if (runs.at(-1)!.length) runs.push([]); continue; }
    runs.at(-1)!.push(word);
  }
  return runs.filter((r) => r.length).at(-1)?.join(' ') ?? '';
}

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
    if (isBankFee(tx)) continue;
    if (identify(signalsOfTransaction(tx, linked(tx.ref)), counterparties).kind !== 'unknown') continue;
    const merchant = groupKey(merchantOf(tx.description)) || '(no text)';
    const gap = gaps.get(merchant);
    if (gap) gap.count++;
    else gaps.set(merchant, { merchant, count: 1, example: tx.ref });
  }
  return [...gaps.values()].sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant));
}
