/**
 * What a statement read by the model (src/intake/statement-read.ts) adds to the payments a bank
 * export of the same account holds already (#243): a bank's camt.053 may drop the payment
 * reference or the amount in the currency a card charge was made in, which its monthly statement
 * prints, and the statement's closing balance closes a month the export does not. Each read line
 * is the export's payment of the same day, direction and amount (heldLines), one for one.
 */
import { heldLines } from './bank-import.js';
import type { BankTransaction } from '../types/index.js';
import type { ReadStatement } from '../types/statement-read.js';

/** The key a payment keeps across rebuilds of the books: the bank's own transaction id, else its ref before the uniqueness suffix. */
export const paymentKey = (t: Pick<BankTransaction, 'ref' | 'bankTxId'>): string => t.bankTxId ?? t.ref.split('~')[0];

export interface ReadFacts {
  /** Payment key → the reference its statement line prints, for payments the export holds without one. */
  references: Map<string, string>;
  /** Payment key → the amount in the other currency its line prints, for payments the export holds without one. */
  originals: Map<string, { amount: number; currency: string }>;
  closing: { date: string; amount: number };
  /** Read lines no payment of the export matches. */
  unmatched: number;
}

export function factsOfRead(s: ReadStatement, account: { bank: string; currency: string }, exported: readonly BankTransaction[]): ReadFacts {
  const held = heldLines(s.movements, exported.filter((t) => t.bank === account.bank && t.currency === account.currency), account);
  const references = new Map<string, string>();
  const originals = new Map<string, { amount: number; currency: string }>();
  for (const [i, t] of held) {
    const line = s.movements[i];
    const reference = line.reference?.trim();
    if (reference && !t.reference) references.set(paymentKey(t), reference);
    if (line.original && line.original.currency !== account.currency && !t.original) originals.set(paymentKey(t), line.original);
  }
  return { references, originals, closing: s.closing, unmatched: s.movements.length - held.size };
}
