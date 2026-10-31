/**
 * Migration step 11, the swap test: a made-up jurisdiction (tests/fixtures/modules/xx) with another
 * chart, other codes and boxes, a yearly return and another currency books its scenario through
 * the same engines as ch. Every figure below is worked out by hand from xx's data; none of ch's
 * numbers, codes or periods appears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { baseCurrency, chart, filing, setJurisdiction, vat } from '../src/engines/index.js';
import { computeIncomeStatement } from '../src/accounting/income-statement.js';
import { statementPostings } from '../src/accounting/statement-postings.js';
import { computeBalanceSheet } from '../src/accounting/balance-sheet.js';
import { entriesForReturn } from '../src/accounting/declarations.js';
import { openFilingPeriod } from '../src/accounting/periods.js';
import { revenueVatCode } from '../src/invoices/rules.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { reportView } from '../src/app/areas/reports/model.js';
import type { Index, JournalEntry } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const xx = loadJurisdiction(join(APP_ROOT, 'tests', 'fixtures'), 'xx');
setJurisdiction(xx.jurisdiction);

const e = (id: string, date: string, debit: string, credit: string, amount: number, vatCode?: string): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: debit, accountCredit: credit, amount, ...(vatCode ? { vatCode } : {}) });
const entries = [
  e('s1', '2026-03-10', '1800', '4000', 1200, 'S20'),
  e('s2', '2026-07-01', '1800', '4100', 105, 'S5'),
  e('x1', '2026-11-20', '1800', '4200', 500, 'X0'),
  e('p1', '2026-05-05', '6000', '1800', 240, 'P20'),
  e('c1', '2027-02-01', '1800', '4000', 60, 'S20'),
];
const names = { '1800': 'Bank', '4000': 'Sales', '4100': 'Sales reduced', '4200': 'Exports', '6000': 'Rent' };

test('xx loads without a problem and is not ch', () => {
  assert.deepEqual(xx.problems, []);
  assert.equal(baseCurrency(), 'XXX');
  assert.equal(filing().length, 'year');
});

test('the yearly return: turnover, deduction, each rate row net of its tax, input tax, what to pay', () => {
  const boxes = Object.fromEntries(vat().report(entries, '2026', []).ziffern.map((z) => [z.number, z.amount]));
  assert.deepEqual(
    { 1: boxes['1'], 20: boxes['20'], 2: boxes['2'], 10: boxes['10'], 11: boxes['11'], 40: boxes['40'], 30: boxes['30'], 50: boxes['50'], 51: boxes['51'] },
    { 1: 1805, 20: 500, 2: 1305, 10: 1000, 11: 100, 40: 205, 30: 40, 50: 165, 51: 0 },
  );
});

test('a year is the filing period: its open period, and a correction declared in the year it corrects', () => {
  assert.equal(openFilingPeriod('2025-12-31', '2026-10-09', filing().length).token, '2026');
  const correction = { ...e('k1', '2027-03-01', '4000', '1800', 12, '-S20'), corrects: '2026' };
  assert.deepEqual(entriesForReturn([...entries, correction], '2026', filing().length).map((x) => x.id), ['s1', 's2', 'x1', 'p1', 'k1']);
  assert.deepEqual(entriesForReturn([...entries, correction], '2027', filing().length).map((x) => x.id), ['c1']);
});

test('xx\'s chart: revenue in class 4 is credit-normal, the statements follow its groups and balance', () => {
  assert.equal(chart().isDebitNormal('4000'), false);
  assert.equal(chart().isDebitNormal('1800'), true);
  assert.equal(chart().sideOf('3800'), 'liabilities');
  const year = statementPostings(entries.filter((x) => x.date.startsWith('2026')), Object.keys(names));
  assert.equal(year.length, entries.filter((x) => x.date.startsWith('2026')).length, 'xx shows its statements gross within the year: no tax posting is derived');
  const is = computeIncomeStatement(year, '2026-01-01', '2026-12-31', names);
  assert.deepEqual([is.revenue.title, is.revenue.total, is.operatingExpenses.total, is.netResult], ['Sales', 1805, 240, 1565]);
  const bs = computeBalanceSheet(year, '2026-12-31', {}, names);
  assert.deepEqual(bs.assets.map((g) => [g.title, g.total]), [['Fixed assets', 0], ['Current assets', 1565]]);
  assert.deepEqual(bs.liabilities[0].rows.at(-1), { account: '', name: 'Result of the year', balance: 1565 });
  assert.ok(bs.isBalanced);
});

test('xx shows its statements gross within the year: the Erfolgsrechnung keeps the tax and says how much it holds (r8c-2)', () => {
  const books: Index = { receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: entries };
  const view = reportView('income', books, parsePeriod('2026', '2026-12-31')!, names, false);
  assert.equal(view.headline.value, 1565, 'sales and rent as booked, the tax inside');
  assert.deepEqual(view.vat, { shown: 'gross', figures: { owed: 205, input: 40, acquisition: 0, net: 165 } });
});

test('an invoice asks xx for its codes by meaning', () => {
  assert.equal(revenueVatCode(20, undefined), 'S20');
  assert.equal(revenueVatCode(5, undefined), 'S5');
  assert.equal(revenueVatCode(0, 'abroad'), 'X0');
});
