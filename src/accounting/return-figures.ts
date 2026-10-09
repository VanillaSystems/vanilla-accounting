import type { JournalEntry, QuarterKey, VatAdjustment } from '../types/index.js';
import { computeVatReport, computeVatReportLines } from './vat-report.js';
import { INPUT_TAX, TAX_RATE_ROWS, TURNOVER_DEDUCTIONS, VARIOUS_DEDUCTION, taxOf } from './ziffern.js';
import { roundCHF } from './rappen.js';

/**
 * A quarter's VAT return as filed with the ESTV (eCH-0217, effective method,
 * grossOrNet = 2), keyed by form Ziffer. The same shape comes from two sources:
 * a filed XML (parseFiledReturn) and today's books (figuresFromBooks), so a
 * Korrekturabrechnung (form 0535) compares like with like.
 *
 * A tax-rate row (TAX_RATE_ROWS) holds its turnover, not its tax: gross for
 * supplies, net for Bezugsteuer. taxOf() derives the tax.
 */
export interface ReturnFigures {
  period: QuarterKey;
  ziffern: Record<string, number>;
}


/**
 * Fills in the derived Ziffern (289, 299, 399, 479, 500, 510) from the declared ones.
 * The payable tax is computed the eCH way: tax on each rate's total turnover, not the
 * per-entry tax sum (rules 7.5/7.6, error MWST-0006).
 */
export function completeFigures(period: QuarterKey, declared: Record<string, number>): ReturnFigures & { payable: number } {
  const z = (n: string) => declared[n] ?? 0;
  const z289 = roundCHF(TURNOVER_DEDUCTIONS.reduce((s, [n]) => s + z(n), 0) + z(VARIOUS_DEDUCTION.ziffer));
  const owed = TAX_RATE_ROWS.reduce((s, row) => s + taxOf(row, z(row.ziffer)), 0);
  const z479 = roundCHF(INPUT_TAX.reduce((s, [n, , , sign]) => s + sign * z(n), 0));
  const payable = roundCHF(INPUT_TAX.reduce((s, [n, , , sign]) => s - sign * z(n), owed));
  return {
    period,
    payable,
    ziffern: {
      ...declared,
      '289': z289,
      '299': roundCHF(z('200') - z289),
      '399': roundCHF(owed),
      '479': z479,
      '500': Math.max(0, payable),
      '510': Math.max(0, roundCHF(-payable)),
    },
  };
}

/** The return today's books declare for a quarter: what `npm run vat-xml` would file. */
export function figuresFromBooks(entries: JournalEntry[], period: QuarterKey, adjustments: VatAdjustment[]): ReturnFigures & { payable: number } {
  const rep = computeVatReport(entries, period, adjustments);
  const lines = computeVatReportLines(entries, period, adjustments);
  const z = (n: string) => rep.ziffern.find((x) => x.number === n)?.amount ?? 0;
  const declared: Record<string, number> = { '200': z('200'), [VARIOUS_DEDUCTION.ziffer]: z(VARIOUS_DEDUCTION.ziffer) };
  for (const [n] of [...TURNOVER_DEDUCTIONS, ...INPUT_TAX]) declared[n] = z(n);
  for (const row of TAX_RATE_ROWS) {
    const field = row.kind === 'supply' ? 'gross' : 'base';
    declared[row.ziffer] = roundCHF((lines[row.ziffer] ?? []).reduce((s, l) => s + l[field], 0));
  }
  return completeFigures(period, declared);
}
