/**
 * The prior year beside Bilanz and Erfolgsrechnung (#568, OR 958d Abs. 2): from the books when they
 * reach back to it, else the Bilanz from the opening balances, and with neither no figures at all
 * (never zeros); the export carries the same column.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import type { Index, JournalEntry } from '../src/types/index.js';
import { computeIncomeStatement, statementPostings } from '../src/accounting/index.js';
import { parsePeriod, yearBefore } from '../src/accounting/periods.js';
import { accountsOf, reportView, type Block, type ReportView } from '../src/app/areas/reports/model.js';
import { tableOf } from '../src/export/tables.js';

const p = (token: string) => parsePeriod(token, '2026-11-19')!;
const je = (id: string, date: string, dr: string, cr: string, amount: number): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id });
const names = { '1020': 'Bank', '2800': 'Aktienkapital', '2970': 'Gewinnvortrag', '3200': 'Warenertrag', '6500': 'Büromaterial' };
const base: Index = { config: {}, receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [] };

const row = (v: ReportView, account: string) => v.blocks.flatMap((b) => (b.kind === 'group' ? b.rows : [])).find((r) => r.account === account);
const sum = (v: ReportView, title: string) => v.blocks.find((b): b is Extract<Block, { kind: 'sum' }> => b.kind === 'sum' && b.title === title);
const words = { t: (key: string) => key, accountingName: (g: string) => g };
const ctx = (books: Index, token: string) => ({ books, period: p(token), names, words: words as never, filed: {}, filingLength: 'quarter' as const });

const twoYears: Index = {
  ...base,
  config: { openingBalances: { '2025': { '1020': 5000, '2800': 5000 } } },
  journalEntries: [
    je('s25', '2025-08-04', '1020', '3200', 900),
    je('p25', '2025-08-20', '6500', '1020', 100),
    je('s26', '2026-08-05', '1020', '3200', 1200),
  ],
};

test('the Erfolgsrechnung beside the same days a year earlier, from the books', () => {
  const v = reportView('income', twoYears, p('2026-Q3'), names, false);
  assert.deepEqual(v.prior, { from: '2025-07-01', to: '2025-09-30', source: 'books' });
  const before = computeIncomeStatement(statementPostings(twoYears.journalEntries!, Object.keys(names)), '2025-07-01', '2025-09-30', names);
  assert.equal(sum(v, 'netResult')?.prior, before.netResult);
  assert.equal(sum(v, 'netResult')?.value, 1200);
  assert.equal(row(v, '6500')?.prior, 100, 'an account with no amount this year but one last year is listed');
  assert.equal(row(v, '6500')?.value, 0);
  assert.ok(accountsOf(v).includes('6500'));
});

test('the Bilanz beside the last day of the year before, from the books', () => {
  const v = reportView('balance', twoYears, p('2026-Q3'), names, false);
  assert.deepEqual(v.prior, { from: '2025-01-01', to: '2025-12-31', source: 'books' });
  assert.equal(row(v, '1020')?.prior, 5800);
  assert.equal(sum(v, 'totalAssets')?.prior, 5800);
  const result = v.blocks.find((b) => b.kind === 'group' && b.plain);
  assert.equal(result?.kind === 'group' && result.plain?.prior, 800, 'the prior year\'s result as the books hold it');
});

test('without the prior year\'s books the Bilanz comes from the opening balances; the Erfolgsrechnung has none to show', () => {
  const opened: Index = { ...base, config: { openingBalances: { '2026': { '1020': 7000, '2800': 5000, '2970': 2000 } } }, journalEntries: [je('s', '2026-08-05', '1020', '3200', 1200)] };
  const bal = reportView('balance', opened, p('2026-Q3'), names, false);
  assert.equal(bal.prior && 'source' in bal.prior && bal.prior.source, 'opening');
  assert.equal(row(bal, '1020')?.prior, 7000);
  assert.equal(row(bal, '2970')?.prior, 2000);
  assert.equal(sum(bal, 'totalLiabilities')?.prior, 7000);
  const inc = reportView('income', opened, p('2026-Q3'), names, false);
  assert.deepEqual(inc.prior, { from: '2025-07-01', to: '2025-09-30', missing: 'noBooks', first: '2026-01-01' });
  assert.equal(row(inc, '3200')?.prior, undefined, 'no figure, not a zero');
  assert.equal(sum(inc, 'netResult')?.prior, undefined);
});

test('with neither the books nor an opening the Bilanz says so; a period over a year has no prior year; books that begin inside it say from when', () => {
  const fresh: Index = { ...base, journalEntries: [je('s', '2026-08-05', '1020', '3200', 1200)] };
  assert.deepEqual(reportView('balance', fresh, p('2026'), names, false).prior, { from: '2025-01-01', to: '2025-12-31', missing: 'noBooks', first: '2026-08-05' });
  assert.equal((reportView('income', fresh, p('all'), names, false).prior as { missing?: string }).missing, 'overlap');
  assert.equal((reportView('income', fresh, p('2025-01-01..2026-06-30'), names, false).prior as { missing?: string }).missing, 'overlap');
  const late: Index = { ...base, journalEntries: [je('a', '2025-08-04', '1020', '3200', 900), je('b', '2026-08-05', '1020', '3200', 1)] };
  assert.deepEqual(reportView('income', late, p('2026'), names, false).prior, { from: '2025-01-01', to: '2025-12-31', source: 'books', since: '2025-08-04' });
});

test('the export carries the prior year\'s column, or a head that says there are no figures and empty cells', () => {
  const tb = tableOf('income', ctx(twoYears, '2026-Q3'));
  assert.equal(tb.head.at(-1), 'reports.priorCol');
  assert.deepEqual(tb.money, [3, 4]);
  assert.deepEqual(tb.rows.find((r) => r[1] === '6500')?.slice(1), ['6500', 'Büromaterial', 0, 100]);
  const none = tableOf('income', ctx({ ...base, journalEntries: [je('s', '2026-08-05', '1020', '3200', 1200)] }, '2026-Q3'));
  assert.equal(none.head.at(-1), 'reports.priorNoneCol');
  assert.ok(none.rows.every((r) => r.length === 5 && r[4] === ''));
});

test('a year earlier: the same day, 29 February as 28 February', () => {
  assert.equal(yearBefore('2026-09-30'), '2025-09-30');
  assert.equal(yearBefore('2028-02-29'), '2027-02-28');
  assert.equal(yearBefore('2026-01-01'), '2025-01-01');
});
