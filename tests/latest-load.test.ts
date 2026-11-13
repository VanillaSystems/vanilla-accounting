/**
 * The books' loads of the pages (src/app/hooks/use-index.ts, src/app/lib/latest-load.ts, #424): of
 * two loads close together, the earlier one answering last never puts the books of before back on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestLoad } from '../src/app/lib/latest-load.js';

/** Loads as useIndex runs them: each begun, its answer after `ms`, shown when `current()` says so. */
function pages() {
  const begin = latestLoad();
  let shown = 'none';
  const load = (books: string, ms: number) => {
    const current = begin();
    return new Promise<void>((done) => setTimeout(() => { if (current()) shown = books; done(); }, ms));
  };
  return { load, shown: () => shown };
}

test('two overlapping loads, the first delayed: the later books stay on screen', async () => {
  const p = pages();
  await Promise.all([p.load('before the drop', 40), p.load('after the drop', 5)]);
  assert.equal(p.shown(), 'after the drop');
});

test('loads answering in order are each shown, so books that move while loads overlap still show', async () => {
  const p = pages();
  const first = p.load('step 1', 5);
  const second = p.load('step 2', 40);
  await first;
  assert.equal(p.shown(), 'step 1', 'the earlier answer is shown until the later comes');
  await second;
  assert.equal(p.shown(), 'step 2');
});
