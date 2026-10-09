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
import { estvRates, type EstvRateTable } from './fx-conversion.js';

const DAILY_RATES_FILE = 'estv-daily-rates-2026.json';
const FLAT_RATES_FILE = 'wechselkurse.txt'; // legacy per-currency fallback only

export interface FxResolver {
  /** ESTV daily sell rate for `currency` valid on `date` (YYYY-MM-DD), or undefined if unknown. */
  daily(currency: string, date: string): number | undefined;
  /** Legacy flat per-currency rate, used only as a last resort when no daily rate exists. */
  flat(currency: string): number | undefined;
}

/** The ESTV daily sell rates in `dir` (the app's reference/), or an empty table before `npm run fetch-rates`. */
export function readEstvRateTable(dir: string = REFERENCE_DIR): EstvRateTable {
  const path = join(dir, DAILY_RATES_FILE);
  if (!existsSync(path)) return { rates: {} };
  const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<EstvRateTable>;
  return { fetchedAt: file.fetchedAt, rates: file.rates ?? {} };
}

/** `dir` holds the rate files: the app's reference/ unless a test points elsewhere. */
export function loadFxResolver(dir: string = REFERENCE_DIR): FxResolver {
  const estv = estvRates(readEstvRateTable(dir));

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
      return currency === 'CHF' ? 1 : estv.on(currency, date)?.rate;
    },
    flat(currency) {
      return flatRates[currency];
    },
  };
}
