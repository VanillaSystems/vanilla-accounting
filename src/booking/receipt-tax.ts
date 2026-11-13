/**
 * The input tax of a payment whose invoice states its tax in the books' currency: the tax the
 * invoice states, not one taken out of the payment, in two cases.
 *
 * A payment in a foreign currency: an invoice in the books' currency paid from a foreign-currency
 * account leaves an exchange difference between the converted payment and the invoice, and a gross
 * rate code on the payment's line would claim the tax of that difference too.
 *
 * A payment in the books' currency that pays its invoice rounded to 0.05 (#478, a phone bill of
 * 88.98 paid with 89.00): the input tax is the tax the invoice charged (MWSTG Art. 28), and
 * the gross rate code takes it out of the payment; when that differs from the tax the invoice
 * states, the invoice's figure rules and the rounding carries no tax. Only within ROUNDED_BY, so a
 * payment less a cash discount keeps its gross code: its tax is on what was paid (guide spl-skonto,
 * #397). Only when the stated tax lies within STATED_TAX_BAND of the code's: a figure farther off is
 * a misread, not the invoice's rounding. A payment whose code takes the invoice's tax anyway is left
 * as it is.
 *
 * Such a line keeps the payment, the account (and the official rate), and loses its rate code; a
 * single-leg line of the tax-amount code (amount = the tax, docs/runbooks/booking-patterns.md)
 * credits that account by the invoice's tax. The bank side stays the payment, the account carries
 * the net and the exchange or rounding difference.
 *
 * An invoice in a foreign payment's currency keeps the conversion as it is: its tax converts at the
 * official rate like the payment. Only purchases on the cash basis: a refund, and a line the agreed
 * basis books on its invoice's date (src/accounting/tax-point.ts), keep the gross code. Pure.
 */
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { agreedBasis, baseCurrency, vat } from '../engines/index.js';
import { toRappen } from '../accounting/rappen.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';

/**
 * How far the converted line may lie from the invoice total and still pay that invoice whole: the
 * official rate against the rate the bank applied, and a transfer fee inside the payment. Farther
 * off, the payment pays a part (a private share, a partial payment) and the invoice's tax is not its.
 */
export const RECEIPT_TAX_BAND = 0.05;

/** How far a payment in the books' currency may lie from its invoice's total and still pay it whole: the total rounded to 0.05. */
export const ROUNDED_BY = 0.025;

/** How far an invoice's stated tax may lie from the tax its gross code takes out of the payment: the rounding of an invoice's lines, not a misread figure. */
export const STATED_TAX_BAND = 0.1;

const cents = (n: number) => Math.round(n * 100) / 100;

/** The tax-amount code of a gross input-tax code with a rate (no acquisition tax, no refund), else undefined. */
function taxAmountOf(code: string | undefined): string | undefined {
  const info = code ? vat().codes.parse(code) : null;
  if (!info || !info.inputTaxZiffer || info.acquisitionZiffer || info.amountIs !== 'gross' || info.isNegative || !(info.rate > 0)) return undefined;
  return vat().codes.taxAmountCode(code!);
}

/**
 * `entries`, the booking of `tx`, with the tax its linked invoices state in the books' currency in
 * place of the tax a gross rate code would take out of the payment. Applies when every linked
 * purchase document is in the books' currency, read, with domestic tax, and states its total; and
 * that total matches the coded lines: converted within RECEIPT_TAX_BAND of a foreign payment, within
 * ROUNDED_BY of one in the books' currency. Per rate, only when one line carries that rate.
 * The tax line's reason is receiptTaxReason.
 */
export function withReceiptTax(tx: BankTransaction, entries: JournalEntry[], documents: readonly Receipt[], newId: () => string): JournalEntry[] {
  const base = baseCurrency();
  if (tx.direction !== 'DBIT' || agreedBasis()) return entries;
  const foreign = tx.currency !== base;
  const receipts = documents.filter(isPurchaseDocument);
  if (!receipts.length || receipts.some((r) => (r.currency ?? base) !== base || !r.hasSwissVat || !r.vatSummary?.length || r.amount === undefined)) return entries;
  const coded = entries.filter((e) => (foreign ? e.exchangeRate !== undefined : e.exchangeRate === undefined) && taxAmountOf(e.vatCode));
  if (!coded.length) return entries;
  const total = receipts.reduce((s, r) => s + Math.abs(r.amount!), 0);
  const paid = coded.reduce((s, e) => s + e.amount * (e.exchangeRate ?? 1), 0);
  if (Math.abs(paid - total) > (foreign ? total * RECEIPT_TAX_BAND : ROUNDED_BY + 1e-9)) return entries;
  const rateOf = (e: JournalEntry) => vat().codes.parse(e.vatCode!)!.rate;
  const out: JournalEntry[] = [];
  for (const e of entries) {
    const code = coded.includes(e) ? taxAmountOf(e.vatCode) : undefined;
    const rate = code ? rateOf(e) : 0;
    const alone = code && coded.filter((c) => rateOf(c) === rate).length === 1;
    const tax = alone ? cents(receipts.flatMap((r) => r.vatSummary!).filter((g) => g.ratePercent === rate).reduce((s, g) => s + g.vat, 0)) : 0;
    if (!code || !(tax > 0) || (!foreign && !differs(e, tax))) { out.push(e); continue; }
    const { vatCode: _gross, ...rest } = e;
    const { exchangeCurrency: _c, exchangeRate: _r, ...unconverted } = rest;
    out.push(rest, { ...unconverted, id: newId(), accountDebit: '', accountCredit: e.accountDebit, amount: tax, vatCode: code, reason: receiptTaxReason(tax, rate, foreign), by: { kind: 'code', check: 'purchaseVat' } });
  }
  return out;
}

/** Whether the tax an invoice states is not the one the gross code of line `e` takes, and near enough to it to be the invoice's own rounding. */
function differs(e: JournalEntry, stated: number): boolean {
  const { rate } = vat().codes.parse(e.vatCode!)!;
  // As the return takes it (src/engines/return.ts taxOf): the gross less its net, in hundredths.
  const gross = toRappen(Math.abs(e.amount));
  const gap = Math.abs(toRappen(stated) - (gross - Math.round((gross * 100) / (100 + rate))));
  return gap > 0 && gap <= toRappen(STATED_TAX_BAND);
}

/** Why the input tax of a payment is the invoice's own: in the books' currency for a foreign payment, the invoice's figure for a rounded one. */
export const receiptTaxReason = (tax: number, rate: number, foreign: boolean) => foreign
  ? `Der Beleg weist die Steuer in ${baseCurrency()} aus: ${tax.toFixed(2)} zu ${rate} % als Vorsteuer, wie auf dem Beleg, nicht aus der umgerechneten Zahlung gerechnet.`
  : `Der Beleg weist ${tax.toFixed(2)} Steuer zu ${rate} % aus: so viel als Vorsteuer, nicht aus der auf 0.05 gerundeten Zahlung gerechnet; die Rundung ohne Vorsteuer.`;
