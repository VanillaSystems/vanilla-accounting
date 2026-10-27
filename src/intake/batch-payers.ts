/**
 * The businesses that are paid for several receipts in one payment (#190 2d): a marketplace that
 * charges a card per shipment of several orders, a courier whose invoices are paid together. Which
 * they are is a fact in the business's file, `grouped: true`, in the app's layer (true for every
 * company) or the company's (learned from its own links, src/saving/grouped-flag.ts), never a name
 * in code (ADR 0015). A receipt and a payment are a business's by its file's `match` (uid, iban,
 * domain, tx, file), the same routing as everywhere (src/knowledge/counterparties.ts identify).
 * Pure and browser-safe.
 */
import { identify, signalsOfReceiptRead, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { BankTransaction, Receipt } from '../types/index.js';

export interface BatchPayers {
  /** The flagged business a receipt is of, by its file's match; none for any other receipt. */
  ofReceipt(r: Receipt): string | undefined;
  /** The flagged business a payment is of (businessOfPayment, with the receipts linked to it); none for any other payment. */
  ofPayment(tx: BankTransaction, linked?: readonly Receipt[]): string | undefined;
}

export const NO_BATCH_PAYERS: BatchPayers = { ofReceipt: () => undefined, ofPayment: () => undefined };

/** The business a receipt is of, by what it says of its sender (signalsOfReceiptRead): its UID, the addresses and name in its first and last lines, its filename. */
export function businessOfReceipt(r: Receipt, counterparties: readonly Counterparty[]): string | undefined {
  const routing = identify(signalsOfReceiptRead(r), counterparties);
  return routing.kind === 'known' ? routing.counterparty : undefined;
}

/**
 * The business a payment is of: by its own text and IBAN and the UIDs and filenames of the
 * receipts linked to it (signalsOfTransaction), else, when that says nothing, the one business all
 * its linked receipts are of (a business known by its UID alone, whose name the bank does not
 * print). The batch payers and the «Immer so?» that flags one both ask this.
 */
export function businessOfPayment(tx: BankTransaction, linked: readonly Receipt[], counterparties: readonly Counterparty[]): string | undefined {
  const routing = identify(signalsOfTransaction(tx, [...linked]), counterparties);
  if (routing.kind === 'known') return routing.counterparty;
  if (routing.kind === 'ambiguous' || !linked.length) return undefined;
  const of = new Set(linked.map((r) => businessOfReceipt(r, counterparties)));
  return of.size === 1 ? [...of][0] : undefined;
}

export function batchPayers(counterparties: readonly Counterparty[]): BatchPayers {
  const flagged = new Set(counterparties.filter((c) => c.grouped).map((c) => c.id));
  if (!flagged.size) return NO_BATCH_PAYERS;
  const only = (id: string | undefined) => (id && flagged.has(id) ? id : undefined);
  return {
    ofReceipt: (r) => only(businessOfReceipt(r, counterparties)),
    ofPayment: (tx, linked = []) => only(businessOfPayment(tx, linked, counterparties)),
  };
}
