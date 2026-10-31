import type { JournalEntry } from '../types/index.js';
import { toRappen, fromRappen, roundCHF } from './rappen.js';
import { addDays } from './periods.js';

declare const POSTINGS: unique symbol;
/**
 * The journal as the statements read it (src/accounting/statement-postings.ts): only
 * `statementPostings` makes one, so no statement reads the journal without the jurisdiction's say
 * on its VAT.
 */
export type Postings = readonly JournalEntry[] & { readonly [POSTINGS]: true };

export interface AccountBalance {
  account: string;
  debitTotal: number;
  creditTotal: number;
  balance: number;
}

/**
 * Compute CHF amount for a journal entry.
 * If exchangeCurrency is set, amount is in foreign currency — multiply by exchangeRate to get CHF.
 * If no exchangeCurrency, amount is already CHF.
 */
export function chfAmount(entry: JournalEntry): number {
  if (entry.exchangeCurrency && entry.exchangeRate) {
    return roundCHF(entry.amount * entry.exchangeRate);
  }
  return entry.amount;
}

/** Whether an account's balance grows on the debit side: the chart decides (src/engines/chart.ts). */
export type DebitNormal = (account: string) => boolean;

/**
 * Compute balances for all accounts from journal entries within a date range.
 */
export function computeBalances(
  entries: readonly JournalEntry[],
  from: string,
  to: string,
  openingBalances: Record<string, number>,
  isDebitNormal: DebitNormal,
): AccountBalance[] {
  const filtered = entries.filter(e => {
    const date = e.date;
    if (!date) return false;
    return date >= from && date <= to;
  });

  const debits = new Map<string, number>();
  const credits = new Map<string, number>();

  for (const entry of filtered) {
    const amountRappen = toRappen(chfAmount(entry));
    debits.set(entry.accountDebit, (debits.get(entry.accountDebit) ?? 0) + amountRappen);
    credits.set(entry.accountCredit, (credits.get(entry.accountCredit) ?? 0) + amountRappen);
  }

  const allAccounts = new Set<string>();
  debits.forEach((_, key) => allAccounts.add(key));
  credits.forEach((_, key) => allAccounts.add(key));
  for (const key of Object.keys(openingBalances)) allAccounts.add(key);

  const result: AccountBalance[] = [];
  for (const account of Array.from(allAccounts).sort()) {
    const debitTotalRappen = debits.get(account) ?? 0;
    const creditTotalRappen = credits.get(account) ?? 0;
    const openingRappen = toRappen(openingBalances[account] ?? 0);

    let balanceRappen: number;
    if (isDebitNormal(account)) {
      balanceRappen = openingRappen + debitTotalRappen - creditTotalRappen;
    } else {
      balanceRappen = openingRappen + creditTotalRappen - debitTotalRappen;
    }

    result.push({
      account,
      debitTotal: fromRappen(debitTotalRappen),
      creditTotal: fromRappen(creditTotalRappen),
      balance: fromRappen(balanceRappen),
    });
  }

  return result;
}

/**
 * Compute balance for a single account.
 */
export function computeAccountBalance(
  entries: readonly JournalEntry[],
  account: string,
  from: string,
  to: string,
  openingBalance: number,
  isDebitNormal: DebitNormal,
): AccountBalance {
  const balances = computeBalances(entries, from, to, { [account]: openingBalance }, isDebitNormal);
  return balances.find(b => b.account === account) ?? {
    account,
    debitTotal: 0,
    creditTotal: 0,
    balance: openingBalance,
  };
}

/**
 * Each account's balance when `from` begins: the opening balances of `from`'s year plus that
 * year's entries before `from`. A range that starts mid-year (a quarter, the last 30 days) so
 * carries the year's earlier movements instead of starting again from 1 January. Before the
 * first year with opening balances (the period 'all'), the books start at that year's openings.
 */
export function openingBalancesAt(
  postings: Postings,
  from: string,
  openingByYear: Record<string, Record<string, number>> | undefined,
  isDebitNormal: DebitNormal,
): Record<string, number> {
  openingByYear ??= {};
  const year = from.slice(0, 4);
  const first = Object.keys(openingByYear).sort()[0];
  if (first && year < first) return openingByYear[first];
  const balances = computeBalances(postings, `${year}-01-01`, addDays(from, -1), openingByYear[year] ?? {}, isDebitNormal);
  return Object.fromEntries(balances.map((b) => [b.account, b.balance]));
}
