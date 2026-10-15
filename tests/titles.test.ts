/**
 * Receipt titles (src/intake/titles.ts, src/llm/prompts.ts): a receipt read before titles gets one
 * from a batched model call, an answer that is no short vendor and word is not taken, a receipt
 * that has one is not asked again, and the inbox's read step keeps the title its answer carries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks, type Books } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { Ask, BooksPort } from '../src/intake/pipeline.js';
import { titlesStep } from '../src/intake/titles.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { DEMO_ROOT } from './support/workspace.js';

function port(): { books: Books; port: BooksPort } {
  const books: Books = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT))));
  return { books, port: { read: () => structuredClone(books), update: (fn) => fn(books) } };
}

test('every receipt without a title gets the one the model names; a long or missing one is not taken and said', async () => {
  const { books, port: p } = port();
  const [a, b, c] = books.receipts;
  const asked: string[] = [];
  const ask: Ask = async (prompt) => { asked.push(prompt); return `Hier: {"${a.id}": {"v": "Coop Pronto", "w": "Benzin"}, "${b.id}": {"v": "Grünkaffee Muster", "w": "${'x'.repeat(60)}"}}`; };
  const { notes } = await titlesStep()({ ws: undefined as never, books: p, ask, progress: () => {}, log: () => {} });
  assert.deepEqual(books.receipts.find((r) => r.id === a.id)!.title, { vendor: 'Coop Pronto', what: 'Benzin' });
  assert.equal(books.receipts.find((r) => r.id === b.id)!.title, undefined, 'a «word» of 60 characters is no title');
  assert.equal(books.receipts.find((r) => r.id === c.id)!.title, undefined);
  assert.deepEqual(notes.map((n) => [n.code, n.code === 'failed' && n.count]), [['failed', books.receipts.length - 1]]);
  assert.equal(asked.length, Math.ceil(books.receipts.length / 100));
  asked.length = 0;
  await titlesStep()({ ws: undefined as never, books: p, ask, progress: () => {}, log: () => {} });
  assert.ok(!asked.join('').includes(`"id":"${a.id}"`), 'a receipt with its title is not asked again');
});

test('the inbox\'s answer carries the title; a malformed one is dropped, the answer stays', () => {
  const base = { suggestedFilename: '20260814-coop-pronto.pdf', matchedTransactionRefs: [], date: '2026-08-14', description: 'Coop Pronto Benzin', amount: 62.47, currency: 'CHF', confidence: 0.9 };
  assert.deepEqual(parseMatchResult(JSON.stringify({ ...base, title: { v: 'Coop Pronto', w: 'Benzin' } }))?.title, { vendor: 'Coop Pronto', what: 'Benzin' });
  const odd = parseMatchResult(JSON.stringify({ ...base, title: 'Coop Pronto Benzin' }));
  assert.equal(odd?.title, undefined);
  assert.equal(odd?.description, 'Coop Pronto Benzin');
});
