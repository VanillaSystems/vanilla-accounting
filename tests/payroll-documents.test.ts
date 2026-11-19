/**
 * The year's documents from the closed payslips (src/payroll/documents.ts, docs/specs/payroll.md §5.6,
 * §15.1 checkpoint 10): the owner of §7.2 closed January to December with the 13th, worked by hand;
 * every Lohnausweis field equals the sum of its Lohnarten, the Lohnkonto agrees with the payslips, and the
 * Lohnausweis is issued as a PDF and a snapshot that a replacement keeps beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { declarationRows, lohnausweisOf, lohnkonto } from '../src/payroll/documents.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import { historyOf } from '../src/payroll/history.js';
import { issueLohnausweis, lohnausweisSnapshots, type LohnausweisSnapshot } from '../src/payroll/service.js';
import { appendPayslipEvents, savePayroll } from '../src/payroll/store.js';
import type { PayslipClose } from '../src/payroll/model.js';
import { ch, closeOf, closedThrough, ctxOf, dated, firm, owner } from './support/payroll.js';
import { computePayslip } from '../src/payroll/compute.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const year = () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 10000, pensum: 100, hoursPerWeek: 42, thirteenth: { months: [12] } })] })]);
  const events = closedThrough(store, '2026-12');
  events.push(closeOf(computePayslip(ctxOf(store, events), 'e1', '2026-12')!));
  return { store, events, closes: [...historyOf(events).closed.values()] as PayslipClose[] };
};

test('the Lohnausweis of the year, field by field, worked by hand', () => {
  const { store, closes } = year();
  const l = lohnausweisOf(store.employees[0], closes, firmWageTypes(ch.payroll!, store), ch.payroll!, '2026');
  assert.deepEqual(l.fields, { 1: 130000, 8: 130000, 9: 9620, '10.1': 3600, 11: 116780 });
  assert.deepEqual(l.remarks.map((r) => [r.label, r.amount]), [['Krankentaggeld', 650]]);
  assert.deepEqual([l.from, l.to, l.openMonths], ['2026-01-01', '2026-12-31', []]);
});

test('the Lohnkonto agrees with the payslips: field 8 = Σ gross, every Lohnart per month', () => {
  const { store, closes } = year();
  const k = lohnkonto(closes, firmWageTypes(ch.payroll!, store), '2026');
  assert.equal(k.totals.gross.total, 130000);
  assert.equal(k.rows.find((r) => r.wageType === 'monatslohn')!.months.every((m) => m === 10000), true);
  assert.equal(k.rows.find((r) => r.wageType === 'dreizehnter')!.months[11], 10000);
  assert.equal(k.rows.find((r) => r.wageType === 'ahv-an')!.total, 6890);
  const d = declarationRows(store.employees, closes, '2026')[0];
  assert.equal(d.bases.ahv, 130000);
  assert.equal(d.bases['alv|alvCeiling'], 130000, 'the ALV wage as capped');
});

test('a Lohnausweis is issued as a PDF and a snapshot; a replacement stays beside the first', async () => {
  const { store, events } = year();
  const ws = tempWorkspace('payroll-docs-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, store);
  appendPayslipEvents(ws, '2026', events);
  const first = await issueLohnausweis(ws, 'e1', '2026', 'original', '2027-01-15T09:00:00.000Z') as LohnausweisSnapshot;
  assert.equal(readFileSync(join(ws.paths.root, first.file)).subarray(0, 5).toString(), '%PDF-');
  const second = await issueLohnausweis(ws, 'e1', '2026', 'original', '2027-02-01T09:00:00.000Z') as LohnausweisSnapshot;
  assert.deepEqual(lohnausweisSnapshots(ws, '2026').map((s) => [s.kind, s.data.fields['8']]), [['original', 130000], ['replacement', 130000]]);
  assert.notEqual(first.file, second.file);
  assert.ok(!first.file.includes('756'));
});

test('the form\'s sums add up in whole francs; a year with open months is issued only after the warning', async () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 10000.4, pensum: 100, hoursPerWeek: 42 })] })]);
  const events = closedThrough(store, '2026-04');
  const closes = [...historyOf(events).closed.values()];
  const l = lohnausweisOf(store.employees[0], closes, firmWageTypes(ch.payroll!, store), ch.payroll!, '2026');
  assert.ok(Object.values(l.fields).every((v) => Number.isInteger(v)));
  assert.equal(l.fields['11'], l.fields['8'] - l.fields['9'] - l.fields['10.1']);
  assert.equal(l.openMonths.length, 9, 'April to December open');
  const ws = tempWorkspace('payroll-docs-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, store);
  appendPayslipEvents(ws, '2026', events);
  assert.deepEqual(await issueLohnausweis(ws, 'e1', '2026'), { issued: false, openMonths: l.openMonths });
  assert.equal(lohnausweisSnapshots(ws, '2026').length, 0);
  assert.ok('id' in await issueLohnausweis(ws, 'e1', '2026', 'original', undefined, true));
});

test('a firm that started mid-year: the opening counts in the declarations, and its months are not open', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 10000, pensum: 100, hoursPerWeek: 42 })], opening: { 2026: { months: 9, bases: { ahv: 90000, alv: 90000 }, fields: { 1: 90000 } } } })]);
  const tail = closedThroughFrom(store, ['2026-10', '2026-11', '2026-12']);
  const closes = [...historyOf(tail).closed.values()];
  const l = lohnausweisOf(store.employees[0], closes, firmWageTypes(ch.payroll!, store), ch.payroll!, '2026');
  assert.deepEqual(l.openMonths, []);
  assert.equal(l.fields['1'], 120000);
  assert.equal(declarationRows(store.employees, closes, '2026')[0].bases.ahv, 120000);
});

function closedThroughFrom(store: ReturnType<typeof firm>, months: string[]) {
  const out: import('../src/payroll/model.js').PayslipEvent[] = [];
  for (const m of months) out.push(closeOf(computePayslip(ctxOf(store, out), 'e1', m)!));
  return out;
}
