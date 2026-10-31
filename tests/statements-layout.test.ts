/**
 * The groups of modules/ch/statements.yaml that no workspace's golden books touch: the accounts
 * listed one by one for other income and expenses, and the open year's result in equity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { computeIncomeStatement } from '../src/accounting/income-statement.js';
import { computeBalanceSheet } from '../src/accounting/balance-sheet.js';
import type { JournalEntry } from '../src/types/index.js';
import { statementPostings } from '../src/accounting/statement-postings.js';

const e = (id: string, debit: string, credit: string, amount: number): JournalEntry =>
  ({ id, transactionRef: id, date: '2026-05-01', accountDebit: debit, accountCredit: credit, amount });
const names = { '1020': 'Bank', '3200': 'Ertrag', '7010': 'Aufwand Nebenbetrieb', '8510': 'Ertrag ausserordentlich', '8900': 'Steuern', '2970': 'Gewinnvortrag' };
const entries = statementPostings([e('a', '1020', '8510', 300), e('b', '8900', '1020', 120), e('c', '1020', '3200', 1000), e('d', '7010', '1020', 50)], Object.keys(names));

test('accounts listed one by one land in their section, and the net result sums them', () => {
  const is = computeIncomeStatement(entries, '2026-01-01', '2026-12-31', names);
  assert.deepEqual(is.otherIncome.rows.filter((r) => r.amount).map((r) => r.account), ['8510']);
  assert.deepEqual(is.otherExpenses.rows.filter((r) => r.amount).map((r) => r.account), ['7010', '8900']);
  assert.equal(is.netResult, 1000 + 300 - 120 - 50);
});

test('the open year\'s result shows in equity under its name, and the balance sheet balances', () => {
  const bs = computeBalanceSheet(entries, '2026-12-31', {}, names);
  const equity = bs.liabilities.find((g) => g.title === 'Eigenkapital')!;
  assert.deepEqual(equity.rows.at(-1), { account: '', name: 'Jahresergebnis (noch nicht abgeschlossen)', balance: 1130 });
  assert.ok(bs.isBalanced);
});
