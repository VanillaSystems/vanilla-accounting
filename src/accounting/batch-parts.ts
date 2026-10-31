/**
 * A collective payment (a batch the bank booked once, with a part per payee): it stays one
 * transaction, and each part is what a receipt pays and what a line is booked for. Pure and
 * browser-safe.
 */
import type { BankTransaction, BankTransactionPart, Receipt } from '../types/index.js';
import { toRappen } from './rappen.js';

/** The parts of a collective payment when they are two or more, in its currency, and add up to what the bank paid; else undefined. */
export function partsOf(tx: Pick<BankTransaction, 'parts' | 'currency' | 'amount'>, paid = tx.amount): BankTransactionPart[] | undefined {
  const parts = tx.parts ?? [];
  if (parts.length < 2 || parts.some((p) => p.currency !== tx.currency)) return undefined;
  return toRappen(parts.reduce((s, p) => s + Math.abs(p.amount), 0)) === toRappen(Math.abs(paid)) ? parts : undefined;
}

/** One part of a collective payment in words: its payee and its reference (the invoice number), as the bank gave them. */
export const partText = (p: Pick<BankTransactionPart, 'counterparty' | 'reference'>): string => [p.counterparty.trim(), p.reference?.trim()].filter(Boolean).join(' · ');

/** One part of a collective payment as a payment of its own: the same ref, day and bank, its amount with the payment's sign, its payee, IBAN and reference, and the part in words as its text. */
export function partPayment(tx: BankTransaction, p: BankTransactionPart): BankTransaction {
  const sign = tx.amount < 0 ? -1 : 1;
  return { ...tx, amount: sign * Math.abs(p.amount), description: partText(p), counterparty: p.counterparty, counterpartyIban: p.counterpartyIban, reference: p.reference, parts: undefined };
}

/**
 * The receipts of each part of a collective payment (partsOf), by the part's index: a receipt pays
 * the first part of its amount that no other receipt pays. Undefined when the payment is no
 * collective one, or a receipt pays none of its parts (a document of the whole, a second one for a
 * part, a person's link): its receipts are then the whole payment's.
 */
export function partReceipts<R extends Pick<Receipt, 'amount' | 'currency'>>(tx: BankTransaction, receipts: readonly R[]): R[][] | undefined {
  const parts = partsOf(tx);
  if (!parts) return undefined;
  const out: R[][] = parts.map(() => []);
  for (const r of receipts) {
    const i = parts.findIndex((p, k) => !out[k].length && p.currency === (r.currency || tx.currency) && toRappen(Math.abs(p.amount)) === toRappen(Math.abs(r.amount ?? 0)));
    if (i < 0) return undefined;
    out[i].push(r);
  }
  return out;
}
