/**
 * A list's selection follows its rows only when they change under it (src/app/hooks/use-selection-follows-rows.ts).
 * A link that changes the selection and the rows at once (a camt.053 dropped on Kontoauszüge opens its
 * new statement in another quarter, before the books that hold it have loaded) keeps its object:
 * the smoke of 0.4.0 found the page on October's «fehlt» row instead of the statement of 12 November.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followedSelection } from '../src/app/hooks/use-selection-follows-rows.js';

test('a filter that hides the selected row selects the first row it shows', () => {
  assert.equal(followedSelection({ selected: 'b', ids: ['a', 'b', 'c'] }, { selected: 'b', ids: ['a', 'c'] }), 'a');
});

test('rows that still hold the selection, or rows that did not change, leave it', () => {
  assert.equal(followedSelection({ selected: 'b', ids: ['a', 'b'] }, { selected: 'b', ids: ['b', 'c'] }), undefined);
  assert.equal(followedSelection({ selected: 'b', ids: ['a', 'b'] }, { selected: 'x', ids: ['a', 'b'] }), undefined);
});

test('a link into another period keeps its statement while the books that hold it load', () => {
  // Q3 on screen; the drop goes to Q4's new statement, whose rows of the old books show only October's gap.
  const link = followedSelection({ selected: '1021-2026-09', ids: ['1021-2026-07', '1021-2026-08', '1021-2026-09'] }, { selected: '1021-2026-11-12', ids: ['1021-2026-10'] });
  assert.equal(link, undefined);
  // The books arrive with it: the selection stays.
  assert.equal(followedSelection({ selected: '1021-2026-11-12', ids: ['1021-2026-10'] }, { selected: '1021-2026-11-12', ids: ['1021-2026-10', '1021-2026-11-12'] }), undefined);
});

test('hold keeps a file linked in another period', () => {
  assert.equal(followedSelection({ selected: 'b', ids: ['a', 'b'] }, { selected: 'b', ids: ['a'] }, true), undefined);
});
