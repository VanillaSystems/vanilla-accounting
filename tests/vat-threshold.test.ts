/**
 * A firm not registered for VAT watches its calendar year's turnover against the registration
 * threshold (modules/ch/registration.yaml, src/app/areas/vat/model.ts thresholdWatch): a warning
 * before the limit, from 90 % reached or 90 % projected at the year's pace, and «passed» from the
 * limit on, which Aufgaben turns into a task (r5f-9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { NOT_REGISTERED } from '../src/workspace/vat-setup.js';
import { setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { thresholdWatch, thresholdYears } from '../src/app/areas/vat/model.js';
import type { JournalEntry } from '../src/types/index.js';

setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction, NOT_REGISTERED);

const sale = (id: string, date: string, amount: number, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: '1020', accountCredit: '3400', amount, ...x });

const watch = (turnover: number, today: string, year = '2026') => thresholdWatch([sale('s', `${year}-01-05`, turnover)], year, today)!;

test('the finding: CHF 85\'944.77 on 2 October is 86 % reached, but the year\'s pace projects past the limit: a warning', () => {
  const w = watch(85944.77, '2026-10-02');
  assert.deepEqual([w.threshold, w.turnover, w.percent, w.level], [100000, 85944.77, 86, 'near']);
  assert.ok(w.projected > 100000 && w.projected < 120000, String(w.projected));
});

test('reached 90 % late in the year warns even when the pace would not', () => {
  const w = watch(92000, '2026-12-28');
  assert.deepEqual([w.percent, w.level], [92, 'near']);
  assert.ok(w.projected < 100000, 'the pace alone would not warn');
});

test('half the limit at year end is fine; a strong January is no projection yet', () => {
  assert.equal(watch(50000, '2026-12-31').level, 'ok');
  const jan = watch(30000, '2026-02-15');
  assert.equal(jan.level, 'ok', 'under 91 days the pace says nothing');
  assert.equal(jan.projected, 30000, 'no projection: the figure stays what was reached');
});

test('the limit reached is passed; a refund counts against the turnover', () => {
  assert.equal(watch(100744.77, '2026-10-02').level, 'passed');
  const w = thresholdWatch([sale('a', '2026-03-01', 100500), sale('b', '2026-03-02', 600, { accountDebit: '3400', accountCredit: '1020' })], '2026', '2026-10-02')!;
  assert.deepEqual([w.turnover, w.level], [99900, 'near']);
});

test('a past year projects nothing beyond itself; the years to watch are this one and the one before while it is not closed', () => {
  assert.deepEqual([watch(60000, '2026-10-16', '2025').projected, watch(60000, '2026-10-16', '2025').level], [60000, 'ok']);
  assert.deepEqual(thresholdYears('2026-02-10', '2025-09-30'), ['2025', '2026']);
  assert.deepEqual(thresholdYears('2026-02-10', '2025-12-31'), ['2026'], 'the year closed: its task went with the year close');
  assert.deepEqual(thresholdYears('2026-10-16', undefined), ['2025', '2026']);
});
