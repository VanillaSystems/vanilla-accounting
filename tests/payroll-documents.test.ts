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
import { issueLohnausweis, lohnausweisSnapshots } from '../src/payroll/service.js';
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
  const first = await issueLohnausweis(ws, 'e1', '2026', 'original', '2027-01-15T09:00:00.000Z');
  assert.equal(readFileSync(join(ws.paths.root, first.file)).subarray(0, 5).toString(), '%PDF-');
  const second = await issueLohnausweis(ws, 'e1', '2026', 'replacement', '2027-02-01T09:00:00.000Z');
  assert.deepEqual(lohnausweisSnapshots(ws, '2026').map((s) => [s.kind, s.data.fields['8']]), [['original', 130000], ['replacement', 130000]]);
  assert.notEqual(first.file, second.file);
  assert.ok(!first.file.includes('756'));
});
