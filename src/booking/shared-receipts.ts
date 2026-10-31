/**
 * Receipts that pay several payments at once (#190 2b): the legs of a card charge split across
 * balances each hold the charge's receipts, and each books its own share. The input tax of all of
 * them together is what the receipts show, never more: a model that books the receipt's whole VAT
 * on each leg would claim it twice. The classify step tells the model the other legs and their
 * amounts, and refuses a booking whose input tax, with what the other legs book already, exceeds
 * the receipts' VAT (inputTaxOverReceipts). Pure.
 */
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import type { Books } from '../books/store.js';
import { baseCurrency } from '../engines/index.js';
import { vatInFigures } from '../accounting/vat-in-figures.js';
import { SPLIT_BAND, sameLeg } from '../intake/charges.js';

/**
 * The receipts linked to `tx` that other legs of its card charge hold too (`legs`, the movements of
 * its charge, src/intake/charges.ts: under refs of their own or under one ref, #287), and those legs:
 * undefined when it is no leg of a split charge or no other leg shares a receipt. A copy marked as
 * such counts for nothing. Only the legs of one charge: a contract linked to each monthly payment
 * shows each month's VAT, not one total.
 */
export function sharedReceipts(books: Pick<Books, 'mappings' | 'receipts'>, tx: BankTransaction, legs: readonly BankTransaction[]): { receipts: Receipt[]; others: BankTransaction[] } | undefined {
  if (legs.length < 2) return undefined;
  const own = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => m.receiptId));
  const others = legs.filter((t) => !sameLeg(t, tx) && books.mappings.some((m) => m.transactionRef === t.ref && own.has(m.receiptId)));
  const shared = new Set(books.mappings.filter((m) => own.has(m.receiptId) && others.some((t) => t.ref === m.transactionRef)).map((m) => m.receiptId));
  const receipts = books.receipts.filter((r) => shared.has(r.id) && r.kind !== 'duplicate');
  return receipts.length && others.length ? { receipts, others } : undefined;
}

/** The Swiss VAT a receipt shows, in the books' currency at the daily rate of its day; undefined when it is not read or not convertible. */
function vatShown(r: Receipt, rateOn: (currency: string, date: string) => number | undefined): number | undefined {
  if (r.hasSwissVat === false) return 0;
  const groups = (r.vatSummary ?? []).filter((g) => g.ratePercent > 0);
  if (!r.hasSwissVat || !groups.length || groups.some((g) => g.vat == null)) return undefined;
  const vat = groups.reduce((s, g) => s + g.vat, 0);
  const currency = r.currency ?? baseCurrency();
  if (currency === baseCurrency()) return vat;
  const rate = r.date ? rateOn(currency, r.date) : undefined;
  return rate === undefined ? undefined : vat * rate;
}

/**
 * Whether `entries`, the booking of `tx`, would claim more input tax than the receipts it shares
 * with the other legs of its charge show, together with what those legs book already: the input tax booked and the VAT shown, in
 * the books' currency, when it exceeds it by more than the legs' conversion at the official rate
 * explains (SPLIT_BAND, and 5 centimes). Undefined when no other leg shares a receipt, or a shared
 * receipt's VAT is not read: nothing to check against.
 */
export function inputTaxOverReceipts(books: Pick<Books, 'mappings' | 'receipts' | 'journalEntries'>, tx: BankTransaction, legs: readonly BankTransaction[], entries: readonly JournalEntry[], rateOn: (currency: string, date: string) => number | undefined): { booked: number; shown: number; others: BankTransaction[] } | undefined {
  const shared = sharedReceipts(books, tx, legs);
  if (!shared) return undefined;
  const each = shared.receipts.map((r) => vatShown(r, rateOn));
  if (each.some((v) => v === undefined)) return undefined;
  const shown = (each as number[]).reduce((s, v) => s + v, 0);
  const otherRefs = new Set(shared.others.map((t) => t.ref));
  const all = [...entries, ...books.journalEntries.filter((e) => otherRefs.has(e.transactionRef))];
  const booked = vatInFigures(all, '0000-01-01', '9999-12-31')?.input ?? 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return booked > shown * (1 + SPLIT_BAND) + 0.05 ? { booked: r2(booked), shown: r2(shown), others: shared.others } : undefined;
}
