/**
 * What the national VAT rules alone give a company rule's lines on a payment (issue #75): the code
 * the classifier would have set without the rule, by the same checks in the same order
 * (src/booking/classify.ts entriesFor, then withPurchaseVat): Bezugsteuer on a service from abroad
 * (src/accounting/acquisition-tax.ts, #44), then the business files' facts and the receipt rules
 * (src/booking/purchase-vat.ts, #54). The rule card warns where a rule books against them.
 *
 * The facts are the ones the books keep: the linked receipts' VAT facts, the other party's IBAN,
 * and the classifier's reading of the supplier. The model reads what a purchase buys and where its
 * supplier sits only when it books; its entries keep that reading (JournalEntry.supply,
 * supplierCountry, #80). An entry booked before they did keeps it only in the code it led to, so a
 * payment the app (or a person) booked with Bezugsteuer before counts as a service from abroad.
 */
import { acquisitionCodeOf } from '../accounting/acquisition-tax.js';
import { invoicing, vat } from '../engines/index.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import { EFFECTIVE_QUARTERLY } from '../workspace/vat-setup.js';
import type { ClassifyContext } from './classify.js';
import { withPurchaseVat } from './purchase-vat.js';

/** A booking line with both sides, the code it carries. */
export type SideLine = Pick<ClassifyEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode'>;

/** How a rule's code departs from the national rules' on a line. */
export type NationalOverride =
  /** The national rules owe Bezugsteuer, the rule books none. */
  | 'withoutAcquisition'
  /** The rule books Bezugsteuer where the national rules owe none (a receipt shows Swiss VAT or a Swiss UID). */
  | 'withAcquisition'
  /** The rule claims input tax that no receipt shows (or that the business's file says is claimed elsewhere). */
  | 'inputTaxWithoutReceipt'
  /** The rule claims no input tax although the receipt shows Swiss VAT. */
  | 'inputTaxForgone'
  /** Both claim input tax, at another rate or on another box. */
  | 'otherCode';

/** What the classifier knew of the payment's supplier, as far as the books keep it. */
export type SupplierFacts = Pick<ClassifyEntry, 'supply' | 'supplierCountry'> & { abroad?: true };

const isAcquisition = (code: string | undefined): boolean => !!code && !!vat().codes.parse(code)?.acquisitionZiffer;

/** The one value of `key` the entries keep, or undefined when none keeps one or they differ (a mixed cart). */
function kept<K extends 'supply' | 'supplierCountry'>(entries: readonly JournalEntry[], key: K): JournalEntry[K] | undefined {
  const values = new Set(entries.map((e) => e[key]).filter((v) => v !== undefined));
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * The supplier facts of `tx` from its bookings `entries`: the supply and supplier country the
 * classifier read, as its entries keep them. Else a service from abroad when one of them, not booked
 * by a rule, carries an acquisition code or carried one before a person or the AI sidebar changed
 * it; the country of the other party's IBAN when it lies outside the territory.
 */
export function supplierFacts(tx: Pick<BankTransaction, 'counterpartyIban'>, entries: readonly JournalEntry[]): SupplierFacts {
  const iban = tx.counterpartyIban?.replace(/\s+/g, '').slice(0, 2).toUpperCase();
  const country = kept(entries, 'supplierCountry') ?? (iban && /^[A-Z]{2}$/.test(iban) && !invoicing().territory.includes(iban) ? iban : undefined);
  const acquired = entries.some((e) => e.by?.kind !== 'rule' && (isAcquisition(e.vatCode) || ((e.by?.kind === 'person' || e.by?.kind === 'assistant') && isAcquisition(e.by.was?.vatCode))));
  const supply = kept(entries, 'supply') ?? (acquired ? 'service' : undefined);
  return { ...(supply ? { supply } : {}), ...(acquired ? { abroad: true as const } : {}), ...(country ? { supplierCountry: country } : {}) };
}

/**
 * The code of each of `lines` (a rule's booking of `tx`) as the national rules alone would set it,
 * the rule's code standing in for the model's: unchanged where they agree or do not decide.
 */
export function nationalCodes(tx: BankTransaction, lines: readonly SideLine[], documents: readonly Receipt[], facts: SupplierFacts, context: Pick<ClassifyContext, 'vat' | 'purchaseVat' | 'counterparties'>): Array<string | undefined> {
  const setup = context.vat ?? EFFECTIVE_QUARTERLY;
  const entries = lines.map((l, i): JournalEntry => {
    const acquired = acquisitionCodeOf({ ...l, ...facts }, documents, setup);
    const code = acquired ? acquired.code : l.vatCode;
    return {
      id: String(i), transactionRef: tx.ref, date: tx.date, accountDebit: l.accountDebit, accountCredit: l.accountCredit, amount: l.amount, description: '', origin: 'classify',
      ...(code ? { vatCode: code } : {}),
      by: acquired ? { kind: 'code', check: 'acquisitionTax' } : { kind: 'model', model: 'rule' },
    };
  });
  return withPurchaseVat(tx, entries, documents, context.purchaseVat, context.counterparties).map((e) => e.vatCode || undefined);
}

/** How the rule's code `ruled` departs from the national rules' `national`, or undefined when they agree. */
export function overrideOf(ruled: string | undefined, national: string | undefined): NationalOverride | undefined {
  if ((ruled ?? '') === (national ?? '')) return undefined;
  if (isAcquisition(national)) return 'withoutAcquisition';
  if (isAcquisition(ruled)) return 'withAcquisition';
  const rate = (c: string | undefined) => (c ? vat().codes.parse(c)?.rate ?? 0 : 0);
  if (rate(ruled) > 0 && !(rate(national) > 0)) return 'inputTaxWithoutReceipt';
  if (!(rate(ruled) > 0) && rate(national) > 0) return 'inputTaxForgone';
  return 'otherCode';
}
