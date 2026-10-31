/**
 * The filed returns are read once per year for one load of the books, and again for the next load
 * (r8f-45): a filing made in the app is seen as soon as the books are loaded again, without a reload
 * of the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perBooks } from '../src/app/areas/vat/filed-cache.js';

test('one read per year while the books are the same object; a new load of the books reads again', async () => {
  const reads: string[] = [];
  const filed = perBooks(async (year) => { reads.push(year); return reads.length; });
  const books = { config: {} };
  assert.equal(await filed(books, '2026'), 1);
  assert.equal(await filed(books, '2026'), 1, 'the same books: the first read is kept');
  assert.equal(await filed(books, '2025'), 2, 'another year is another read');
  assert.deepEqual(reads, ['2026', '2025']);

  const loadedAgain = { config: {} };
  assert.equal(await filed(loadedAgain, '2026'), 3, 'the books loaded again (after a filing): read again');
  assert.equal(await filed(loadedAgain, '2026'), 3);
});
