/**
 * The VAT that bookings hold inside their gross amounts, by their codes, as the year close posts
 * it (vatPostings): Bilanz and Erfolgsrechnung say it under their figures where these are gross
 * within the year (r8c-2), the owner's own reports (src/reports) under the bookings' amounts.
 */
import type { JournalEntry } from '../types/index.js';
import { owesAcquisition, vatPostings } from './year-close.js';
import { vat, withoutInputTax } from '../engines/index.js';

/** The VAT the shown entries carry inside their gross amounts, on a jurisdiction whose statements are gross within the year (docs/year-end.md). */
export interface VatInFigures {
  /** Sales tax the codes owe, refunds and corrections taken off. */
  owed: number;
  /** Input tax the codes deduct. */
  input: number;
  /** Bezugsteuer owed without a deduction (the net tax rate method); 0 where it nets to zero. */
  acquisition: number;
  /** owed + acquisition − input: what the figures hold that the tax office gets. */
  net: number;
}

export type VatPart = 'reports.vatPart.owed' | 'reports.vatPart.input' | 'reports.vatPart.acquisition';

/**
 * The parts the VAT note names, in order: the sales tax, the input tax (always for a firm that
 * deducts it, else only when there is one), the Bezugsteuer when there is one (r9n-27).
 */
export function vatParts(v: VatInFigures): Array<{ key: VatPart; amount: number }> {
  return [
    { key: 'reports.vatPart.owed' as const, amount: v.owed },
    ...(v.input !== 0 || !withoutInputTax() ? [{ key: 'reports.vatPart.input' as const, amount: v.input }] : []),
    ...(v.acquisition !== 0 ? [{ key: 'reports.vatPart.acquisition' as const, amount: v.acquisition }] : []),
  ];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const VAT_MARK = 'vat';

/**
 * What the entries of `from`..`to` hold as VAT, by their codes, as the year close posts it
 * (vatPostings): undefined when no entry carries a code (a firm not registered, a period without
 * VAT). On a gross jurisdiction the Erfolgsrechnung's result and the Bilanz's accounts hold this amount (r8c-2).
 */
export function vatInFigures(entries: readonly JournalEntry[], from: string, to: string): VatInFigures | undefined {
  const postings = vatPostings(entries.filter((e) => e.date >= from && e.date <= to), VAT_MARK);
  if (!postings.length) return undefined;
  // Signed as the tax office sees it: a credit to the VAT account owes, a debit deducts or takes back.
  const signed = (p: (typeof postings)[number]) => (p.accountCredit === VAT_MARK ? p.amount : -p.amount);
  const sum = (ps: typeof postings) => r2(ps.reduce((s, p) => s + signed(p), 0));
  const kind = (p: (typeof postings)[number]) => { const info = vat().codes.parse(p.code)!; return owesAcquisition(info) ? 'acquisition' : info.inputTaxZiffer ? 'input' : 'owed'; };
  const owed = sum(postings.filter((p) => kind(p) === 'owed'));
  const input = r2(0 - sum(postings.filter((p) => kind(p) === 'input'))) || 0;
  const acquisition = sum(postings.filter((p) => kind(p) === 'acquisition'));
  return { owed, input, acquisition, net: r2(owed + acquisition - input) };
}
