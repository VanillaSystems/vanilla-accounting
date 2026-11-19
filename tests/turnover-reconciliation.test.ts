/**
 * The turnover reconciliation of the year close (#569, MWSTV Art. 128): the revenue accounts'
 * turnover per filing period against Ziffer 200 as filed and as the books declare it today, each
 * difference named with its entries and the period it belongs to. Every figure is worked out by
 * hand: on the bundled demos (read only, entries added in memory) and on books of a few entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { filedReturnsOf } from '../src/workspace/reads.js';
import { yearCloseOf } from '../src/books/year-close.js';
import { turnoverNeedsLook, turnoverReconciliation, type TurnoverReconciliation } from '../src/accounting/turnover.js';
import type { JournalEntry, QuarterKey } from '../src/types/index.js';

const QUARTERS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'] as QuarterKey[];
const HALVES = ['2026-H1', '2026-H2'] as QuarterKey[];
const je = (id: string, date: string, dr: string, cr: string, amount: number, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id, ...x });
const demo = (name: string) => workspaceAt(join(APP_ROOT, name));
const row = (r: TurnoverReconciliation, period: string) => r.periods.find((p) => p.period === period)!;

test('demo (effective, quarterly): every quarter\'s revenue is its Ziffer 200, and Q1 is what was filed', () => {
  const ws = demo('demo');
  const r = turnoverReconciliation(loadBooks(ws).journalEntries, QUARTERS, filedReturnsOf(ws, '2026'));
  // Q1: Ziffer 200 of the filed mwst-ech0217-2026-Q1.xml; Q2: the 3xxx credits less debits of April to June.
  assert.deepEqual(r.periods.map((p) => [p.period, p.booked, p.declared, p.filed, p.differences.length, p.correction]), [
    ['2026-Q1', 38417.25, 38417.25, 38417.25, 0, 0],
    ['2026-Q2', 40588.45, 40588.45, undefined, 0, 0],
    ['2026-Q3', 46162.49, 46162.49, undefined, 0, 0],
    ['2026-Q4', 344.74, 344.74, undefined, 0, 0],
  ]);
  assert.equal(turnoverNeedsLook(r), false);
});

test('demo: a correction of filed Q1 booked in Q3, a fixed asset sold and revenue without a code, each named with its entries and its quarter', () => {
  const ws = demo('demo');
  const entries = [
    ...loadBooks(ws).journalEntries,
    // A credit note of a Q1 sale, booked in the open Q3 with corrects (golden rule 1): CHF 108.10 gross at 8.1 %.
    je('t-storno', '2026-08-10', '3200', '1020', 108.1, { vatCode: '-V81', corrects: '2026-Q1' }),
    // A machine sold: turnover with tax, but no revenue account.
    je('t-asset', '2026-08-12', '1020', '1500', 540.5, { vatCode: 'V81' }),
    // Revenue with no code: booked, declared nowhere.
    je('t-nocode', '2026-08-14', '1020', '3400', 200),
  ];
  const r = turnoverReconciliation(entries, QUARTERS, filedReturnsOf(ws, '2026'));
  const q1 = row(r, '2026-Q1'), q3 = row(r, '2026-Q3');
  // Q1: booked as before; declared today 38417.25 − 108.10 = 38309.15; the 0535 declares −108.10.
  assert.deepEqual([q1.booked, q1.declared, q1.filed, q1.correction, q1.correctionEntryIds], [38417.25, 38309.15, 38417.25, -108.1, ['t-storno']]);
  assert.deepEqual(q1.differences, [{ code: 'bookedIn', in: '2026-Q3', entryIds: ['t-storno'], amount: 108.1 }]);
  // Q3: booked 46162.49 − 108.10 + 200 = 46254.39; declared 46162.49 + 540.50 = 46702.99; difference −448.60.
  assert.deepEqual([q3.booked, q3.declared], [46254.39, 46702.99]);
  assert.deepEqual(q3.differences, [
    { code: 'declaredIn', in: '2026-Q1', entryIds: ['t-storno'], amount: -108.1 },
    { code: 'notRevenue', entryIds: ['t-asset'], amount: -540.5 },
    { code: 'undeclared', entryIds: ['t-nocode'], amount: 200 },
  ]);
  for (const p of r.periods) assert.equal(Math.round(p.differences.reduce((s, d) => s + d.amount, 0) * 100), Math.round((p.booked - p.declared) * 100), `${p.period}: the differences explain booked − declared`);
  assert.equal(r.correction, -108.1);
  assert.equal(turnoverNeedsLook(r), true, 'revenue without a code');
  assert.equal(turnoverNeedsLook(turnoverReconciliation(entries.filter((e) => e.id !== 't-nocode'), QUARTERS, filedReturnsOf(ws, '2026'))), false, 'a correction of a filed quarter is shown, not flagged');
});

test('demo-schreinerei (net tax rate, half-yearly): H1 is the filed Ziffer 200; a -F1 correction of H1 booked in H2 belongs to H1', () => {
  const ws = demo('demo-schreinerei');
  const books = loadBooks(ws).journalEntries;
  const plain = turnoverReconciliation(books, HALVES, filedReturnsOf(ws, '2026'));
  assert.deepEqual(plain.periods.map((p) => [p.period, p.booked, p.declared, p.filed, p.differences.length]), [
    ['2026-H1', 41103.35, 41103.35, 41103.35, 0],
    ['2026-H2', 27858.27, 27858.27, undefined, 0],
  ]);
  const r = turnoverReconciliation([...books, je('t-f1', '2026-09-01', '3400', '1020', 500, { vatCode: '-F1', corrects: '2026-H1' })], HALVES, filedReturnsOf(ws, '2026'));
  assert.deepEqual(row(r, '2026-H1').correction, -500);
  // The demo's own correction of H1 (M2026-010/011: V0 cancelled, F1 booked, CHF 3480 each) nets to 0 and is named with it.
  assert.deepEqual(row(r, '2026-H1').differences, [{ code: 'bookedIn', in: '2026-H2', entryIds: ['6647c7006f9e53aa', '83cda664ca63df8f', 't-f1'], amount: 500 }]);
  assert.deepEqual(row(r, '2026-H2').differences, [{ code: 'declaredIn', in: '2026-H1', entryIds: ['6647c7006f9e53aa', '83cda664ca63df8f', 't-f1'], amount: -500 }]);
});

test('demo-coiffeur (not registered): the close has no turnover to reconcile', () => {
  assert.equal(yearCloseOf(demo('demo-coiffeur'), '2026').turnover, undefined);
  assert.ok(yearCloseOf(demo('demo'), '2026').turnover, 'a registered firm has one');
});

test('a correction of last year\'s Q4 booked this year belongs to that quarter; one of this year booked next year is declared here', () => {
  demo('demo');
  const entries = [
    je('s1', '2026-02-02', '1020', '3200', 1081, { vatCode: 'V81' }),
    je('c-old', '2026-02-10', '3200', '1020', 54.05, { vatCode: '-V81', corrects: '2025-Q4' }),
    je('c-next', '2027-01-20', '3200', '1020', 10.81, { vatCode: '-V81', corrects: '2026-Q4' }),
    // A sale code on the wrong side of a revenue account: books −100, declares +100.
    je('swap', '2026-11-03', '3200', '1020', 100, { vatCode: 'V81' }),
  ];
  const r = turnoverReconciliation(entries, QUARTERS, []);
  assert.deepEqual(row(r, '2026-Q1').differences, [{ code: 'declaredIn', in: '2025-Q4', entryIds: ['c-old'], amount: -54.05 }]);
  assert.deepEqual(row(r, '2026-Q4').differences, [
    { code: 'differs', entryIds: ['swap'], amount: -200 },
    { code: 'bookedIn', in: '2027-Q1', entryIds: ['c-next'], amount: 10.81 },
  ]);
  assert.deepEqual([row(r, '2026-Q4').booked, row(r, '2026-Q4').declared, row(r, '2026-Q4').correction], [-100, 89.19, 0], 'not filed: no correction yet');
});

test('the year-end\'s own entries without a code (receivables and their reversal, a template booked) are named yearEnd, never flagged', () => {
  demo('demo');
  const entries = [
    je('yc-2026-receivables', '2026-12-31', '1100', '3200', 2654.5, { origin: 'year-close' }),
    je('accrued', '2026-12-31', '1300', '3200', 300),
    je('yc-2025-receivables-reversal', '2026-01-01', '3200', '1100', 1000, { origin: 'year-close' }),
  ];
  const r = turnoverReconciliation(entries, QUARTERS, [], new Set(['accrued']));
  assert.deepEqual(row(r, '2026-Q4').differences, [{ code: 'yearEnd', entryIds: ['yc-2026-receivables', 'accrued'], amount: 2954.5 }]);
  assert.deepEqual(row(r, '2026-Q1').differences, [{ code: 'yearEnd', entryIds: ['yc-2025-receivables-reversal'], amount: -1000 }]);
  assert.equal(turnoverNeedsLook(r), false);
});

test('a correction of another period that declares no turnover is not «declared in» it: its revenue is undeclared here', () => {
  demo('demo');
  const r = turnoverReconciliation([je('c', '2026-08-01', '1020', '3400', 75, { corrects: '2026-Q1' })], QUARTERS, []);
  assert.deepEqual(row(r, '2026-Q3').differences, [{ code: 'undeclared', entryIds: ['c'], amount: 75 }]);
  assert.deepEqual(row(r, '2026-Q1').differences, []);
});
