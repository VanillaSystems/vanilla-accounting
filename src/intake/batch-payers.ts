/**
 * The businesses that are paid for several receipts in one payment (#190 2d): a marketplace that
 * charges a card per shipment of several orders, a courier whose invoices are paid together. Which
 * they are is a fact in the business's file, `grouped: true`, in the app's layer (true for every
 * company) or the company's (learned from its own links, src/saving/grouped-flag.ts), never a name
 * in code (ADR 0015). A receipt and a payment are a business's by its file's `match` (uid, iban,
 * domain, tx, file), the same routing as everywhere (src/knowledge/counterparties.ts identify).
 * Pure and browser-safe.
 */
import { identify, signalsOfReceipt, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { BankTransaction, Receipt } from '../types/index.js';

export interface BatchPayers {
  /** The flagged business a receipt is of, by its file's match; none for any other receipt. */
  ofReceipt(r: Receipt): string | undefined;
  /** The flagged business a payment routes to; none for any other payment. */
  ofPayment(tx: BankTransaction): string | undefined;
}

export const NO_BATCH_PAYERS: BatchPayers = { ofReceipt: () => undefined, ofPayment: () => undefined };

export function batchPayers(counterparties: readonly Counterparty[]): BatchPayers {
  const flagged = new Set(counterparties.filter((c) => c.grouped).map((c) => c.id));
  if (!flagged.size) return NO_BATCH_PAYERS;
  const known = (routing: ReturnType<typeof identify>) => (routing.kind === 'known' && flagged.has(routing.counterparty) ? routing.counterparty : undefined);
  return {
    ofReceipt: (r) => known(identify(signalsOfReceipt(r), counterparties)),
    ofPayment: (tx) => known(identify(signalsOfTransaction(tx, []), counterparties)),
  };
}
