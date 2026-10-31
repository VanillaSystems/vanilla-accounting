/**
 * The cards of Firma › Perioden und Siegel for one year: the firm's filing periods (quarters, or
 * half years on the net tax rate method), or the year itself for a firm that files no return and
 * whose year the year close seals (r6f-14). The state is what the card says under the name.
 */
import { addDays, filingKeyOf, parsePeriod, type IsoDate, type Period } from '../../../accounting/periods.js';
import { chargesVat, filing } from '../../../engines/index.js';

export type PeriodCard = {
  /** The seal's and the filing's key («2026-Q2», «2026-H1»; a firm without returns: the key of the seal the year close writes). */
  key: string;
  label: { kind: 'quarter'; n: number } | { kind: 'half'; n: number } | { kind: 'year' };
  range: Period;
  state: 'filed' | 'due' | 'runs' | 'later' | 'closesWithYear';
  /** The return's due date, when `due`. */
  due?: IsoDate;
};

export function periodCards(year: string, today: IsoDate, filed: ReadonlySet<string>): PeriodCard[] {
  if (!chargesVat()) {
    const range = parsePeriod(year, today)!;
    const key = filingKeyOf(`${year}-12-31`, filing().length);
    return [{ key, label: { kind: 'year' }, range, state: range.to < today ? 'closesWithYear' : 'runs' }];
  }
  const half = filing().length === 'half';
  return (half ? [1, 2] : [1, 2, 3, 4]).map((n) => {
    const key = `${year}-${half ? 'H' : 'Q'}${n}`;
    const range = parsePeriod(key, today)!;
    const due = addDays(range.to, filing().dueDays);
    const state: PeriodCard['state'] = filed.has(key) ? 'filed' : range.to < today ? 'due' : range.from <= today ? 'runs' : 'later';
    return { key, label: half ? { kind: 'half', n } : { kind: 'quarter', n }, range, state, ...(state === 'due' ? { due } : {}) };
  });
}
