/**
 * The businesses that are paid for several receipts in one payment (#190 2d): a marketplace that
 * charges a card per shipment of several orders, a courier whose invoices are paid together. Which
 * they are is a fact in the business's file, `grouped: true`, in the app's layer (true for every
 * company) or the company's (learned from its own links, src/saving/grouped-flag.ts), never a name
 * in code (ADR 0015). A receipt and a payment are a business's by its file's `match` (uid, iban,
 * domain, tx, file), the same routing as everywhere (src/knowledge/counterparties.ts identify).
 * Pure and browser-safe.
 */
import { identify, signalsOfReceiptRead, signalsOfTransaction, silentUids, type Counterparty } from '../knowledge/counterparties.js';
import type { BankTransaction, Receipt } from '../types/index.js';

export interface BatchPayers {
  /** The flagged business a receipt is of, by its file's match; none for any other receipt. */
  ofReceipt(r: Receipt): string | undefined;
  /** The flagged business a payment is of (businessOfPayment, with the receipts linked to it); none for any other payment. */
  ofPayment(tx: BankTransaction, linked?: readonly Receipt[]): string | undefined;
}

export const NO_BATCH_PAYERS: BatchPayers = { ofReceipt: () => undefined, ofPayment: () => undefined };

/**
 * The business a receipt is of, by what it says of its sender (signalsOfReceiptRead): its UID, the
 * addresses and name in its first and last lines, its filenames. `buyerUid`: the company's own
 * (company.uid), which says nothing of who wrote a receipt.
 */
export function businessOfReceipt(r: Receipt, counterparties: readonly Counterparty[], buyerUid?: string, silent = silentUids(counterparties, buyerUid)): string | undefined {
  const routing = identify(signalsOfReceiptRead(r, silent), counterparties);
  return routing.kind === 'known' ? routing.counterparty : undefined;
}

/**
 * The business a payment is of: by its own text and IBAN and the UIDs and filenames of the
 * receipts linked to it (signalsOfTransaction), else, when that says nothing, the one business all
 * its linked receipts are of (a business known by its UID alone, whose name the bank does not
 * print). The batch payers and the «Immer so?» that flags one both ask this.
 */
export function businessOfPayment(tx: BankTransaction, linked: readonly Receipt[], counterparties: readonly Counterparty[], buyerUid?: string, silent = silentUids(counterparties, buyerUid)): string | undefined {
  const routing = identify(signalsOfTransaction(tx, [...linked]), counterparties);
  if (routing.kind === 'known') return routing.counterparty;
  if (routing.kind === 'ambiguous' || !linked.length) return undefined;
  const of = new Set(linked.map((r) => businessOfReceipt(r, counterparties, buyerUid, silent)));
  return of.size === 1 ? [...of][0] : undefined;
}

/**
 * Whose a receipt and an unlinked payment are by the business files: a receipt by what it says of
 * its sender (businessOfReceipt), a payment by its own text and IBAN alone (match.tx, iban; the
 * names learned from confirmed links among them, src/knowledge/learned-names.ts). The pair search
 * counts a payment that names the receipt's business as its name (src/intake/pairing.ts fitOf).
 * Each answer is asked once per receipt and payment.
 */
export interface Businesses {
  ofReceipt(r: Receipt): string | undefined;
  ofPayment(tx: BankTransaction): string | undefined;
}

export function businesses(counterparties: readonly Counterparty[], buyerUid?: string): Businesses {
  const silent = silentUids(counterparties, buyerUid);
  const receipts = new WeakMap<Receipt, string | undefined>();
  const payments = new WeakMap<BankTransaction, string | undefined>();
  const memo = <K extends object>(seen: WeakMap<K, string | undefined>, of: (k: K) => string | undefined) => (k: K) => {
    if (!seen.has(k)) seen.set(k, of(k));
    return seen.get(k);
  };
  return {
    ofReceipt: memo(receipts, (r) => businessOfReceipt(r, counterparties, buyerUid, silent)),
    ofPayment: memo(payments, (tx) => { const routing = identify(signalsOfTransaction(tx, []), counterparties); return routing.kind === 'known' ? routing.counterparty : undefined; }),
  };
}

/** The batch payers among `counterparties`; `buyerUid`: the company's own UID (company.uid). */
export function batchPayers(counterparties: readonly Counterparty[], buyerUid?: string): BatchPayers {
  const flagged = new Set(counterparties.filter((c) => c.grouped).map((c) => c.id));
  if (!flagged.size) return NO_BATCH_PAYERS;
  const only = (id: string | undefined) => (id && flagged.has(id) ? id : undefined);
  const silent = silentUids(counterparties, buyerUid);
  return {
    ofReceipt: (r) => only(businessOfReceipt(r, counterparties, buyerUid, silent)),
    ofPayment: (tx, linked = []) => only(businessOfPayment(tx, linked, counterparties, buyerUid, silent)),
  };
}
