/**
 * Customer payments the classifier booked without output tax because no invoice was linked.
 * «No receipt, zero code» is right for an expense (no input tax without proof); for a sale of
 * VAT-registered books it leaves the output tax out of the return, so the owner has to see each
 * one: upload the invoice (the payment is then booked again, classify-force.ts
 * entriesWithoutTheirReceipts) or say it carries no VAT (`noReceiptNeeded` on the payment).
 * What a revenue account and a zero code are comes from the jurisdiction's engines.
 */
import type { BankTransaction, Index, JournalEntry } from '../types/index.js';
import { chart, vat } from '../engines/index.js';

export interface SaleWithoutVat {
  payment: BankTransaction;
  /** The classifier's entries of the payment that book revenue without output tax. */
  entries: JournalEntry[];
}

const byClassifier = (e: JournalEntry) => e.origin === undefined || e.origin === 'classify';
const withoutOutputTax = (e: JournalEntry) => !e.vatCode || (vat().codes.parse(e.vatCode)?.rate ?? 0) === 0;

/** The open period's incoming payments, with no receipt linked and not marked as needing none, booked as revenue at a zero code. */
export function salesWithoutVat(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'config'>, vatRegistered: boolean): SaleWithoutVat[] {
  if (!vatRegistered) return [];
  const closedThrough = books.config?.closedThrough;
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const entries = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) {
    if (byClassifier(e) && !e.corrects && chart().typeOf(e.accountCredit) === 'revenue' && withoutOutputTax(e)) {
      (entries.get(e.transactionRef) ?? entries.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
    }
  }
  return books.transactions
    .filter((p) => p.direction === 'CRDT' && !(closedThrough && p.date <= closedThrough) && !p.noReceiptNeeded && !linked.has(p.ref) && entries.has(p.ref))
    .map((payment) => ({ payment, entries: entries.get(payment.ref)! }));
}
