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
import type { Question, SaleChoice, SaleGone, SaleProposal, SaleWhy } from '../questions/model.js';
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

/**
 * Why the app's question about the sale `ref` needs no answer any more: the payment is gone, its
 * quarter is filed (a correction in the open one books what is missing), or a receipt or an
 * invoice decides its VAT now (r4c-29). Undefined: the question still stands.
 */
export function saleQuestionGone(books: SaleBooks, ref: string): SaleGone | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return 'noPayment';
  const closed = books.config?.closedThrough;
  if (closed && tx.date <= closed) return 'closed';
  if (books.mappings.some((m) => m.transactionRef === ref)) return 'hasReceipt';
  if ((books.journalEntries ?? []).some((e) => e.transactionRef === ref && e.origin === 'invoice')) return 'hasInvoice';
  return undefined;
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

/** An order of a provider's order export the provider did not collect (another way of paying, #406): its money comes as a payment of its own. */
export interface PaidElsewhere { provider: string; order: string; gross: number; currency?: string; tax?: number; shipTo?: string }

/**
 * The proposal from the order the payment names (#406): an order of a provider's export the provider
 * did not collect, named in the payment's text by its «#» name («Bestellung #1099»), with the payment's amount. Its
 * tax shows its rate: the normal rate proposes a domestic sale, no tax on a delivery abroad an export.
 * Undefined when no such order is named, or its rate is one the sale question cannot book (a reduced
 * rate, several rates in one order): the question then proposes as without it.
 */
export function orderProposal(tx: Pick<BankTransaction, 'amount' | 'currency' | 'description' | 'reference' | 'counterparty'>, orders: readonly PaidElsewhere[]): SaleProposal | undefined {
  const text = [tx.description, tx.reference, tx.counterparty].filter(Boolean).join(' ');
  // Only the order's name as an order export writes it, with its «#»: a number alone may be a date, an invoice or a customer number (#406 review).
  const named = (o: PaidElsewhere) => new RegExp(`#\\s?${o.order.replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\d])`).test(text);
  const o = orders.find((x) => (x.currency ?? baseCurrency()) === tx.currency && Math.abs(Math.abs(x.gross) - Math.abs(tx.amount)) <= 0.005 && named(x));
  if (!o) return undefined;
  const name = `#${o.order.replace(/^#/, '')}`;
  const tax = o.tax ?? 0;
  if (Math.abs(tax) < 0.005) {
    const abroad = !!o.shipTo && !invoicing().territory.includes(o.shipTo.toUpperCase());
    return abroad ? { choice: 'saleAbroad', why: 'order', order: { provider: o.provider, name, rate: 0 } } : undefined;
  }
  const rate = normalRate();
  return Math.abs(foreignTaxIn(o.gross, rate) - Math.abs(tax)) <= 0.05 ? { choice: 'saleDomestic', why: 'order', order: { provider: o.provider, name, rate } } : undefined;
}

/** The foreign VAT inside the gross `gross` at `rate` percent, to the cent of the payment's currency. */
export const foreignTaxIn = (gross: number, rate: number): number => Math.round((Math.abs(gross) * 100 * rate) / (100 + rate)) / 100;

/**
 * The account a foreign VAT on a sale abroad goes onto, as the company said it: the one its last
 * answer booked it on, else the one its providers' files name (`provider.foreignTax`, the sales
 * report's, #206; `providers`). Undefined when it said none, or several, so the person names it once.
 */
export function foreignTaxAccount(providers: ReadonlySet<string>, questions: readonly Question[]): string | undefined {
  const answered = questions.filter((q) => q.status === 'answered').sort((a, b) => b.answer!.at.localeCompare(a.answer!.at));
  for (const q of answered) {
    const a = q.answer!.acted;
    if (a && 'foreignTax' in a && a.foreignTax) return a.foreignTax.account;
  }
  return providers.size === 1 ? [...providers][0] : undefined;
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

/**
 * The code and rate the answer «domestic sale» books: the normal rate, or on the net tax rate method the
 * firm's first approved rate (`net`), so the question names what it books. Undefined: no code.
 */
export function domesticSale(): { code: string; rate: number; net: boolean } | undefined {
  const code = saleVatCode('saleDomestic');
  if (!code) return undefined;
  return { code, rate: vat().codes.parse(code)?.rate ?? normalRate(), net: code !== vat().codes.saleAt(normalRate()) };
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
    case 'order': return `Kundenzahlung für eine Bestellung im Bestellexport des Zahlungsanbieters: ${code}. ${asked}`;
  }
}
