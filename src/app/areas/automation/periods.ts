/** The periods Automatisierung's overview offers to look at. */
import { filingKeyOf, parsePeriod, type Period } from '../../../accounting/periods.js';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The filing periods of the shown year and the year before that have begun, none that ended before
 * the books' first day `first` (#362: fresh books of 2026 offered Q1–Q4 2025); the shown one always.
 */
export function periodsAround(p: Period, today: string, first: string | undefined, length: Parameters<typeof filingKeyOf>[1]): Period[] {
  const year = Number(p.from.slice(0, 4));
  const keys = [year - 1, year].flatMap((y) => Array.from({ length: 12 }, (_, m) => filingKeyOf(`${y}-${pad(m + 1)}-01`, length)));
  return [...new Set(keys)].map((k) => parsePeriod(k, today)!).filter((x) => x.token === p.token || (x.from <= today && (!first || x.to >= first)));
}
