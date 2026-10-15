/**
 * Reads a tax code against a jurisdiction's tax-codes data: its rate, its sign, what its amount
 * is, and the boxes it feeds. Pure, browser-safe, the same for every jurisdiction.
 */
import type { BoxId, TaxCodesData } from '../core/modules/schema.js';

export interface TaxCodeInfo {
  code: string;
  rate: number;
  isNegative: boolean;
  revenueZiffer?: BoxId;
  deductionZiffer?: BoxId;
  inputTaxZiffer?: BoxId;
  correctionZiffer?: BoxId;
  acquisitionZiffer?: BoxId;
  /** What the entry's amount is: gross (tax included), net (excluded), or the tax itself. */
  amountIs: 'gross' | 'net' | 'tax';
}

export interface TaxCodeEngine {
  /** The code's meaning, or null when the jurisdiction does not know it. */
  parse(code: string): TaxCodeInfo | null;
  /** Every code with a fixed meaning, in catalogue order. Pattern codes are not listed. */
  named: readonly string[];
  /** The boxes an entry with this code feeds, the turnover box first. */
  sourceBoxes(info: TaxCodeInfo): BoxId[];
  /** By meaning: the first catalogue code that books a sale at `rate`. */
  saleAt(rate: number): string | undefined;
  /** The prefix that makes a code a refund or reversal. */
  negativePrefix: string;
  /** Where a purchase's input tax goes, by the income section of its account. */
  purchaseBoxes: TaxCodesData['purchaseBoxes'];
  /** By meaning: the first catalogue code that deducts input tax at `rate` in `box` (no acquisition tax). */
  purchaseAt(rate: number, box: BoxId): string | undefined;
  /** By meaning: the first catalogue code whose turnover is deducted in `box`. */
  deductedIn(box: BoxId): string | undefined;
}

export function taxCodeEngine(data: TaxCodesData, turnoverBox: BoxId): TaxCodeEngine {
  const suffixRe = new RegExp(`^(${data.amountSuffix.families.join('|')})\\d+(${esc(data.amountSuffix.net)}|${esc(data.amountSuffix.tax)})$`);
  const patterns = data.patterns.map((p) => ({ ...p, re: new RegExp(p.match) }));

  function meaningOf(clean: string): Omit<TaxCodeInfo, 'code' | 'isNegative' | 'amountIs'> | null {
    const m = data.codes[clean];
    if (m) {
      return {
        rate: m.rate,
        ...(m.revenue ? { revenueZiffer: m.revenue } : {}),
        ...(m.deduction ? { deductionZiffer: m.deduction } : {}),
        ...(m.inputTax ? { inputTaxZiffer: m.inputTax } : {}),
        ...(m.correction ? { correctionZiffer: m.correction } : {}),
        ...(m.acquisition ? { acquisitionZiffer: m.acquisition } : {}),
      };
    }
    for (const p of patterns) {
      const hit = p.re.exec(clean);
      if (hit) return { rate: (parseFloat(hit[p.rateGroup]) || 0) / p.rateDivisor, correctionZiffer: p.correction[hit[p.correctionGroup]] };
    }
    return null;
  }

  const entries = Object.entries(data.codes);
  return {
    named: Object.keys(data.codes),
    saleAt: (rate) => entries.find(([, m]) => m.revenue && m.rate === rate)?.[0],
    negativePrefix: data.negativePrefix,
    purchaseBoxes: data.purchaseBoxes,
    purchaseAt: (rate, box) => entries.find(([, m]) => m.inputTax === box && !m.acquisition && m.rate === rate)?.[0],
    deductedIn: (box) => entries.find(([, m]) => m.deduction === box)?.[0],
    parse(code) {
      if (!code) return null;
      const isNegative = code.startsWith(data.negativePrefix);
      const unsigned = isNegative ? code.slice(data.negativePrefix.length) : code;
      const suffix = suffixRe.exec(unsigned)?.[2];
      const amountIs: TaxCodeInfo['amountIs'] = suffix === data.amountSuffix.tax ? 'tax' : suffix === data.amountSuffix.net ? 'net' : 'gross';
      const clean = suffix ? unsigned.slice(0, -suffix.length) : unsigned;
      const m = meaningOf(clean);
      return m ? { code, isNegative, ...m, amountIs } : null;
    },
    sourceBoxes(info) {
      return [
        info.revenueZiffer || info.deductionZiffer ? turnoverBox : undefined,
        info.revenueZiffer,
        info.deductionZiffer,
        info.rate > 0 ? info.inputTaxZiffer : undefined,
        info.correctionZiffer,
        info.acquisitionZiffer,
      ].filter((z): z is string => !!z);
    },
  };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
