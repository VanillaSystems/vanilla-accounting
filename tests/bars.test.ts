/**
 * The top bar's pin (src/app/shell/bars.ts, docs/0.4.0/views.md "The top bar"): open unless the person
 * unpinned it, and only her own choice folds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODE, parseMode } from '../src/app/shell/bars.js';

test('the top bar stands open for a person who never touched its pin', () => {
  assert.equal(DEFAULT_MODE, 'always');
  assert.equal(parseMode(null), 'always');
  assert.equal(parseMode('{"mode":"auto","uses":3,"tip":false}'), 'always', 'a value of another shape is no choice');
});

test('her choice is kept: unpinned it folds, pinned it stays open', () => {
  assert.equal(parseMode('auto'), 'auto');
  assert.equal(parseMode('always'), 'always');
});
