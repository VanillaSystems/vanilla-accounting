/**
 * Values that change over time (src/core/dated.ts, docs/specs/domain-model.md §5, payroll.md §19.4):
 * the value on a day at the edges, two entries of the same day, a month cut where a value changes,
 * the only writer's refusals, and withdrawing only what nobody used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, entriesWithin, planned, valueOn, withdrawEntry, DatedEntryError, type DatedEntry } from '../src/core/dated.js';

const e = (validFrom: string, value: number, enteredAt = `${validFrom}T08:00:00Z`, validUntil?: string): DatedEntry<number> =>
  ({ validFrom, value, enteredAt, ...(validUntil ? { validUntil } : {}) });

test('valueOn: the day before an entry has none, its first day and after have it; a validUntil ends it', () => {
  const h = [e('2026-03-01', 8000), e('2026-07-01', 9000, '2026-06-01T08:00:00Z', '2026-09-30')];
  assert.equal(valueOn(h, '2026-02-28'), undefined, 'nothing before the first entry: a fact, never a guess');
  assert.equal(valueOn(h, '2026-03-01'), 8000);
  assert.equal(valueOn(h, '2026-06-30'), 8000);
  assert.equal(valueOn(h, '2026-07-01'), 9000);
  assert.equal(valueOn(h, '2026-09-30'), 9000, 'validUntil is inclusive');
  assert.equal(valueOn(h, '2026-10-01'), undefined, 'after the end of the last entry: no value');
  assert.equal(valueOn(undefined, '2026-01-01'), undefined);
});

test('valueOn: two entries of the same validFrom are decided by the later enteredAt, wherever they stand in the list', () => {
  const later = e('2026-09-01', 7.8, '2026-11-15T10:00:00Z');
  const earlier = e('2026-09-01', 7.5, '2026-08-20T10:00:00Z');
  assert.equal(valueOn([later, earlier], '2026-09-15'), 7.8);
  assert.equal(valueOn([earlier, later], '2026-09-15'), 7.8);
});

test('entriesWithin: a month cut where the value changes, an ending inside it, and days without a value said so', () => {
  const h = [e('2026-01-01', 8000), e('2026-05-16', 9000)];
  assert.deepEqual(entriesWithin(h, '2026-05-01', '2026-05-31').map((s) => [s.from, s.to, s.entry?.value]),
    [['2026-05-01', '2026-05-15', 8000], ['2026-05-16', '2026-05-31', 9000]]);
  assert.deepEqual(entriesWithin(h, '2026-06-01', '2026-06-30').map((s) => [s.from, s.to, s.entry?.value]), [['2026-06-01', '2026-06-30', 9000]]);
  const exit = [e('2026-01-10', 5000, '2026-01-01T00:00:00Z', '2026-03-15')];
  assert.deepEqual(entriesWithin(exit, '2026-01-01', '2026-01-31').map((s) => [s.from, s.to, s.entry?.value]),
    [['2026-01-01', '2026-01-09', undefined], ['2026-01-10', '2026-01-31', 5000]], 'an entry on the 10th: the days before have none');
  assert.deepEqual(entriesWithin(exit, '2026-03-01', '2026-03-31').map((s) => [s.from, s.to, s.entry?.value]),
    [['2026-03-01', '2026-03-15', 5000], ['2026-03-16', '2026-03-31', undefined]], 'an exit on the 15th');
});

test('planned: only what begins after today', () => {
  const h = [e('2026-01-01', 8000), e('2027-01-01', 9500)];
  assert.deepEqual(planned(h, '2026-11-19').map((x) => x.value), [9500]);
});

test('addEntry: appends and sorts; refuses a malformed day and an end before the start, never an overlap', () => {
  const h = addEntry([e('2026-07-01', 2)], e('2026-01-01', 1));
  assert.deepEqual(h.map((x) => x.value), [1, 2]);
  assert.equal(addEntry(h, e('2026-03-01', 3, '2026-03-01T00:00:00Z', '2026-12-31')).length, 3, 'an overlap is no error: the latest validFrom decides');
  assert.throws(() => addEntry(h, e('2026-02-30', 9)), DatedEntryError);
  assert.throws(() => addEntry(h, e('1.1.2026', 9)), DatedEntryError);
  assert.throws(() => addEntry(h, e('2026-05-01', 9, '2026-05-01T00:00:00Z', '2026-04-30')), DatedEntryError);
});

test('withdrawEntry: a planned entry nobody used goes; one a payslip used stays', () => {
  const plannedRaise = e('2027-01-01', 9500, '2026-11-19T10:00:00Z');
  const h = [e('2026-01-01', 8000), plannedRaise];
  assert.deepEqual(withdrawEntry(h, plannedRaise, () => false).map((x) => x.value), [8000]);
  assert.throws(() => withdrawEntry(h, h[0], () => true), /was used and stays/);
});
