/**
 * A refund inverts the code of the purchase it refunds (AGENTS.md § VAT code rules, #288, #357):
 * money back from a merchant without a credit note of its own takes the code of the purchase it
 * refunds with the minus (I81 → -I81, I0 → -I0), so the input tax claimed on it goes back at its
 * rate (MWSTG Art. 41 Abs. 2). Only a purchase found unambiguously decides it: a booked payment out
 * of the same merchant (merchantName) in the same currency, dated no later, whose line carries a
 * purchase code for at least the refund's amount; the refund's text naming that payment's number
 * (or its receipt's) picks it among several; else the one of the same amount, else the only one
 * that is larger (a part refunded: its share at the same rate). A purchase in a filed quarter is
 * found as any other: the refund is booked on its own date, the filed entry stays as it is.
 */
import { numbersIn } from '../accounting/document-numbers.js';
import { toRappen } from '../accounting/rappen.js';
import { merchantName } from '../knowledge/merchant-name.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';

export interface RefundCode {
  /** The purchase's code with the minus, in the family of the refund's account: -I81, -M81. */
  code: string;
  /** The purchase's own code, as it was booked. */
  originalCode: string;
  /** The account the purchase was booked on, which the refund credits. */
  account: string;
  /** The purchase's payment. */
  original: Pick<BankTransaction, 'ref' | 'date'>;
  /** The purchase's journal entry. */
  entry: string;
}

type Booked = {
  transactions: readonly BankTransaction[];
  journalEntries: readonly JournalEntry[];
  receipts?: readonly Pick<Receipt, 'id' | 'extractedText'>[];
  mappings?: readonly Pick<Mapping, 'transactionRef' | 'receiptId'>[];
};

const PURCHASE = /^[MI]\d+$/;

const textOf = (t: BankTransaction): string => [t.description, t.reference ?? '', t.remarks ?? '', ...(t.parts ?? []).map((p) => p.reference ?? '')].join(' ');

/**
 * The purchase the money-in payment `tx` refunds for `amount` (in the payment's currency) onto
 * `account` (absent: any account a purchase of the merchant was booked on), with the code that
 * takes its input tax back. Undefined when no purchase is found, or more than one could be it.
 */
export function refundedPurchase(tx: BankTransaction, amount: number, books: Booked, account?: string): RefundCode | undefined {
  if (tx.direction !== 'CRDT' || !(amount > 0)) return undefined;
  const merchant = merchantName(tx)?.toLowerCase();
  if (!merchant) return undefined;
  const payments = new Map(books.transactions
    .filter((t) => t.direction === 'DBIT' && t.ref !== tx.ref && t.currency === tx.currency && t.date <= tx.date && merchantName(t)?.toLowerCase() === merchant)
    .map((t) => [t.ref, t]));
  const back = toRappen(amount);
  let lines = books.journalEntries.filter((j) => payments.has(j.transactionRef) && PURCHASE.test(j.vatCode ?? '')
    && (account === undefined || j.accountDebit === account) && toRappen(j.amount) >= back);
  if (!lines.length) return undefined;
  // The refund's text names the purchase: its payment's number, or a number of a receipt linked to it.
  const named = new Set(numbersIn(textOf(tx)));
  if (named.size) {
    const carries = (ref: string): boolean => {
      const linked = new Set((books.mappings ?? []).filter((m) => m.transactionRef === ref).map((m) => m.receiptId));
      const texts = [textOf(payments.get(ref)!), ...(books.receipts ?? []).filter((r) => linked.has(r.id)).map((r) => r.extractedText ?? '')];
      return texts.some((s) => numbersIn(s).some((n) => named.has(n)));
    };
    const refs = new Set(lines.map((j) => j.transactionRef).filter(carries));
    if (refs.size === 1) lines = lines.filter((j) => refs.has(j.transactionRef));
  }
  const same = lines.filter((j) => toRappen(j.amount) === back);
  const pool = same.length ? same : lines;
  const codes = new Set(pool.map((j) => `${j.accountDebit} ${j.vatCode}`));
  // The same amount: one account and code among them (the newest names it); a part: one purchase only.
  if (codes.size !== 1 || (!same.length && pool.length !== 1)) return undefined;
  const hit = [...pool].sort((a, b) => b.date.localeCompare(a.date))[0];
  const { ref, date } = payments.get(hit.transactionRef)!;
  // On the purchase's own account its code exactly, with the minus: the refund takes back what it claimed, in the box it claimed it.
  return { code: `-${hit.vatCode}`, originalCode: hit.vatCode!, account: hit.accountDebit, original: { ref, date }, entry: hit.id };
}

/**
 * The code of `e`, a line of the money-in payment `tx` from `bank` onto an expense or asset account
 * with a purchase code or none, from the purchase on that account it refunds (refundedPurchase).
 * Undefined otherwise.
 */
export function refundCodeOf(e: Pick<JournalEntry, 'vatCode' | 'accountDebit' | 'accountCredit' | 'amount'>, tx: BankTransaction, bank: string, books: Booked): RefundCode | undefined {
  if (tx.direction !== 'CRDT' || e.accountDebit !== bank || (e.vatCode && !/^-?[MI]\d+$/.test(e.vatCode))) return undefined;
  return refundedPurchase(tx, e.amount, books, e.accountCredit);
}
