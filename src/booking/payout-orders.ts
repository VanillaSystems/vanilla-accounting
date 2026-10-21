/**
 * A payment provider's payout booked per order (issue #26). The payout itself does not know the
 * customer, so a payout that mixes domestic orders and exports cannot take one code; its order
 * documents can. Each order document names the payouts it went into by their date (OrderFacts,
 * read once at the match step); the orders whose shares fall on this payout are its content. Code
 * books each order's gross on the sales account, at the firm's sale code when delivered in the VAT
 * territory and at the export code when delivered abroad, each refund deducted from the payout with
 * its code's minus, and what the provider kept (gross less what it paid out) as its fees. The lines
 * add up to the payout, or nothing is booked. Browser-safe and pure; provider facts stay data.
 */
import type { BankTransaction, OrderFacts, PayoutShare } from '../types/index.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';

/** How many days the bank's date of a payout may lie from the date its order documents name. */
export const PAYOUT_DAYS = 3;
const DAY = 864e5;

/** Whether a share an order document names falls on the payout the bank reports on `date`. */
export const onPayout = (share: Pick<PayoutShare, 'date'>, date: string): boolean => Math.abs(Date.parse(share.date) - Date.parse(date)) <= PAYOUT_DAYS * DAY;

/** The codes an order takes: a delivery into `territory` is a domestic sale, any other an export. Absent `domestic`: the firm books no codes. */
export interface OrderCodes {
  territory: readonly string[];
  /** The domestic sale's code, its refund's, and the rate an order's own tax line must show. */
  domestic?: { sale: string; refund: string; rate: number };
  abroad?: { sale: string; refund: string };
}

/** Where the lines go: the bank, the sales account, the provider's fees with their code. */
export interface OrderAccounts { bank: string; sales: string; fees: { account: string; vat: string } }

/** Why a payout's orders book nothing: the person decides (processes/booking.guide.yaml#sale_vat sv-order-tax). */
export type OrderHold =
  | { why: 'missing'; orders: number; paid: number }
  | { why: 'tax'; order: string }
  | { why: 'split'; order: string }
  | { why: 'currency'; order: string; currency: string };

export type OrderSplit =
  | { lines: ClassifyEntry[]; orders: number; refunds: number; fees: number }
  | { hold: OrderHold };

/**
 * The code an order's sale takes, or 'tax' when its own tax line disagrees with where it was
 * delivered: a domestic delivery must show the domestic tax at the normal rate, an export none.
 */
function codesOf(o: OrderFacts, codes: OrderCodes): { sale: string; refund: string } | undefined | 'tax' {
  if (!codes.domestic) return undefined;
  const domestic = codes.territory.includes(o.shipTo);
  if (domestic) return o.tax && codes.territory.includes(o.tax.country) && o.tax.rate === codes.domestic.rate ? codes.domestic : 'tax';
  return o.tax ? 'tax' : codes.abroad;
}

/**
 * The payout `tx` split by its order documents, or undefined when none of them names a share of it.
 * An order paid out in several payouts, in another currency than the payout's, or whose tax line
 * disagrees with its delivery, holds the payout, and so do orders that do not add up to it.
 */
export function payoutByOrders(tx: Pick<BankTransaction, 'date' | 'amount' | 'currency'>, orders: readonly OrderFacts[], accounts: OrderAccounts, codes: OrderCodes, name: string): OrderSplit | undefined {
  const inPayout = orders
    .map((o) => ({ o, added: o.payouts.filter((s) => onPayout(s, tx.date)), back: o.refunds.filter((s) => onPayout(s, tx.date)) }))
    .filter((x) => x.added.length || x.back.length);
  if (!inPayout.length) return undefined;
  const lines: ClassifyEntry[] = [];
  let total = 0;
  let fees = 0;
  let refunds = 0;
  for (const { o, added, back } of inPayout) {
    if (o.currency !== tx.currency) return { hold: { why: 'currency', order: o.number, currency: o.currency } };
    if (added.length && (o.payouts.length > 1 || added.some((s) => toRappen(s.amount) > toRappen(o.gross)))) return { hold: { why: 'split', order: o.number } };
    const code = codesOf(o, codes);
    if (code === 'tax') return { hold: { why: 'tax', order: o.number } };
    if (added.length) {
      lines.push({ accountDebit: accounts.bank, accountCredit: accounts.sales, amount: o.gross, vatCode: code?.sale ?? '', description: `${name}, Bestellung #${o.number}, ${o.shipTo}` });
      total += toRappen(added[0].amount);
      fees += toRappen(o.gross) - toRappen(added[0].amount);
    }
    for (const r of back) {
      lines.push({ accountDebit: accounts.sales, accountCredit: accounts.bank, amount: r.amount, vatCode: code?.refund ?? '', description: `${name}, Rückerstattung #${o.number}` });
      total -= toRappen(r.amount);
      refunds += toRappen(r.amount);
    }
  }
  if (total !== toRappen(tx.amount)) return { hold: { why: 'missing', orders: fromRappen(total), paid: tx.amount } };
  if (fees > 0) lines.push({ accountDebit: accounts.fees.account, accountCredit: accounts.bank, amount: fromRappen(fees), vatCode: accounts.fees.vat, description: `${name}, Gebühren` });
  return { lines, orders: inPayout.filter((x) => x.added.length).length, refunds: fromRappen(refunds), fees: fromRappen(fees) };
}
