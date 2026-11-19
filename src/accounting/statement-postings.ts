/**
 * What the Bilanz, the Erfolgsrechnung, the Saldobilanz and an account's ledger read: the journal,
 * and, where the jurisdiction shows the statements net within the year (statements.yaml `vat`),
 * the tax its VAT codes split off, derived at read time with the year close's own `vatPostings`
 * on the same VAT account. Nothing is written to the journal; the VAT return reads the codes alone.
 * So the in-year statements are the ones the year close (`closingLedger`) and Banana show at 31.12.
 */
import type { JournalEntry } from '../types/index.js';
import { statements } from '../engines/index.js';
import { vatPostingOf, vatPostings, yearEndAccounts } from './year-close.js';
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

/**
 * Where one entry's tax goes, as the statements and the year close post it (`vatPostingOf` on
 * `statementVatAccount`): the tax, the VAT account and the side it lands on. `fillsEmpty`: the
 * entry leaves that side empty (a code whose amount is the tax itself), so the VAT account is
 * its counter side; otherwise the code splits the tax off the account on the other side.
 */
export interface VatSplit {
  tax: number;
  account: string;
  side: 'debit' | 'credit';
  fillsEmpty: boolean;
}

export function vatSplitOf(e: JournalEntry, chart: readonly string[]): VatSplit | null {
  const account = statementVatAccount(chart);
  const p = vatPostingOf(e, account);
  if (!p) return null;
  const side = p.accountDebit === account ? 'debit' : 'credit';
  const carrier = side === 'debit' ? p.accountCredit : p.accountDebit;
  const own = side === 'debit' ? e.accountDebit : e.accountCredit;
  return { tax: p.amount, account, side, fillsEmpty: !carrier && !own };
}
