/**
 * payroll.json and payslips.jsonl (src/payroll/store.ts, docs/specs/payroll.md §9.2, §9.3): a workspace
 * without payroll reads as empty, a save round-trips, a newer file is refused with what to do, and the
 * payslips of a year are only ever appended to: an earlier line stays byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendPayslipEvents, emptyPayroll, hasPayroll, loadPayroll, payslipEvents, savePayroll } from '../src/payroll/store.js';
import { PAYROLL_SCHEMA } from '../src/workspace/schema.js';
import { LAYOUT, yearPaths } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';

test('a workspace without payroll.json reads as empty; a save writes the schema and reads back', () => {
  const ws = tempWorkspace('payroll-store-');
  assert.equal(hasPayroll(ws), false);
  assert.deepEqual(loadPayroll(ws), emptyPayroll());
  const store = emptyPayroll();
  store.company.payday = [{ validFrom: '2026-01-01', enteredAt: '2026-01-01T08:00:00Z', value: 25 }];
  savePayroll(ws, store);
  assert.equal(JSON.parse(readFileSync(ws.paths.payroll, 'utf8')).schema, PAYROLL_SCHEMA);
  assert.deepEqual(loadPayroll(ws), store);
});

test('a payroll.json of a newer app is refused with what to do', () => {
  const ws = tempWorkspace('payroll-store-');
  writeFileSync(ws.paths.payroll, JSON.stringify({ schema: PAYROLL_SCHEMA + 1 }));
  assert.throws(() => loadPayroll(ws), /Update the app: npm run update/);
});

test('payslips.jsonl is append-only: a later event leaves every earlier line as it was', () => {
  const ws = tempWorkspace('payroll-store-');
  appendPayslipEvents(ws, '2026', [{ event: 'reopen', id: '2026-09-e1', at: '2026-10-02T08:00:00Z', by: 'person' }]);
  const file = join(yearPaths(ws.paths, '2026').payroll, 'payslips.jsonl');
  const first = readFileSync(file, 'utf8');
  appendPayslipEvents(ws, '2026', [{ event: 'reopen', id: '2026-10-e1', at: '2026-11-02T08:00:00Z', by: 'person' }]);
  assert.ok(readFileSync(file, 'utf8').startsWith(first));
  assert.deepEqual(payslipEvents(ws, '2026').map((e) => e.id), ['2026-09-e1', '2026-10-e1']);
});

test('the layout names payroll.json and the year folder payroll, both the app\'s', () => {
  assert.equal(LAYOUT.top['payroll.json'], 'app');
  assert.equal(LAYOUT.year.payroll, 'app');
});
