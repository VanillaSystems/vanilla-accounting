/**
 * Automatisierung offers no period that ended before the books' first day (#362, first-ai-31: fresh
 * books beginning in July 2026 offered Q1–Q4 2025), and the period it shows always.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodsAround } from '../src/app/areas/automation/periods.js';
import { parsePeriod } from '../src/accounting/periods.js';
import './support/jurisdiction.js';

const TODAY = '2026-11-12';
const q3 = parsePeriod('2026-Q3', TODAY)!;

test('the period list starts at the quarter of the books\' first day', () => {
  assert.deepEqual(periodsAround(q3, TODAY, '2026-07-02', 'quarter').map((p) => p.token), ['2026-Q3', '2026-Q4']);
});

test('books with nothing dated yet, or older books, offer the two years as before', () => {
  assert.deepEqual(periodsAround(q3, TODAY, undefined, 'quarter').map((p) => p.token), ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.equal(periodsAround(q3, TODAY, '2024-03-01', 'quarter').length, 8);
});

test('the shown period stays in the list, even before the first day', () => {
  const q1 = parsePeriod('2026-Q1', TODAY)!;
  assert.deepEqual(periodsAround(q1, TODAY, '2026-07-02', 'quarter').map((p) => p.token), ['2026-Q1', '2026-Q3', '2026-Q4']);
});
