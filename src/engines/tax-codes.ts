/**
 * Reads a tax code against a jurisdiction's tax-codes data and the form the firm files: its rate,
 * its sign, what its amount is, and the boxes it feeds. A code the form does not take (a box it
 * lacks, or a list of codes it names) is unknown to the firm, so no booking path can give it. A
 * net-rate code's rate is the firm's approved rate. Pure, browser-safe, the same for every jurisdiction.
 */
import type { BoxId, ReturnData, TaxCodesData } from '../core/modules/schema.js';
import type { NetRate } from '../workspace/vat-setup.js';

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
  /** The net tax rate method: the tax is `rate` percent of the gross amount, not taken out of it. */
  flatOnGross?: true;
}

type Meaning = Omit<TaxCodeInfo, 'code' | 'isNegative' | 'amountIs'>;

export interface TaxCodeEngine {
  /** The code's meaning, or null when the jurisdiction does not know it or the firm's form does not take it. */
  parse(code: string): TaxCodeInfo | null;
  /** Every code with a fixed meaning the form takes, in catalogue order. Pattern codes are not listed. */
  named: readonly string[];
  /** The boxes an entry with this code feeds, the turnover box first. */
  sourceBoxes(info: TaxCodeInfo): BoxId[];
  /** By meaning: the first catalogue code that books a sale at the statutory rate `rate`. */
  saleAt(rate: number): string | undefined;
  /** By meaning: the code of the firm's n-th approved net rate (the net tax rate method). */
  netRateCode(n: 1 | 2): string | undefined;
  /** The prefix that makes a code a refund or reversal. */
  negativePrefix: string;
  /** Where a purchase's input tax goes, by the income section of its account. */
  purchaseBoxes: TaxCodesData['purchaseBoxes'];
  /** By meaning: the first catalogue code that deducts input tax at `rate` in `box` (no acquisition tax). */
  purchaseAt(rate: number, box: BoxId): string | undefined;
  /** By meaning: the first catalogue code whose turnover is deducted in `box`. */
  deductedIn(box: BoxId): string | undefined;
}

export function taxCodeEngine(data: TaxCodesData, form: Pick<ReturnData, 'codes' | 'turnoverBox' | 'rateOrder' | 'deductions' | 'inputTax'>, netRates: readonly NetRate[] = []): TaxCodeEngine {
  const suffixRe = new RegExp(`^(${data.amountSuffix.families.join('|')})\\d+(${esc(data.amountSuffix.net)}|${esc(data.amountSuffix.tax)})$`);
  const patterns = data.patterns.map((p) => ({ ...p, re: new RegExp(p.match) }));
  const boxes = new Set<BoxId>([...form.rateOrder, ...Object.keys(form.deductions), ...Object.keys(form.inputTax)]);
  const taken = form.codes ? new Set(form.codes) : undefined;
  const takes = (code: string) => !taken || taken.has(code);
  const keep = (z: BoxId | undefined) => (z !== undefined && boxes.has(z) ? z : undefined);

  function meaningOf(clean: string): Meaning | null {
    if (!takes(clean)) return null;
    const nr = data.netRateCodes?.[clean];
    if (nr) {
      const rate = netRates[nr.netRate - 1];
      return rate && boxes.has(nr.revenue) ? { rate: rate.rate, revenueZiffer: nr.revenue, flatOnGross: true } : null;
    }
    const m = data.codes[clean];
    if (m) {
      const named = [m.revenue, m.deduction, m.inputTax, m.correction, m.acquisition].filter((z) => z !== undefined);
      const kept = named.filter((z) => boxes.has(z));
      // A code whose boxes the form lacks is not this firm's; a form without a list takes a code only whole.
      if (named.length && (!kept.length || (!taken && kept.length < named.length))) return null;
      return {
        rate: m.rate,
        ...(keep(m.revenue) ? { revenueZiffer: m.revenue } : {}),
        ...(keep(m.deduction) ? { deductionZiffer: m.deduction } : {}),
        ...(keep(m.inputTax) ? { inputTaxZiffer: m.inputTax } : {}),
        ...(keep(m.correction) ? { correctionZiffer: m.correction } : {}),
        ...(keep(m.acquisition) ? { acquisitionZiffer: m.acquisition } : {}),
      };
    }
    for (const p of patterns) {
      const hit = p.re.exec(clean);
      if (hit) {
        const box = p.correction[hit[p.correctionGroup]];
        return boxes.has(box) ? { rate: (parseFloat(hit[p.rateGroup]) || 0) / p.rateDivisor, correctionZiffer: box } : null;
      }
    }
    return null;
  }

  const named = [...Object.keys(data.codes), ...Object.keys(data.netRateCodes ?? {})].filter((c) => meaningOf(c) !== null);
  const meanings = named.map((code) => [code, meaningOf(code)!] as const);
  return {
    named,
    saleAt: (rate) => meanings.find(([, m]) => m.revenueZiffer && !m.flatOnGross && m.rate === rate)?.[0],
    netRateCode: (n) => Object.entries(data.netRateCodes ?? {}).find(([code, m]) => m.netRate === n && meaningOf(code))?.[0],
    negativePrefix: data.negativePrefix,
    purchaseBoxes: data.purchaseBoxes,
    purchaseAt: (rate, box) => meanings.find(([, m]) => m.inputTaxZiffer === box && !m.acquisitionZiffer && m.rate === rate)?.[0],
    deductedIn: (box) => meanings.find(([, m]) => m.deductionZiffer === box)?.[0],
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
        info.revenueZiffer || info.deductionZiffer ? form.turnoverBox : undefined,
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
