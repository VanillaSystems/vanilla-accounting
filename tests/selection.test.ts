/**
 * Several rows picked at once (#216, src/app/selection/model.ts): ⌘-click toggles, ⇧-click picks
 * a range of the rows shown, ⌘A the rows shown, a filter keeps only rows still shown, and the
 * limit says how many it left out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SELECTED, all, clickWay, keepShown, range, spanOf, toggle } from '../src/app/selection/model.js';

const shown = ['a', 'b', 'c', 'd', 'e'];

test('⌘-click toggles a row; the first one picks the open row too', () => {
  const first = toggle(undefined, 'receipt', 'c', 'a').sel;
  assert.deepEqual(first?.ids, ['a', 'c'], 'the row open before is the one the person looked at');
  const more = toggle(first, 'receipt', 'd').sel;
  assert.deepEqual(more?.ids, ['a', 'c', 'd']);
  const less = toggle(more, 'receipt', 'a').sel;
  assert.deepEqual(less?.ids, ['c', 'd']);
  assert.equal(toggle(toggle(undefined, 'receipt', 'c').sel, 'receipt', 'c').sel, undefined, 'the last row out: no selection');
});

test('another list\'s selection is none here: a ⌘-click starts afresh', () => {
  const entries = toggle(undefined, 'entry', 'x').sel;
  assert.deepEqual(toggle(entries, 'receipt', 'c').sel, { kind: 'receipt', ids: ['c'], anchor: 'c' });
});

test('⇧-click picks the shown rows from the anchor, added to those picked', () => {
  const one = toggle(undefined, 'payment', 'b').sel;
  assert.deepEqual(range(one, 'payment', shown, 'd').sel?.ids, ['b', 'c', 'd']);
  assert.deepEqual(range(one, 'payment', shown, 'a').sel?.ids, ['b', 'a']);
  assert.deepEqual(range(undefined, 'payment', shown, 'c', 'e').sel?.ids, ['c', 'd', 'e'], 'without an anchor, from the open row');
  assert.deepEqual(range(undefined, 'payment', ['x', 'c'], 'c', 'a').sel?.ids, ['x', 'c'], 'an open row not shown: from the first shown');
});

test('⌘A picks the rows shown, and the limit says how many it left out', () => {
  assert.deepEqual(all('entry', shown).sel?.ids, shown);
  const many = Array.from({ length: MAX_SELECTED + 37 }, (_, i) => `e${i}`);
  const p = all('entry', many);
  assert.equal(p.sel?.ids.length, MAX_SELECTED);
  assert.equal(p.leftOut, 37);
  assert.equal(all('entry', []).sel, undefined);
});

test('a filter keeps only rows still shown; none left: no selection', () => {
  const sel = all('receipt', shown).sel;
  assert.deepEqual(keepShown(sel, ['b', 'd', 'z'])?.ids, ['b', 'd']);
  assert.equal(keepShown(sel, ['z']), undefined);
  assert.equal(keepShown(sel, shown), sel, 'unchanged rows keep the same selection object');
});

test('a click\'s keys: ⌘ or Ctrl toggles, ⇧ ranges, plain opens', () => {
  assert.equal(clickWay({ metaKey: true, ctrlKey: false, shiftKey: false }), 'toggle');
  assert.equal(clickWay({ metaKey: false, ctrlKey: true, shiftKey: true }), 'toggle');
  assert.equal(clickWay({ metaKey: false, ctrlKey: false, shiftKey: true }), 'range');
  assert.equal(clickWay({ metaKey: false, ctrlKey: false, shiftKey: false }), 'open');
});

test('the span of a selection is its first and last day', () => {
  assert.deepEqual(spanOf(['2026-08-03', undefined, '2026-07-01', '2026-09-30']), { from: '2026-07-01', to: '2026-09-30' });
  assert.equal(spanOf([undefined]), undefined);
});
