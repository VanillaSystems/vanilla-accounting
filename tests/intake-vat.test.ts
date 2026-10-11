/**
 * The VAT step fills in facts a receipt lacks; it never takes facts away on a model answer that
 * failed, was empty or does not carry VAT facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Books } from '../src/books/store.js';
import type { Ask, BooksPort } from '../src/intake/pipeline.js';
import { vatStep } from '../src/intake/vat.js';
import type { Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

const FACTS = ['vatId', 'hasSwissVat', 'vatSummary', 'lineItems', 'vatExtractedAt'] as const;
const facts = (r: Receipt) => Object.fromEntries(FACTS.map((k) => [k, r[k]]));

const NEW: Receipt = {
  id: 'vat-step-new', filename: '20260801-new.pdf', originalFilename: '20260801-new.pdf',
  extractedText: 'Kaffee AG\nTotal CHF 10.80\nMWST 8.1% CHF 0.81', extractionMethod: 'pdftotext',
  fileSize: 2000, indexedAt: '2026-08-01T00:00:00.000Z', location: 'archived',
};

function run(answer: () => Promise<string>, force = false) {
  const books: Books = JSON.parse(readFileSync(join(DEMO_ROOT, 'books.json'), 'utf8'));
  books.receipts.push(structuredClone(NEW));
  const port: BooksPort = { read: () => structuredClone(books), update: (fn) => fn(books) };
  const asked: string[] = [];
  const ask: Ask = async (prompt) => { asked.push(prompt); return answer(); };
  const before = structuredClone(books.receipts);
  return vatStep({ force })({ ws: undefined as never, books: port, ask, progress: () => {}, log: () => {} })
    .then((result) => ({ result, before, after: books.receipts, asked }));
}

const UNUSABLE: Array<[string, () => Promise<string>]> = [
  ['an empty answer', async () => ''],
  ['an empty object', async () => '{}'],
  ['an answer to another prompt', async () => JSON.stringify({ suggestedFilename: '20260812-stub-shop.pdf', date: '2026-08-12', amount: 50, currency: 'EUR' })],
  ['a failed call', async () => { throw new Error('claude exited 1'); }],
];

for (const [what, answer] of UNUSABLE) {
  for (const force of [false, true]) {
    test(`${what}${force ? ' (--force)' : ''} erases no facts and records none`, async () => {
      const { result, before, after } = await run(answer, force);
      const withFacts = before.filter((r) => r.hasSwissVat !== undefined);
      assert.ok(withFacts.some((r) => !r.vatExtractedAt && r.hasSwissVat), 'the demo has receipts whose facts the books wrote');
      for (const r of withFacts) assert.deepEqual(facts(after.find((x) => x.id === r.id)!), facts(r), r.filename);
      assert.deepEqual(facts(after.find((r) => r.id === NEW.id)!), facts(NEW), 'the new receipt still waits for its facts');
      assert.deepEqual(result.notes.map((n) => n.code), ['failed']);
    });
  }
}

test('facts the books already hold are not asked for again; a receipt without them gets the answer', async () => {
  const answer = { vatId: 'CHE-111.222.333', currency: 'CHF', total: 10.8, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 0.81, gross: 10.8 }] };
  const { result, before, after, asked } = await run(async () => JSON.stringify(answer));
  assert.equal(asked.length, before.filter((r) => r.hasSwissVat === undefined && !r.vatExtractedAt && /MWST/.test(r.extractedText)).length);
  assert.ok(asked.some((p) => p.includes('Kaffee AG')));
  for (const r of before.filter((x) => x.hasSwissVat !== undefined)) assert.deepEqual(facts(after.find((x) => x.id === r.id)!), facts(r), r.filename);
  const fresh = after.find((r) => r.id === NEW.id)!;
  assert.equal(fresh.hasSwissVat, true);
  assert.equal(fresh.vatId, 'CHE-111.222.333');
  assert.ok(fresh.vatExtractedAt);
  assert.deepEqual(result.notes, []);
});
