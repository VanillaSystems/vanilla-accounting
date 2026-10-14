/**
 * Golden master for the statements (balance sheet, income statement, trial balance) on the frozen
 * books of the workspace under test, as tests/vat-golden.test.ts is for the VAT return. It pins
 * today's figures before 0.4.0 moves the chart and the statements into modules/ch (docs/0.4.0,
 * migration step 0). Accounts are named by their number only, so a renamed account in
 * accounts.json never moves a figure here.
 */
import { test } from 'node:test';
import type { JournalEntry } from '../src/types/index.js';
import { computeBalanceSheet, type BalanceSheetSection } from '../src/accounting/balance-sheet.js';
import { computeIncomeStatement, type IncomeStatementSection } from '../src/accounting/income-statement.js';
import { computeTrialBalance } from '../src/accounting/trial-balance.js';
import { openingBalancesAt } from '../src/accounting/ledger.js';
import { goldenSet } from './support/golden.js';

const { books, expect: golden } = goldenSet();
const entries = books.journalEntries as JournalEntry[];
const openingByYear = (books.config as { openingBalances?: Record<string, Record<string, number>> }).openingBalances ?? {};

const YEAR = entries.map((e) => e.date).sort().at(-1)!.slice(0, 4);
const openings = openingByYear[YEAR] ?? {};
const accounts = [...new Set([...entries.flatMap((e) => [e.accountDebit, e.accountCredit]), ...Object.keys(openings)])].filter(Boolean).sort();
const names = Object.fromEntries(accounts.map((a) => [a, a]));

const quarterEnd = (q: number) => `${YEAR}-${String(q * 3).padStart(2, '0')}-${['31', '30', '30', '31'][q - 1]}`;
const PERIODS: [string, string, string][] = [
  ...[1, 2, 3, 4].map((q): [string, string, string] => [`${YEAR}-Q${q}`, `${YEAR}-${String(q * 3 - 2).padStart(2, '0')}-01`, quarterEnd(q)]),
  [`${YEAR}-H1`, `${YEAR}-01-01`, `${YEAR}-06-30`],
  [YEAR, `${YEAR}-01-01`, `${YEAR}-12-31`],
];

const incomeSection = (s: IncomeStatementSection) => [s.title, s.total, s.rows.filter((r) => r.amount !== 0).map((r) => [r.account, r.amount])];
const balanceSection = (s: BalanceSheetSection) => [s.title, s.total, s.rows.filter((r) => r.balance !== 0).map((r) => [r.account, r.balance])];

test('income statement per period', () => {
  for (const [key, from, to] of PERIODS) {
    const s = computeIncomeStatement(entries, from, to, names);
    golden(`income-${key}`, {
      sections: [s.revenue, s.costOfGoods, s.operatingExpenses, s.otherIncome, s.otherExpenses, s.extraordinaryItems].map(incomeSection),
      grossProfit: s.grossProfit, operatingResult: s.operatingResult, netResult: s.netResult,
    });
  }
});

test('balance sheet at the end of each period', () => {
  for (const [key, , to] of PERIODS) {
    const b = computeBalanceSheet(entries, to, openings, names);
    golden(`balance-${key}`, {
      assets: b.assets.map(balanceSection), liabilities: b.liabilities.map(balanceSection),
      totalAssets: b.totalAssets, totalLiabilities: b.totalLiabilities, isBalanced: b.isBalanced,
    });
  }
});

test('trial balance per period, carrying the year before it', () => {
  for (const [key, from, to] of PERIODS) {
    const t = computeTrialBalance(entries, from, to, openingBalancesAt(entries, from, openingByYear), names);
    golden(`trial-${key}`, {
      rows: t.rows.map((r) => [r.account, r.debitTotal, r.creditTotal, r.balance]),
      totalDebits: t.totalDebits, totalCredits: t.totalCredits, isBalanced: t.isBalanced,
    });
  }
});
