/**
 * The input tax of a payment in a foreign currency whose invoice states its tax in the books'
 * currency: the tax the invoice states, not one taken out of the payment converted at the official
 * daily rate. An invoice in the books' currency paid from a foreign-currency account leaves an
 * exchange difference between the converted payment and the invoice, and a gross rate code on the
 * payment's line would claim the tax of that difference too. Such a line keeps the payment, the
 * account and the official rate, and loses its rate code; a single-leg line of the tax-amount code
 * (amount = the tax, docs/runbooks/booking-patterns.md) credits that account by the invoice's tax.
 * The bank side stays the payment, the account carries the net and the exchange difference.
 *
 * An invoice in the payment's currency keeps the conversion as it is: its tax converts at the
 * official rate like the payment. Only purchases on the cash basis: a refund, and a line the agreed
 * basis books on its invoice's date (src/accounting/tax-point.ts), keep the gross code. Pure.
 */
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { agreedBasis, baseCurrency, vat } from '../engines/index.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';

/**
 * How far the converted line may lie from the invoice total and still pay that invoice whole: the
 * official rate against the rate the bank applied, and a transfer fee inside the payment. Farther
 * off, the payment pays a part (a private share, a partial payment) and the invoice's tax is not its.
 */
export const RECEIPT_TAX_BAND = 0.05;

const cents = (n: number) => Math.round(n * 100) / 100;

/** The tax-amount code of a gross input-tax code with a rate (no acquisition tax, no refund), else undefined. */
function taxAmountOf(code: string | undefined): string | undefined {
  const info = code ? vat().codes.parse(code) : null;
  if (!info || !info.inputTaxZiffer || info.acquisitionZiffer || info.amountIs !== 'gross' || info.isNegative || !(info.rate > 0)) return undefined;
  return vat().codes.taxAmountCode(code!);
}

/**
 * `entries`, the booking of `tx`, with the tax its linked invoices state in the books' currency in
 * place of the tax a gross rate code would take out of the converted payment. Applies when every
 * linked purchase document is in the books' currency, read, with domestic tax, and its total matches
 * the coded lines within RECEIPT_TAX_BAND; per rate, only when one line carries that rate.
 * `reason(tax, rate)`: the tax line's reason.
 */
export function withReceiptTax(tx: BankTransaction, entries: JournalEntry[], documents: readonly Receipt[], newId: () => string, reason: (tax: number, rate: number) => string): JournalEntry[] {
  const base = baseCurrency();
  if (tx.currency === base || tx.direction !== 'DBIT' || agreedBasis()) return entries;
  const receipts = documents.filter(isPurchaseDocument);
  if (!receipts.length || receipts.some((r) => (r.currency ?? base) !== base || !r.hasSwissVat || !r.vatSummary?.length || r.amount === undefined)) return entries;
  const coded = entries.filter((e) => e.exchangeRate !== undefined && taxAmountOf(e.vatCode));
  if (!coded.length) return entries;
  const total = receipts.reduce((s, r) => s + Math.abs(r.amount!), 0);
  const converted = coded.reduce((s, e) => s + e.amount * e.exchangeRate!, 0);
  if (Math.abs(converted - total) > total * RECEIPT_TAX_BAND) return entries;
  const rateOf = (e: JournalEntry) => vat().codes.parse(e.vatCode!)!.rate;
  const out: JournalEntry[] = [];
  for (const e of entries) {
    const code = coded.includes(e) ? taxAmountOf(e.vatCode) : undefined;
    const rate = code ? rateOf(e) : 0;
    const alone = code && coded.filter((c) => rateOf(c) === rate).length === 1;
    const tax = alone ? cents(receipts.flatMap((r) => r.vatSummary!).filter((g) => g.ratePercent === rate).reduce((s, g) => s + g.vat, 0)) : 0;
    if (!code || !(tax > 0)) { out.push(e); continue; }
    const { vatCode: _gross, ...rest } = e;
    const { exchangeCurrency: _c, exchangeRate: _r, ...unconverted } = rest;
    out.push(rest, { ...unconverted, id: newId(), accountDebit: '', accountCredit: e.accountDebit, amount: tax, vatCode: code, reason: reason(tax, rate), by: { kind: 'code', check: 'purchaseVat' } });
  }
  return out;
}
