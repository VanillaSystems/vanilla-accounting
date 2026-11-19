/**
 * The Erfolgsrechnung in stages (#568, OR 959b Abs. 2 on the Swiss jurisdiction): the operating
 * expenses as Personalaufwand, übriger Aufwand, Abschreibungen and Finanzerfolg, each followed by
 * the result it leaves. Presentation only: every account is in exactly one block, and the
 * Betriebsergebnis and the result stay the income statement's.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Index, JournalEntry } from '../src/types/index.js';
import { computeIncomeStatement, statementPostings } from '../src/accounting/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { reportView, type Block, type ReportView } from '../src/app/areas/reports/model.js';
import { loadChart } from '../src/workspace/chart.js';
import { statements } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { checkJurisdiction } from '../src/core/modules/check.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const p = (token: string) => parsePeriod(token, '2026-11-19')!;
const je = (id: string, date: string, dr: string, cr: string, amount: number): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id });
const names = Object.fromEntries(['1020', '3200', '4000', '5000', '6000', '6800', '6840', '6900', '6950'].map((a) => [a, a]));
const books: Index = {
  config: {}, receipts: [], transactions: [], mappings: [], bankStatements: [],
  journalEntries: [
    je('sale', '2026-08-03', '1020', '3200', 1000), je('goods', '2026-08-04', '4000', '1020', 200),
    je('wage', '2026-08-25', '5000', '1020', 300), je('rent', '2026-08-01', '6000', '1020', 100),
    je('depr', '2026-09-30', '6800', '1020', 50), je('fees', '2026-09-30', '6840', '1020', 10),
    je('interest', '2026-09-30', '6900', '1020', 5), je('earned', '2026-09-30', '1020', '6950', 3),
  ],
};

const sums = (v: ReportView) => Object.fromEntries(v.blocks.flatMap((b) => (b.kind === 'sum' ? [[b.title, b.value]] : [])));
const groups = (v: ReportView) => v.blocks.filter((b): b is Extract<Block, { kind: 'group' }> => b.kind === 'group');

test('Bruttoergebnis, after the staff costs, EBITDA, EBIT and the Betriebsergebnis, in this order', () => {
  const v = reportView('income', books, p('2026-Q3'), names, { all: false });
  assert.deepEqual(v.blocks.flatMap((b) => (b.kind === 'sum' ? [b.title] : [])), ['grossProfit', 'afterStaff', 'ebitda', 'ebit', 'operatingResult', 'netResult']);
  assert.deepEqual(sums(v), { grossProfit: 800, afterStaff: 500, ebitda: 400, ebit: 350, operatingResult: 338, netResult: 338 });
  const finance = groups(v).find((g) => g.title === 'Finanzaufwand und Finanzertrag');
  assert.deepEqual(finance?.rows.map((r) => [r.account, r.value]), [['6840', 10], ['6900', 5], ['6950', -3]], 'the payment fees are Finanzerfolg, as the chart says, and the income takes from it');
  assert.equal(groups(v).find((g) => g.title === 'Abschreibungen und Wertberichtigungen')?.total, 50);
  const s = computeIncomeStatement(statementPostings(books.journalEntries!, Object.keys(names)), '2026-07-01', '2026-09-30', names);
  assert.equal(sums(v).operatingResult, s.operatingResult);
  assert.equal(sums(v).netResult, s.netResult);
});

test('on every demo\'s books each account is in one block and the stages add up to the operating expenses', () => {
  for (const demo of ['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei']) {
    const frozen = JSON.parse(readFileSync(`tests/golden/${demo}/books.json`, 'utf8')) as Index;
    const entries = frozen.journalEntries ?? [];
    const chart = [...new Set(entries.flatMap((e) => [e.accountDebit, e.accountCredit]))].filter(Boolean).sort();
    const all = Object.fromEntries(chart.map((a) => [a, a]));
    const v = reportView('income', { ...frozen, transactions: frozen.transactions ?? [] }, p('2026'), all, { all: true, prior: false });
    const s = computeIncomeStatement(statementPostings(entries, chart), '2026-01-01', '2026-12-31', all);
    const listed = groups(v).flatMap((g) => g.rows.map((r) => r.account));
    assert.equal(listed.length, new Set(listed).size, `${demo}: an account in two blocks`);
    const sectionAccounts = [s.revenue, s.costOfGoods, s.operatingExpenses, s.otherIncome, s.otherExpenses].flatMap((x) => x.rows.map((r) => r.account));
    assert.deepEqual([...listed].sort(), [...sectionAccounts].sort(), `${demo}: the same accounts as the sections`);
    assert.equal(sums(v).operatingResult, s.operatingResult, demo);
    assert.equal(sums(v).netResult, s.netResult, demo);
    const staged = groups(v).filter((g) => statements().incomeStages?.operatingExpenses?.some((st) => st.title === g.title));
    assert.equal(Math.round(staged.reduce((n, g) => n + (g.total ?? 0), 0) * 100) / 100, s.operatingExpenses.total, `${demo}: the stages add up`);
  }
});

test('every account of the chart lands in the stage of its line (accounts.yaml)', () => {
  const stageOfLine: Record<string, string> = {
    personalaufwand: 'Personalaufwand', 'uebriger-aufwand': 'Übriger betrieblicher Aufwand',
    abschreibungen: 'Abschreibungen und Wertberichtigungen', finanzerfolg: 'Finanzaufwand und Finanzertrag',
  };
  const accounts = loadChart().accounts.filter((a) => a.line in stageOfLine);
  assert.ok(accounts.length > 30);
  const chartNames = Object.fromEntries(accounts.map((a) => [a.number, a.name]));
  const v = reportView('income', books, p('2026-Q3'), chartNames, { all: true, prior: false });
  for (const a of accounts) {
    const g = groups(v).find((x) => x.rows.some((r) => r.account === a.number));
    assert.equal(g?.title, stageOfLine[a.line], `${a.number} ${a.name}`);
  }
});

test('the prior year sits beside each stage and each result', () => {
  const twoYears: Index = { ...books, journalEntries: [...books.journalEntries!, je('wage25', '2025-08-25', '5000', '1020', 120), je('sale25', '2025-08-03', '1020', '3200', 400)] };
  const v = reportView('income', twoYears, p('2026-Q3'), names, { all: false });
  assert.equal(groups(v).find((g) => g.title === 'Personalaufwand')?.priorTotal, 120);
  const afterStaff = v.blocks.find((b): b is Extract<Block, { kind: 'sum' }> => b.kind === 'sum' && b.title === 'afterStaff');
  assert.equal(afterStaff?.prior, 280);
});

test('a stage none of whose accounts has an amount is not shown, nor the result after it, unless all accounts are', () => {
  const noStaff: Index = { ...books, journalEntries: books.journalEntries!.filter((e) => e.id !== 'wage') };
  const v = reportView('income', noStaff, p('2026-Q3'), names, { all: false });
  assert.ok(!groups(v).some((g) => g.title === 'Personalaufwand'));
  assert.ok(!('afterStaff' in sums(v)));
  assert.equal(sums(v).ebitda, 700, 'the next result counts on from the Bruttoergebnis');
  const every = reportView('income', noStaff, p('2026-Q3'), names, { all: true });
  assert.equal(groups(every).find((g) => g.title === 'Personalaufwand')?.total, 0);
  assert.equal(sums(every).afterStaff, 800);
});

test('the module check names a stage list of the wrong shape, a result twice, and an account outside its section, without throwing', () => {
  const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
  const withStages = (incomeStages: unknown) => checkJurisdiction({ ...jurisdiction, statements: { ...jurisdiction.statements, incomeStages } } as typeof jurisdiction)
    .filter((x) => x.path.startsWith('incomeStages')).map((x) => `${x.path}: ${x.message}`);
  assert.deepEqual(withStages(undefined), []);
  assert.deepEqual(checkJurisdiction(jurisdiction), [], 'the shipped stages pass');
  assert.deepEqual(withStages({ operatingExpenses: 'Personal' }), ['incomeStages.operatingExpenses: a list of stages']);
  assert.deepEqual(withStages(['x']), ['incomeStages: a map of income sections to their stages']);
  assert.deepEqual(withStages({ operatingExpenses: [
    { title: 'A', from: '5000', to: '6000', then: 'ebit' },
    { title: 'B', from: '6000', to: '7000', accounts: ['3000'], then: 'ebit' },
  ] }), [
    'incomeStages.operatingExpenses[1].accounts: 3000 is not in the section operatingExpenses',
    'incomeStages.operatingExpenses[1].then: "ebit" follows an earlier stage already',
  ]);
});
