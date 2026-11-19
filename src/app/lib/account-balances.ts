/**
 * Each account's balance at the end of a day, as Bilanz & ER shows it (#567): the year's opening
 * balances and the year's postings up to that day, over the same statement postings. The account
 * picker of a hand entry names it beside each account. Computed once per books and day.
 */
import type { Index } from '../../types/index.js';
import { computeBalances } from '../../accounting/ledger.js';
import { chart } from '../../engines/index.js';
import { reportPostings } from '../areas/reports/model.js';
import { getAccountMap } from './accounts.js';

let memo: { books: Index; date: string; balances: ReadonlyMap<string, number> } | undefined;

export function balancesAt(books: Index, date: string): ReadonlyMap<string, number> {
  if (memo?.books === books && memo.date === date) return memo.balances;
  const year = date.slice(0, 4);
  const postings = reportPostings(books, getAccountMap()).filter((e) => e.date >= `${year}-01-01` && e.date <= date);
  const rows = computeBalances(postings, `${year}-01-01`, date, books.config?.openingBalances?.[year] ?? {}, chart().isDebitNormal);
  memo = { books, date, balances: new Map(rows.map((r) => [r.account, r.balance])) };
  return memo.balances;
}
