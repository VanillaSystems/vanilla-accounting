/**
 * A refund inverts the code of the purchase it refunds (AGENTS.md § VAT code rules, #288): money
 * back from a merchant onto the account and for the amount of a booked purchase of that merchant
 * takes that purchase's code with the minus, so the input tax claimed on it goes back at its rate,
 * whatever the refund's own document shows. A refund of another amount (a goodwill, a part) keeps
 * the code it has: which line it refunds, the person says.
 */
import { codeOnAccount } from '../accounting/vat-codes.js';
import { merchantName } from '../knowledge/learned-names.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';

export interface RefundCode {
  /** The purchase's code with the minus, in the family of the refund's account: -I81, -M81. */
  code: string;
  /** The purchase's own code, as it was booked. */
  originalCode: string;
  /** The purchase's payment. */
  original: Pick<BankTransaction, 'ref' | 'date'>;
}

type Booked = { transactions: readonly BankTransaction[]; journalEntries: readonly JournalEntry[] };

const PURCHASE = /^[MI]\d+$/;

/**
 * The code of `e`, a line of the money-in payment `tx` from `bank` onto an expense or asset account
 * with a purchase code or none, when exactly one code was booked on that account for that amount on
 * earlier payments out of the same merchant (merchantName) in the same currency. Undefined otherwise.
 */
export function refundCodeOf(e: Pick<JournalEntry, 'vatCode' | 'accountDebit' | 'accountCredit' | 'amount'>, tx: BankTransaction, bank: string, books: Booked): RefundCode | undefined {
  if (tx.direction !== 'CRDT' || e.accountDebit !== bank || (e.vatCode && !/^-?[MI]\d+$/.test(e.vatCode))) return undefined;
  const merchant = merchantName(tx)?.toLowerCase();
  if (!merchant) return undefined;
  const payments = new Map(books.transactions
    .filter((t) => t.direction === 'DBIT' && t.currency === tx.currency && t.date <= tx.date && merchantName(t)?.toLowerCase() === merchant)
    .map((t) => [t.ref, t]));
  const lines = books.journalEntries.filter((j) => payments.has(j.transactionRef) && j.accountDebit === e.accountCredit && j.amount === e.amount && PURCHASE.test(j.vatCode ?? ''));
  const codes = new Set(lines.map((j) => j.vatCode!));
  if (codes.size !== 1) return undefined;
  const [originalCode] = codes;
  const code = codeOnAccount(`-${originalCode}`, e.accountDebit, e.accountCredit);
  if (!code) return undefined;
  const { ref, date } = payments.get(lines[lines.length - 1].transactionRef)!;
  return { code, originalCode, original: { ref, date } };
}
