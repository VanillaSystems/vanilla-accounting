/**
 * A list + detail view selects its first visible row while nothing is selected
 * (src/app/hooks/use-auto-select-first.ts); a deep-linked selection always wins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSelection } from '../src/app/hooks/use-auto-select-first.js';

const KEEP = undefined;

test('opening with nothing selected selects the first row', () => {
  assert.equal(autoSelection(['a', 'b'], null, true), 'a');
});

test('a deep link is kept on opening, even when the list does not show it', () => {
  assert.equal(autoSelection(['a', 'b'], 'b', true), KEEP);
  assert.equal(autoSelection(['a', 'b'], 'z', true), KEEP);
});

test('a changed list keeps a selection it still holds', () => {
  assert.equal(autoSelection(['c', 'b'], 'b', false), KEEP);
});

test('a changed list without the selection moves to its new first row', () => {
  assert.equal(autoSelection(['c', 'd'], 'b', false), 'c');
  assert.equal(autoSelection(['c', 'd'], null, false), 'c');
});

test('an empty list clears the selection, so the placeholder shows', () => {
  assert.equal(autoSelection([], 'b', false), null);
  assert.equal(autoSelection([], null, true), KEEP);
});
