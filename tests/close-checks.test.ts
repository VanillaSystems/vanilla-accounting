/**
 * Abschluss › «Prüfen, was offen ist»: the payments a failing «every transaction booked» check
 * names (src/accounting/year-close.ts unbookedRefs), which the page links one by one instead of
 * printing the refs as text (r8c-10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unbookedRefs, type Check } from '../src/accounting/year-close.js';

test('the unbooked transactions of the year, from the check; none when every transaction is booked', () => {
  const checks: Check[] = [
    { id: 'quartersSealed', status: 'ok', problems: [] },
    { id: 'allBooked', status: 'fail', problems: [{ code: 'unbooked', count: 2, refs: ['90000000079', '90000000080'] }] },
  ];
  assert.deepEqual(unbookedRefs(checks), ['90000000079', '90000000080']);
  assert.deepEqual(unbookedRefs([{ id: 'allBooked', status: 'ok', problems: [] }]), []);
});
