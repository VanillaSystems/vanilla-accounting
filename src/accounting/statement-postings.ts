/**
 * What the Bilanz, the Erfolgsrechnung, the Saldobilanz and an account's ledger read: the journal,
 * and, where the jurisdiction shows the statements net within the year (statements.yaml `vat`),
 * the tax its VAT codes split off, derived at read time with the year close's own `vatPostings`
 * on the same VAT account. Nothing is written to the journal; the VAT return reads the codes alone.
 * So the in-year statements are the ones the year close (`closingLedger`) and Banana show at 31.12.
 */
import type { JournalEntry } from '../types/index.js';
import { statements } from '../engines/index.js';
import { vatPostings, vatShapeOf, yearEndAccounts } from './year-close.js';
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

/** The account the statements post the tax to, or null where they show it gross (no derived postings to fill a side with). */
export const statementVatAccountOrNone = (chart: readonly string[]): string | null => (statements().vat === 'net' ? statementVatAccount(chart) : null);

/**
 * Where one entry's tax goes, as the statements post it (`vatShapeOf`, the shape `vatPostingOf`
 * builds the derived posting from), on the account `statementVatAccountOrNone` gives:
 * - `included`: the tax a gross amount holds, split off the other account;
 * - `onTop`: tax owed on top of the amount (Bezugsteuer without a deduction);
 * - `tax`: the amount is the tax itself. `fills` then names the entry's side the VAT account
 *   balances, when the entry leaves it empty; a filled side keeps its own account.
 */
export type VatSplit =
  | { kind: 'included' | 'onTop'; tax: number; account: string }
  | { kind: 'tax'; tax: number; account: string; fills?: 'debit' | 'credit' };

export function vatSplitOf(e: JournalEntry, vatAccount: string | null): VatSplit | null {
  const shape = vatAccount ? vatShapeOf(e) : null;
  if (!shape || !vatAccount) return null;
  if (!shape.amountIsTax) return { kind: shape.onTop ? 'onTop' : 'included', tax: shape.amount, account: vatAccount };
  const empty = !(shape.carrier === 'debit' ? e.accountDebit : e.accountCredit);
  return { kind: 'tax', tax: shape.amount, account: vatAccount, ...(empty && { fills: shape.carrier }) };
}
