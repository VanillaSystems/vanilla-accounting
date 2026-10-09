/**
 * Foreign-currency → CHF conversion, the single source of truth for booking rates.
 *
 * Swiss VAT (MWSTG Art. 24) requires the ESTV daily SELL rate (or monthly average) at the
 * tax point; on cash basis that is the payment date. This resolver serves the ESTV daily
 * sell rate valid on a given date, with the ESTV weekend/holiday fallback ("apply the most
 * recently recorded daily rate"). Populate the rate file with `npm run fetch-rates`.
 *
 * Both `classify` (stamping rates on new entries) and `restamp-fx` (backfilling existing
 * ones) go through here, so the two can never drift. See docs/adr/0001-foreign-currency-conversion.md.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REFERENCE_DIR } from '../workspace/workspace.js';

const DAILY_RATES_FILE = 'estv-daily-rates-2026.json';
const FLAT_RATES_FILE = 'wechselkurse.txt'; // legacy per-currency fallback only

export interface FxResolver {
  /** ESTV daily sell rate for `currency` valid on `date` (YYYY-MM-DD), or undefined if unknown. */
  daily(currency: string, date: string): number | undefined;
  /** Legacy flat per-currency rate, used only as a last resort when no daily rate exists. */
  flat(currency: string): number | undefined;
}

/** `dir` holds the rate files: the app's reference/ unless a test points elsewhere. */
export function loadFxResolver(dir: string = REFERENCE_DIR): FxResolver {

  // Daily ESTV rates, keyed by the calendar date each rate is valid for.
  let rates: Record<string, Record<string, number | string>> = {};
  const dailyPath = join(dir, DAILY_RATES_FILE);
  if (existsSync(dailyPath)) {
    rates = JSON.parse(readFileSync(dailyPath, 'utf8')).rates ?? {};
  }
  const dates = Object.keys(rates).sort(); // ascending, for the fallback scan

  // Legacy flat rates (reference/wechselkurse.txt), only consulted when a daily rate is absent.
  const flatRates: Record<string, number> = { CHF: 1 };
  const flatPath = join(dir, FLAT_RATES_FILE);
  if (existsSync(flatPath)) {
    for (const line of readFileSync(flatPath, 'utf8').trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 5) flatRates[parts[1]] = parseFloat(parts[4]);
    }
  }

  return {
    daily(currency, date) {
      if (currency === 'CHF') return 1;
      const exact = rates[date]?.[currency];
      if (typeof exact === 'number') return exact;
      // ESTV fallback: most recently recorded rate on/before the payment date.
      for (let i = dates.length - 1; i >= 0; i--) {
        if (dates[i] <= date) {
          const r = rates[dates[i]]?.[currency];
          if (typeof r === 'number') return r;
        }
      }
      return undefined;
    },
    flat(currency) {
      return flatRates[currency];
    },
  };
}
