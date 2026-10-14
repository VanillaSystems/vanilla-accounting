import type { JournalEntry } from '../types/index.js';
import { derivePeriod, isFilingKey, type FilingLength } from './periods.js';

/** The dates a VAT report key spans: YYYY-MM, YYYY-Qn, YYYY-Hn, YYYY, or 'all'. */
export function reportRange(key: string): { from: string; to: string } {
  if (key === 'all') return { from: '0000-01-01', to: '9999-12-31' };
  const p = derivePeriod(key);
  if (!p) throw new Error(`Unknown VAT period "${key}". Use YYYY-MM, YYYY-Qn, YYYY-Hn, YYYY or all.`);
  return p;
}

/**
 * The journal entries a VAT report declares. This is the only place the rule lives.
 *
 * A filing period's return (a quarter, for the effective method) declares the entries dated in
 * it, except those that correct an earlier period, plus every entry that corrects this period,
 * whatever its date: a correction is booked in an open period but declared in the
 * Korrekturabrechnung (form 0535) of the period it corrects.
 *
 * Any other key (a sum of filing periods, 'all') is the true range: every entry dated in it,
 * corrections included.
 */
export function entriesForReturn(entries: JournalEntry[], key: string, length: FilingLength): JournalEntry[] {
  const { from, to } = reportRange(key);
  const dated = (e: JournalEntry) => !!e.date && e.date >= from && e.date <= to;
  if (!isFilingKey(key, length)) return entries.filter(dated);
  return entries.filter((e) => (e.corrects ? e.corrects === key : dated(e)));
}
