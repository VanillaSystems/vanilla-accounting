/** A credit note's sign, browser-safe: the match step stores it, the receipt sets (src/intake/receipt-sets.ts) sum by it. */
import type { Receipt } from '../types/index.js';

/**
 * A credit note's total is money back: when the receipt's VAT says so (its tax, or its net and
 * gross, below zero), its amount is negative too, whatever sign the reader gave it (corner-34).
 */
export function creditSigned(r: Pick<Receipt, 'amount' | 'vatSummary'>): number | undefined {
  const groups = r.vatSummary ?? [];
  const back = groups.length > 0 && (groups.reduce((sum, g) => sum + g.vat, 0) < 0 || groups.every((g) => (g.gross ?? g.net ?? 0) < 0));
  return r.amount !== undefined && back && r.amount > 0 ? -r.amount : r.amount;
}
