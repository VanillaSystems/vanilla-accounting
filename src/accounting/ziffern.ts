import type { VatRateGroup } from '../types/index.js';

/**
 * The Ziffern of the MWST return (effective method) and the VAT codes that feed them.
 * One model for every consumer: the report the MWST tab and `npm run vat-report` show,
 * the figures `npm run vat-xml` files, the parsed filed returns, and the receipt check.
 */

export interface TaxRateRow {
  ziffer: string;
  rate: number;
  /** Supplies are reported gross (grossOrNet = 2); Bezugsteuer is always net (eCH-0217 5.3.3). */
  kind: 'supply' | 'acquisition';
  /** The Banana VAT code (reference/MWST-codes.txt) that books into this row. */
  vatCode: string;
  /** The rate's name on the ESTV form. */
  name: string;
  /** A rate superseded at the end of 2023: the form shows its row only when it has a figure. */
  superseded?: boolean;
}

/** The tax-rate rows of section II, in the order form 0535 prints them: current rates first. */
export const TAX_RATE_ROWS: readonly TaxRateRow[] = [
  { ziffer: '303', rate: 8.1, kind: 'supply', vatCode: 'V81', name: 'Normalsatz' },
  { ziffer: '313', rate: 2.6, kind: 'supply', vatCode: 'V26', name: 'Reduzierter Satz' },
  { ziffer: '343', rate: 3.8, kind: 'supply', vatCode: 'V38', name: 'Beherbergungssatz' },
  { ziffer: '302', rate: 7.7, kind: 'supply', vatCode: 'V77', name: 'Normalsatz', superseded: true },
  { ziffer: '312', rate: 2.5, kind: 'supply', vatCode: 'V25-N', name: 'Reduzierter Satz', superseded: true },
  { ziffer: '342', rate: 3.7, kind: 'supply', vatCode: 'V37', name: 'Beherbergungssatz', superseded: true },
  { ziffer: '383', rate: 8.1, kind: 'acquisition', vatCode: 'B81', name: 'Bezugsteuer' },
  { ziffer: '382', rate: 7.7, kind: 'acquisition', vatCode: 'B77', name: 'Bezugsteuer', superseded: true },
];

export const rateLabel = (row: TaxRateRow) => `${row.kind === 'supply' ? 'Leistungen' : 'Bezugsteuer'} ${row.rate}%`;

/** Every Swiss MWST rate, current and superseded. A foreign rate (19%, 20%) is not one. */
export const SWISS_VAT_RATES: ReadonlySet<number> = new Set(TAX_RATE_ROWS.map((r) => r.rate));

/**
 * Whether a receipt charged Swiss MWST: only when it shows a positive Swiss rate. A 0%-only
 * summary or a foreign rate does not count, even under a CHE- UID in the seller's letterhead.
 * When no rate could be parsed at all (poor OCR), the model's own call decides.
 */
export function deriveHasSwissVat(summary: VatRateGroup[], llmSaidYes: boolean): boolean {
  if (summary.some((g) => g.ratePercent > 0 && SWISS_VAT_RATES.has(g.ratePercent))) return true;
  return summary.length === 0 ? llmSaidYes : false;
}

/**
 * Turnover deductions (Ziffer 289's parts) that are a plain amount, in eCH-0217 schema
 * order, with the zero-rate sales code that books into each.
 */
export const TURNOVER_DEDUCTIONS: ReadonlyArray<readonly [ziffer: string, element: string, label: string, vatCode?: string]> = [
  ['220', 'suppliesToForeignCountries', 'Steuerbefreite Leistungen (Exporte)', 'V0'],
  ['221', 'suppliesAbroad', 'Leistungen im Ausland', 'V0-E'],
  ['225', 'transferNotificationProcedure', 'Übertragungen im Meldeverfahren', 'V0-T'],
  ['230', 'suppliesExemptFromTax', 'Nicht steuerbare Leistungen', 'V0-N'],
  ['235', 'reductionOfConsideration', 'Entgeltsminderungen'],
];

/** Ziffer 280 is a deduction too, but eCH-0217 has no plain element for it (variousDeduction is complex). */
export const VARIOUS_DEDUCTION = { ziffer: '280', label: 'Diverse Abzüge', vatCode: 'V0-D' } as const;

/** Input-tax Ziffern and their eCH-0217 elements, in schema order. 415/420 reduce the input tax. */
export const INPUT_TAX: ReadonlyArray<readonly [ziffer: string, element: string, label: string, sign: 1 | -1]> = [
  ['400', 'inputTaxMaterialAndServices', 'Vorsteuer Material/Dienstleistungen', 1],
  ['405', 'inputTaxInvestments', 'Vorsteuer Investitionen/Betriebsaufwand', 1],
  ['410', 'subsequentInputTaxDeduction', 'Einlageentsteuerung', 1],
  ['415', 'inputTaxCorrections', 'Vorsteuerkorrekturen', -1],
  ['420', 'inputTaxReductions', 'Vorsteuerkürzungen', -1],
];

/** The tax on a rate row's turnover, full precision. */
export function taxOf(row: TaxRateRow, turnover: number): number {
  return row.kind === 'supply' ? turnover * row.rate / (100 + row.rate) : turnover * row.rate / 100;
}
