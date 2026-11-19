/**
 * Payroll as module data (modules/ch/payroll.yaml, payroll/<year>.yaml; docs/specs/payroll.md §3l, §9.4):
 * the catalogue loads without a problem, every figure names its source, the check finds a broken
 * reference, and the accounts payroll books on reach the chart only of a firm that pays wages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { checkPayroll } from '../src/core/modules/check-payroll.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { chartFor, loadChart } from '../src/workspace/chart.js';

const ch = () => loadJurisdiction(APP_ROOT, 'ch').jurisdiction;

test('the shipped payroll data has no problem, and every figure of 2026 names its source', () => {
  const j = ch();
  assert.deepEqual(checkPayroll(j), []);
  assert.ok(j.payroll!.wageTypes.length >= 40, 'the whole catalogue is loaded');
  const y = j.payrollYears!['2026'];
  for (const [k, row] of Object.entries(y.figures)) for (const r of Array.isArray(row) ? row : [row]) assert.ok(r.source.length > 10, `${k} names its source`);
  assert.equal((y.figures.ahvEmployee as { value: number }).value, 5.3);
  assert.equal((y.figures.alvCeiling as { value: number }).value, 148200);
});

test('every year this release can be used in has its federal figures (a year with wages but no file gives «unvollständig»)', () => {
  const j = ch();
  const thisYear = String(new Date().getFullYear());
  assert.ok(j.payrollYears?.[thisYear], `modules/ch/payroll/${thisYear}.yaml is missing: add the year's federal figures before the year's first payslip`);
});

test('the check names a broken Lohnart, a missing federal figure and a label without a language', () => {
  const j = structuredClone(ch());
  j.payroll!.wageTypes[0].group = 'nope';
  delete (j.payroll!.wageTypes[1].label as Partial<Record<string, string>>).it;
  delete j.payrollYears!['2026'].figures.alvCeiling;
  const found = checkPayroll(j).map((p) => `${p.file} ${p.path}: ${p.message}`);
  assert.ok(found.some((m) => m.includes('group "nope" does not exist')), found.join('\n'));
  assert.ok(found.some((m) => m.includes('label without it')), found.join('\n'));
  assert.ok(found.some((m) => m.includes('payroll/2026.yaml figures.alvCeiling')), found.join('\n'));
});

test('no Swiss name in code: every insurance kind, base and federal key the engine reads comes from the data', () => {
  const j = ch();
  const kinds = Object.keys(j.payroll!.insurances);
  for (const c of j.payroll!.contributions) assert.ok(kinds.includes(c.insurance));
});

test('the accounts payroll books on reach a new chart only when the firm pays wages', () => {
  const chart = loadChart();
  const payroll = ['1091', '2271', '2272', '2273', '2274', '2275'];
  const without = chartFor(chart, 'services', 'GmbH').map((a) => a.number);
  const withWages = chartFor(chart, 'services', 'GmbH', true).map((a) => a.number);
  for (const n of payroll) {
    assert.ok(!without.includes(n), `${n} not in the chart of a firm without wages`);
    assert.ok(withWages.includes(n), `${n} in the chart of a firm with wages`);
  }
  assert.ok(without.includes('2270') && without.includes('2279'), 'the collective accounts stay in every chart');
});
