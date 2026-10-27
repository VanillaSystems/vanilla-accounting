/**
 * A list's filter as chips (#211, src/app/shell/chips.ts): a chip's URL token, which chips a list
 * keeps, AND across fields and OR within one, a single-value field replacing its chip, the empty
 * list's explanation, and the search box's suggestions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addChip, applyChips, chipToken, excluding, knownChips, parseAmount, parseChip, rangeFields, removeChip, suggestions, type Field } from '../src/app/shell/chips.js';

interface Row { id: string; who: string; amount: number; date: string }
const rows: Row[] = [
  { id: 'a', who: 'fedex', amount: 40, date: '2026-08-03' },
  { id: 'b', who: 'amazon', amount: 120, date: '2026-08-20' },
  { id: 'c', who: 'fedex', amount: 300, date: '2026-09-02' },
];
const words = { over: () => 'over', under: () => 'under', exact: () => 'exactly', month: () => 'month', from: () => 'from', to: () => 'to', money: String, day: (d: string) => d, monthName: (d: string) => d.slice(0, 7) };
const fields: Array<Field<Row>> = [
  {
    id: 'who', label: () => 'Partner', input: 'pick', multi: true,
    options: (rs) => [...new Set(rs.map((r) => r.who))].map((w) => ({ value: w, label: w === 'fedex' ? 'FedEx' : 'Amazon' })),
    valueLabel: (v) => v, test: (v) => (r) => r.who === v,
  },
  ...rangeFields<Row>((r) => r.amount, (r) => r.date, words),
];
const ids = (chips: Array<{ field: string; value: string }>) => applyChips(rows, chips, fields).map((r) => r.id);

test('a chip is <field>_<value> in the URL: the first _ ends the field, which is lower-case letters', () => {
  assert.deepEqual(parseChip('partner_cu_42'), { field: 'partner', value: 'cu_42' });
  assert.equal(chipToken({ field: 'over', value: '100.5' }), 'over_100.5');
  assert.equal(parseChip('Partner_x'), undefined);
  assert.equal(parseChip('partner_'), undefined);
  assert.equal(parseChip('nothing'), undefined);
});

test('AND across fields, OR within one; a bound takes one value, its new chip replaces the old', () => {
  assert.deepEqual(ids([{ field: 'who', value: 'fedex' }]), ['a', 'c']);
  assert.deepEqual(ids([{ field: 'who', value: 'fedex' }, { field: 'who', value: 'amazon' }]), ['a', 'b', 'c'], 'FedEx or Amazon');
  assert.deepEqual(ids([{ field: 'who', value: 'fedex' }, { field: 'over', value: '100' }]), ['c'], 'FedEx and over 100');
  assert.deepEqual(ids([{ field: 'from', value: '2026-08-10' }, { field: 'to', value: '2026-08-31' }]), ['b']);
  assert.deepEqual(ids([{ field: 'month', value: '2026-08' }, { field: 'under', value: '100' }]), ['a']);
  assert.deepEqual(ids([{ field: 'amount', value: '120' }]), ['b']);
  const once = addChip([{ field: 'over', value: '10' }], { field: 'over', value: '50' }, fields);
  assert.deepEqual(once, [{ field: 'over', value: '50' }], 'a second «over» replaces the first');
  const both = addChip([{ field: 'who', value: 'fedex' }], { field: 'who', value: 'amazon' }, fields);
  assert.deepEqual(both.map(chipToken), ['who_fedex', 'who_amazon']);
  assert.deepEqual(removeChip(both, { field: 'who', value: 'fedex' }).map(chipToken), ['who_amazon']);
});

test('a list keeps the chips it knows, grouped by field, each once; a stale or unknown one is dropped', () => {
  const kept = knownChips([
    { field: 'over', value: '10' }, { field: 'who', value: 'fedex' }, { field: 'nope', value: 'x' },
    { field: 'over', value: 'abc' }, { field: 'who', value: 'fedex' }, { field: 'month', value: '2026-8' }, { field: 'who', value: 'amazon' },
  ], fields);
  assert.deepEqual(kept.map(chipToken), ['who_fedex', 'who_amazon', 'over_10']);
});

test('an empty list says which fields exclude everything, and what removing each would show', () => {
  assert.deepEqual(excluding(rows, [{ field: 'who', value: 'amazon' }, { field: 'over', value: '500' }], fields), {
    alone: ['over'], without: [{ field: 'who', n: 0 }, { field: 'over', n: 1 }],
  });
  assert.deepEqual(excluding(rows, [{ field: 'who', value: 'amazon' }, { field: 'month', value: '2026-09' }], fields), {
    alone: [], without: [{ field: 'who', n: 1 }, { field: 'month', n: 1 }],
  }, 'each matches on its own, only together nothing');
});

test('typed text offers the matching values of the pick fields, not those already chosen', () => {
  assert.deepEqual(suggestions('fed', rows, fields, []).map((s) => `${s.field.id}_${s.option.value}`), ['who_fedex']);
  assert.deepEqual(suggestions('fed', rows, fields, [{ field: 'who', value: 'fedex' }]), []);
  assert.deepEqual(suggestions('2026-09', rows, fields, []).map((s) => `${s.field.id}_${s.option.value}`), ['month_2026-09']);
  assert.deepEqual(suggestions('  ', rows, fields, []), []);
});

test('a typed amount reads Swiss and German spellings', () => {
  assert.equal(parseAmount("1'200.50"), 1200.5);
  assert.equal(parseAmount('99,9'), 99.9);
  assert.equal(parseAmount('abc'), undefined);
  assert.equal(parseAmount(''), undefined);
});
