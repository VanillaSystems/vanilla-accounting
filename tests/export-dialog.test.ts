/**
 * The export dialog's state (src/app/areas/export/config.ts): a built-in preset keeps the period
 * the person picked, and the period row offers the half years of a half-yearly firm (UAT F11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriod } from '../src/accounting/periods.js';
import { choosePeriod, choosePreset, configOf, periodRow, presetFor } from '../src/app/areas/export/config.js';

const today = '2026-11-02';
const H2 = parsePeriod('2026-H2', today)!;

test('a preset keeps the period the person picked', () => {
  const opened = presetFor({ area: 'receipts' } as Parameters<typeof presetFor>[0], H2, H2);
  const audit = choosePreset(choosePeriod(opened, '2026-H1'), 'audit', H2, H2);
  assert.equal(audit.period, '2026-H1');
  assert.equal(audit.preset, 'audit');
  assert.deepEqual(audit.items, configOf('audit', H2, H2).items);
  assert.equal(choosePreset(audit, 'treuhand', H2, H2).period, '2026-H1', 'and the next preset keeps it too');
});

test('a preset brings its own period while the person picked none', () => {
  const opened = presetFor({ area: 'receipts' } as Parameters<typeof presetFor>[0], H2, H2);
  assert.equal(choosePreset(opened, 'audit', H2, H2).period, '2026');
  assert.equal(choosePreset(opened, 'treuhand', H2, H2).period, '2026-H2');
});

test('the period row offers half years only where the firm files half-yearly', () => {
  assert.deepEqual(periodRow('2026', 'half', '2026-H2', '2026'), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', '2026-H1', '2026-H2', '2026', 'ytd']);
  assert.deepEqual(periodRow('2026', 'quarter', '2026-Q3', '2026-Q3'), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', '2026', 'ytd']);
});
