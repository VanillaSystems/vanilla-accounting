/**
 * Customer payments the classifier booked without output tax because no invoice was linked.
 * «No receipt, zero code» is right for an expense (no input tax without proof); for a sale of
 * VAT-registered books it leaves the output tax out of the return, so the owner decides each one
 * once: the app asks (src/intake/sale-questions.ts) with a proposal computed here, the answer rebooks
 * the payment and becomes a rule for that payer (src/server/questions.ts), and the next payment of
 * that payer is booked by the rule. Or the owner uploads the invoice (the payment is then booked
 * again, classify-force.ts entriesWithoutTheirReceipts). What a revenue account, the normal rate,
 * the export code and the VAT territory are comes from the jurisdiction's engines.
 */
import type { BankTransaction, Index, JournalEntry } from '../types/index.js';
import { baseCurrency, chart, invoicing, vat } from '../engines/index.js';
import { ibanKey } from '../knowledge/payer.js';
import type { SaleChoice, SaleProposal } from '../questions/model.js';

export interface SaleWithoutVat {
  payment: BankTransaction;
  /** The classifier's entries of the payment that book revenue without output tax. */
  entries: JournalEntry[];
}

/** A rule's entry was decided by a person (an answer kept as a rule), so it is no longer the classifier's guess. */
const byClassifier = (e: JournalEntry) => (e.origin === undefined || e.origin === 'classify') && !e.rule;
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

/**
 * What the app proposes for a sale without an invoice: an export when the money is in a foreign
 * currency or comes from an IBAN outside the VAT territory, else a domestic sale at the normal rate.
 */
export function saleProposal(tx: Pick<BankTransaction, 'currency' | 'counterpartyIban'>): SaleProposal {
  if (tx.currency !== baseCurrency()) return { choice: 'saleAbroad', why: 'foreignCurrency' };
  const country = ibanKey(tx.counterpartyIban)?.slice(0, 2);
  if (!country) return { choice: 'saleDomestic', why: 'domesticCurrency' };
  return invoicing().territory.includes(country) ? { choice: 'saleDomestic', why: 'domesticIban' } : { choice: 'saleAbroad', why: 'foreignIban' };
}

/** The normal rate a domestic sale is booked at (the first rate an invoice line offers). */
export const normalRate = (): number => invoicing().rates[0];

/** The VAT code an answer books the sale with; null: no VAT code (not a sale). */
export function saleVatCode(choice: SaleChoice): string | null {
  switch (choice) {
    case 'saleDomestic': return vat().codes.saleAt(normalRate()) ?? null;
    case 'saleAbroad': return vat().codes.deductedIn(invoicing().exemptions.export) ?? null;
    case 'notSale': return null;
  }
}
