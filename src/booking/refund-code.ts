/**
 * A refund inverts the code of the purchase it refunds (AGENTS.md § VAT code rules, #288, #357):
 * money back from a merchant without a credit note of its own takes the code of the purchase it
 * refunds with the minus (I81 → -I81, I0 → -I0), so the input tax claimed on it goes back at its
 * rate (MWSTG Art. 41 Abs. 2). Only a purchase found unambiguously decides it, among the booked
 * payments out of the same merchant (merchantName) in the same currency, dated no later:
 * - a purchase is a payment booked on one account with one purchase code; one with other lines too
 *   (a part without a code on a clearing account, two codes, #295) that could hold the refund makes
 *   it not found, since the money may come back on any of its lines;
 * - what came back already from that merchant onto the account (any refund booked, by code, the AI
 *   or a person) is taken off what was bought there: a purchase is refunded at most once in full;
 * - the refund's text naming a number only one payment of the merchant carries (its own or its
 *   receipt's, never a card or terminal number its other payments show too) picks that purchase;
 * - else the purchases of the same amount, of one account and code (the newest names it);
 * - else a part: the only purchase of the merchant at least as large, and no other purchases that
 *   add up to the refund.
 * A purchase in a filed quarter is found as any other: the refund is booked on its own date, the
 * filed entry stays as it is.
 */
import { numbersIn } from '../accounting/document-numbers.js';
import { toRappen } from '../accounting/rappen.js';
import { merchantName } from '../knowledge/merchant-name.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';

export interface RefundCode {
  /** The purchase's code with the minus: -I81, -M81, -I0. */
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

/** At most this many other purchases are tried in sums against a part refunded; with more, the part is not found. */
const SUMS_OF = 20;

const textOf = (t: BankTransaction): string => [t.description, t.reference ?? '', t.remarks ?? '', ...(t.parts ?? []).map((p) => p.reference ?? '')].join(' ');

/** Whether some of `amounts` (in hundredths) add up to `target`; true too when there are too many to try. */
function someAddUpTo(amounts: readonly number[], target: number): boolean {
  const small = amounts.filter((a) => a > 0 && a <= target);
  if (small.length > SUMS_OF) return true;
  let sums = new Set<number>([0]);
  for (const a of small) {
    const next = new Set(sums);
    for (const s of sums) if (s + a <= target) next.add(s + a);
    if (next.has(target)) return true;
    sums = next;
  }
  return false;
}

/** A payment out of the merchant as booked (in hundredths): on one account with one purchase code (`clean`), or otherwise. */
interface Bought { tx: BankTransaction; amount: number; clean?: { account: string; code: string; entry: string } }

function boughtOf(t: BankTransaction, lines: readonly JournalEntry[]): Bought {
  const amount = lines.reduce((s, j) => s + toRappen(j.amount), 0);
  const kinds = new Set(lines.map((j) => (PURCHASE.test(j.vatCode ?? '') ? `${j.accountDebit} ${j.vatCode}` : '')));
  const [kind] = kinds;
  if (kinds.size !== 1 || !kind) return { tx: t, amount };
  const [account, code] = kind.split(' ');
  const newest = [...lines].sort((a, b) => b.date.localeCompare(a.date))[0];
  return { tx: t, amount, clean: { account, code, entry: newest.id } };
}

/**
 * The purchase the money-in payment `tx` refunds for `amount` (in the payment's currency) onto
 * `account` (absent: any account a purchase of the merchant was booked on), with the code that
 * takes its input tax back. Undefined when no purchase is found, or more than one could be it.
 */
export function refundedPurchase(tx: BankTransaction, amount: number, books: Booked, account?: string): RefundCode | undefined {
  if (tx.direction !== 'CRDT' || !(amount > 0)) return undefined;
  const merchant = merchantName(tx)?.toLowerCase();
  if (!merchant) return undefined;
  const theirs = books.transactions.filter((t) => t.ref !== tx.ref && t.currency === tx.currency && merchantName(t)?.toLowerCase() === merchant);
  const byRef = new Map<string, JournalEntry[]>();
  for (const j of books.journalEntries) byRef.set(j.transactionRef, [...(byRef.get(j.transactionRef) ?? []), j]);
  const bought = theirs.filter((t) => t.direction === 'DBIT' && t.date <= tx.date && byRef.has(t.ref)).map((t) => boughtOf(t, byRef.get(t.ref)!));
  const back = toRappen(amount);
  // A payment booked otherwise that could hold the refund: which of its lines comes back, the person says.
  if (bought.some((b) => !b.clean && b.amount >= back)) return undefined;
  // What is left on an account of what was bought there, less what came back already from this merchant.
  const left = (on: string): number => bought.filter((b) => b.clean?.account === on).reduce((s, b) => s + b.amount, 0)
    - theirs.filter((t) => t.direction === 'CRDT').flatMap((t) => byRef.get(t.ref) ?? []).filter((j) => j.accountCredit === on).reduce((s, j) => s + toRappen(j.amount), 0);
  let cands = bought.filter((b) => b.clean && (account === undefined || b.clean.account === account) && b.amount >= back && left(b.clean.account) >= back);
  if (!cands.length) return undefined;
  // The refund's text names the purchase: a number only one of the merchant's payments carries.
  let picked = false;
  const named = numbersIn(textOf(tx));
  if (named.length) {
    const numbers = (t: BankTransaction): string[] => {
      const linked = new Set((books.mappings ?? []).filter((m) => m.transactionRef === t.ref).map((m) => m.receiptId));
      return [textOf(t), ...(books.receipts ?? []).filter((r) => linked.has(r.id)).map((r) => r.extractedText ?? '')].flatMap(numbersIn);
    };
    const carried = new Map(theirs.map((t) => [t.ref, new Set(numbers(t))]));
    const own = new Set(named.map((n) => [...carried].filter(([, ns]) => ns.has(n))).filter((c) => c.length === 1).map(([[ref]]) => ref));
    const hits = cands.filter((b) => own.has(b.tx.ref));
    if (hits.length === 1) { cands = hits; picked = true; }
  }
  const same = cands.filter((b) => b.amount === back);
  let hit: Bought;
  if (same.length) {
    if (new Set(same.map((b) => `${b.clean!.account} ${b.clean!.code}`)).size !== 1) return undefined;
    hit = [...same].sort((a, b) => b.tx.date.localeCompare(a.tx.date))[0];
  } else if (picked) {
    hit = cands[0];
  } else {
    // A part: the one purchase of the merchant large enough, and no other purchases that add up to it.
    if (cands.length !== 1 || bought.filter((b) => b.amount >= back).length !== 1) return undefined;
    if (someAddUpTo(bought.filter((b) => b !== cands[0]).map((b) => b.amount), back)) return undefined;
    hit = cands[0];
  }
  const { code, account: on, entry } = hit.clean!;
  // On the purchase's own account its code exactly, with the minus: the refund takes back what it claimed, in the box it claimed it.
  return { code: `-${code}`, originalCode: code, account: on, original: { ref: hit.tx.ref, date: hit.tx.date }, entry };
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
