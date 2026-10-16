/**
 * What the Bilanz, the Erfolgsrechnung, the Saldobilanz and an account's ledger read: the journal,
 * and, where the jurisdiction shows the statements net within the year (statements.yaml `vat`),
 * the tax its VAT codes split off, derived at read time with the year close's own `vatPostings`
 * on the same VAT account. Nothing is written to the journal; the VAT return reads the codes alone.
 * So the in-year statements are the ones the year close (`closingLedger`) and Banana show at 31.12.
 */
import type { JournalEntry } from '../types/index.js';
import { statements } from '../engines/index.js';
import { vatPostings, yearEndAccounts } from './year-close.js';
import type { Postings } from './ledger.js';

export type { Postings };

/** The id prefix of a derived tax posting: `vat:<entry id>`. */
const DERIVED = 'vat:';

/** The entry a posting comes from: itself, or the entry whose code a derived tax posting splits. */
export const sourceEntryId = (p: Pick<JournalEntry, 'id'>): string => (p.id.startsWith(DERIVED) ? p.id.slice(DERIVED.length) : p.id);
export const isDerived = (p: Pick<JournalEntry, 'id'>): boolean => p.id.startsWith(DERIVED);

/** The VAT account the derived postings go to: the year close's (the first of year-end.yaml's candidates the chart has). */
export const statementVatAccount = (chart: readonly string[]): string => yearEndAccounts(chart).vatSettlement;

/** The journal plus, on a jurisdiction that is net, the tax its codes split off, on the chart's VAT account. */
export function statementPostings(entries: readonly JournalEntry[], chart: readonly string[]): Postings {
  const all = statements().vat === 'net' ? [...entries, ...vatPostings(entries, statementVatAccount(chart))] : [...entries];
  return all as unknown as Postings;
}
