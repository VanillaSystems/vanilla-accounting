/**
 * Customer payments without an invoice. «No receipt, zero code» is right for an expense (no input
 * tax without proof); a sale of VAT-registered books owes its output tax with or without a
 * document. So the classifier books such a sale with the app's proposal (saleCodeOf: the normal
 * rate for the books' currency from the VAT territory, the export code for money from abroad), and
 * the owner decides each one once: the app asks (src/intake/sale-questions.ts), the answer rebooks
 * the payment and becomes a rule for that payer (src/server/questions.ts), and the next payment of
 * that payer is booked by the rule. Or the owner uploads the invoice (the payment is then booked
 * again, classify-force.ts entriesWithoutTheirReceipts). What a revenue account, the normal rate,
 * the export code and the VAT territory are comes from the jurisdiction's engines.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../types/index.js';
import { baseCurrency, chart, invoicing, vat } from '../engines/index.js';
import { ibanKey } from '../knowledge/payer.js';
import type { SaleChoice, SaleProposal, SaleWhy } from '../questions/model.js';
import { methodOf, type VatSetup } from '../workspace/vat-setup.js';

export interface SaleWithoutVat {
  payment: BankTransaction;
  /** The classifier's entries of the payment that book revenue (without output tax, for salesWithoutVat). */
  entries: JournalEntry[];
}

type SaleBooks = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'config'>;

/** A rule's entry was decided by a person (an answer kept as a rule), so it is no longer the classifier's guess. */
const byClassifier = (e: JournalEntry) => (e.origin === undefined || e.origin === 'classify') && !e.rule;
const withoutOutputTax = (e: JournalEntry) => !e.vatCode || (vat().codes.parse(e.vatCode)?.rate ?? 0) === 0;

/** The open period's incoming payments, with no receipt linked and not marked as needing none, that the classifier booked as revenue, whatever the code. */
export function salesWithoutInvoice(books: SaleBooks, vatRegistered: boolean): SaleWithoutVat[] {
  if (!vatRegistered) return [];
  const closedThrough = books.config?.closedThrough;
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const entries = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) {
    if (byClassifier(e) && !e.corrects && chart().typeOf(e.accountCredit) === 'revenue') {
      (entries.get(e.transactionRef) ?? entries.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
    }
  }
  return books.transactions
    .filter((p) => p.direction === 'CRDT' && !(closedThrough && p.date <= closedThrough) && !p.noReceiptNeeded && !linked.has(p.ref) && entries.has(p.ref))
    .map((payment) => ({ payment, entries: entries.get(payment.ref)! }));
}

/** Of those, the ones booked as revenue at a zero code or none: the output tax the return leaves out until the owner answers. */
export function salesWithoutVat(books: SaleBooks, vatRegistered: boolean): SaleWithoutVat[] {
  return salesWithoutInvoice(books, vatRegistered)
    .map((s) => ({ ...s, entries: s.entries.filter(withoutOutputTax) }))
    .filter((s) => s.entries.length);
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

/** The VAT code an answer books the sale with: the normal rate's, or the firm's first net rate; null: no VAT code (not a sale, or a firm without codes). */
export function saleVatCode(choice: SaleChoice): string | null {
  switch (choice) {
    case 'saleDomestic': return vat().codes.saleAt(normalRate()) ?? vat().codes.netRateCode(1) ?? null;
    case 'saleAbroad': return vat().codes.deductedIn(invoicing().exemptions.export) ?? null;
    case 'notSale': return null;
  }
}

/** The choice a sale's code stands for: turnover at a rate, or under an invoice line's exemption; any other code says neither. */
export function saleChoiceOf(code: string | undefined): SaleChoice | undefined {
  const info = code ? vat().codes.parse(code) : null;
  if (!info || info.isNegative) return undefined;
  if (info.rate > 0) return info.revenueZiffer ? 'saleDomestic' : undefined;
  return info.deductionZiffer && Object.values(invoicing().exemptions).includes(info.deductionZiffer) ? 'saleAbroad' : undefined;
}

/**
 * Why a sale's code is what it is when code, not the model, set it: the books are not registered
 * for VAT, the invoice says the service is supplied abroad, or (no document) the payment's
 * currency and IBAN.
 */
export type SaleCodeWhy = 'unregistered' | 'netRate' | 'placeAbroad' | SaleWhy;
export interface SaleCode { code: string | undefined; why: SaleCodeWhy }

type SaleDocument = Pick<Receipt, 'hasSwissVat' | 'extractedText'>;

const escaped = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const mentions = (text: string, words: readonly string[]) =>
  words.some((w) => new RegExp(`(^|[^\\p{L}])${escaped(w)}($|[^\\p{L}])`, 'iu').test(text));

/**
 * The output-tax code of a sale line the model proposed (`proposed`) on an incoming payment, or
 * undefined when the model's code stands. A sale line is one on a revenue account whose code books
 * turnover at a rate or under an invoice line's exemption; a refund, a code that says the money is
 * no consideration, or none at all stays the model's. In this order:
 * - Books not registered for VAT charge none: no code, on every revenue line.
 * - On the net tax rate method a code of the firm's form stands (F1, F2, V0, V0-E); any other
 *   (the model's V81) is replaced: abroad by the document, else the first approved rate.
 * - A document that shows the jurisdiction's VAT decides (the model read its rate).
 * - A document without it that says the service is supplied abroad (invoicing.yaml placeAbroad):
 *   the abroad code, not the export code, which is for goods.
 * - Another document (an order page, a payout report): the model read it.
 * - No document: the proposal (saleProposal), so a domestic customer is never booked at zero for
 *   want of a paper; the owner confirms it once (src/intake/sale-questions.ts).
 */
export function saleCodeOf(proposed: string | undefined, accountCredit: string, tx: Pick<BankTransaction, 'direction' | 'currency' | 'counterpartyIban'>, documents: readonly SaleDocument[], setup: VatSetup): SaleCode | undefined {
  if (tx.direction !== 'CRDT' || chart().typeOf(accountCredit) !== 'revenue') return undefined;
  if (!setup.registered) return { code: undefined, why: 'unregistered' };
  const net = methodOf(setup) === 'net-rate';
  // A code that is no sale choice stands, unless this firm's form does not take it (the model's V81 on the net tax rate method).
  if (!saleChoiceOf(proposed) && !(net && !(proposed && vat().codes.parse(proposed)))) return undefined;
  const domestic = (): SaleCode => ({ code: saleVatCode('saleDomestic') ?? undefined, why: 'netRate' });
  if (documents.some((d) => d.hasSwissVat)) return net ? domestic() : undefined;
  if (documents.length) {
    if (documents.some((d) => mentions(d.extractedText ?? '', invoicing().placeAbroad))) return { code: vat().codes.deductedIn(invoicing().exemptions.abroad), why: 'placeAbroad' };
    return net ? domestic() : undefined;
  }
  const p = saleProposal(tx);
  return { code: saleVatCode(p.choice) ?? undefined, why: p.why };
}

/** The booking's reason when code set a sale's code (booking texts stay German, docs/i18n.md). */
export function saleCodeReason({ code, why }: SaleCode, currency: string): string {
  const asked = 'Vorschlag der App, die Frage dazu steht unter Aufgaben.';
  switch (why) {
    case 'unregistered': return 'Die Firma ist nicht steuerpflichtig: Umsatz ohne Steuercode.';
    case 'netRate': return `Saldosteuersatz: Umsatz brutto mit ${code}, die Steuer ist der bewilligte Satz auf dem Umsatz.`;
    case 'placeAbroad': return `Die Rechnung nennt den Leistungsort im Ausland und keine Inlandsteuer: Leistung im Ausland, ${code}.`;
    case 'domesticIban': return `Kundenzahlung ohne Rechnung, ${currency} von einem Konto im Inland (${invoicing().territory.join(', ')}): Inlandumsatz mit ${code}. ${asked}`;
    case 'domesticCurrency': return `Kundenzahlung ohne Rechnung in ${currency}, die Bank nennt kein Konto im Ausland: Inlandumsatz mit ${code}. ${asked}`;
    case 'foreignCurrency': return `Kundenzahlung ohne Rechnung in ${currency}: Umsatz im Ausland, ${code}. ${asked}`;
    case 'foreignIban': return `Kundenzahlung ohne Rechnung von einem Konto im Ausland: Umsatz im Ausland, ${code}. ${asked}`;
  }
}
