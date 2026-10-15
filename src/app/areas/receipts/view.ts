/** What the list, the detail and the keys of Belege share: the ledger of the loaded books, and the list as last shown. */
import type { BankTransaction, Index } from '../../../types/index.js';
import { localToday, booksOpenPeriod, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Location, Route } from '../../shell/route.js';
import { ledgerOf, type Candidate, type Ledger } from './model.js';
import { baseCurrency, filing } from '../../../engines/index.js';

let memo: { books: Index; ledger: Ledger } | undefined;

/** The ledger of these books, computed once per load. */
export function ledgerFor(books: Index): Ledger {
  if (memo?.books !== books) memo = { books, ledger: ledgerOf(books, booksOpenPeriod(books, localToday(), filing().length).from) };
  return memo.ledger;
}

/** The list as last shown, in ↑↓ order, with the suggestion of each row that has one: the keys act on it. */
export const listed: { ids: string[]; suggestions: Map<string, Candidate> } = { ids: [], suggestions: new Map() };

/** A payment's amount with its direction: money out is negative. */
export const signed = (tx: BankTransaction) => (tx.direction === 'DBIT' ? -1 : 1) * Math.abs(tx.amount);

/** The account a payment moved on: the bank's label, its currency when not CHF; a private outlay is "Privat". */
export const bankOf = (tx: BankTransaction) =>
  tx.bank === 'manual' ? t('receipts.private') : tx.currency !== baseCurrency() ? `${tx.bank} ${tx.currency}` : tx.bank;

export const amountOf = (tx: BankTransaction) => `${tx.currency !== baseCurrency() ? `${tx.currency} ` : ''}${fmt(signed(tx))}`;

/** A payment in one line, for toasts: "29.09.2026 Raiffeisen −15.00". */
export const txLine = (tx: BankTransaction) => `${formatDate(tx.date)} ${bankOf(tx)} ${amountOf(tx)}`;

/** A place for an object dated `date`: in the current period when it holds the date (urls.md rule 1). */
export const at = (route: Route, date: string | undefined, current?: Period): Location =>
  ({ route, query: { period: parsePeriod(periodContaining(date, current), localToday()) ?? undefined } });

/** How far a payment is from the receipt's date: "gleicher Tag", "2 Tage vorher". */
export const dayText = (days: number) =>
  days === 0 ? t('receipts.sameDay') : t(days < 0 ? 'receipts.daysBefore' : 'receipts.daysAfter', { n: Math.abs(days) });
