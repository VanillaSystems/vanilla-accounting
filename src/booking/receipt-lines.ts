/**
 * A payment that several receipts pay is booked one line per receipt (#27), each with its own
 * account and VAT. The model is asked for that already (rule 5 of the classify prompt); when it
 * books the payment on one line all the same, code splits that line by the receipts: each receipt's
 * amount and description on the line's account, the line's VAT facts carried over, which the
 * receipt rules then decide per receipt (src/booking/purchase-vat.ts, by lineReceipts). Only when
 * the receipts are purchase documents in the payment's currency, owe what it paid to the centime,
 * and all owe in the payment's direction: else the line stays as the model booked it.
 * Browser-safe and pure.
 */
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { baseCurrency } from '../engines/index.js';
import { creditSigned } from '../accounting/credit-signed.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction, Receipt } from '../types/index.js';

const cents = (n: number) => Math.round(n * 100);

export function splitByReceipts(tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>, lines: ClassifyEntry[], documents: readonly Receipt[]): ClassifyEntry[] {
  const receipts = documents.filter(isPurchaseDocument);
  if (receipts.length < 2 || lines.length !== 1 || receipts.length !== documents.length) return lines;
  const [line] = lines;
  const out = tx.direction === 'DBIT' ? 1 : -1;
  const owed = receipts.map((r) => (r.currency ?? baseCurrency()) === tx.currency && r.amount !== undefined ? out * cents(creditSigned(r)!) : undefined);
  if (owed.some((c) => c === undefined || c <= 0)) return lines;
  const paid = cents(Math.abs(tx.amount));
  if (cents(Math.abs(line.amount)) !== paid || owed.reduce((s, c) => s! + c!, 0) !== paid) return lines;
  // Each part keeps the sign the model gave the line: a refund's lines stay refunds.
  const sign = Math.sign(line.amount);
  return receipts.map((r, i) => ({ ...line, amount: (sign * owed[i]!) / 100, description: r.description || line.description }));
}
