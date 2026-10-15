/**
 * The VAT step fills in facts a receipt lacks; it never takes facts away on a model answer that
 * failed, was empty or does not carry VAT facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, type Books } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { Ask, BooksPort } from '../src/intake/pipeline.js';
import { vatCandidates, vatStep } from '../src/intake/vat.js';
import type { Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const FACTS = ['vatId', 'hasSwissVat', 'vatSummary', 'lineItems', 'vatExtractedAt'] as const;
const facts = (r: Receipt) => Object.fromEntries(FACTS.map((k) => [k, r[k]]));

const NEW: Receipt = {
  id: 'vat-step-new', filename: '20260801-new.pdf', originalFilename: '20260801-new.pdf',
  extractedText: 'Kaffee AG\nTotal CHF 10.80\nMWST 8.1% CHF 0.81', extractionMethod: 'pdftotext',
  fileSize: 2000, indexedAt: '2026-08-01T00:00:00.000Z', location: 'archived',
};

function run(answer: () => Promise<string>, force = false) {
  const books: Books = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT))));
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

test('a scan too poor to read is set aside once, with a note, and not taken up again; a receipt of a filed quarter is never taken up', async () => {
  const books: Books = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT))));
  const closed = books.config.closedThrough!;
  const filedTx = books.transactions.find((t) => t.date <= closed)!;
  const POOR: Receipt = { ...structuredClone(NEW), id: 'vat-step-poor', filename: '20260814-coop-pronto.pdf', originalFilename: '20260814-coop-pronto.pdf', extractedText: 'mit Tankstelle\n|', date: '2026-08-14' };
  const FILED: Receipt = { ...structuredClone(NEW), id: 'vat-step-filed', filename: '20260104-filed.pdf', originalFilename: '20260104-filed.pdf', extractedText: 'Laden AG\nTotal CHF 59.06\nMWST 8.1% CHF 4.42' };
  books.receipts.push(POOR, FILED);
  books.mappings.push({ transactionRef: filedTx.ref, receiptId: FILED.id });
  const port: BooksPort = { read: () => structuredClone(books), update: (fn) => fn(books) };
  const asked: string[] = [];
  const ask: Ask = async (prompt) => { asked.push(prompt); return JSON.stringify({ vatId: '', currency: 'CHF', total: 1, hasSwissVat: false, vatSummary: [] }); };
  const step = () => vatStep()({ ws: undefined as never, books: port, ask, progress: () => {}, log: () => {} });

  assert.deepEqual(vatCandidates(books).map((r) => r.id).filter((id) => id === POOR.id || id === FILED.id), [POOR.id], 'the filed receipt is not even listed');
  const first = await step();
  assert.deepEqual(first.notes.filter((n) => n.code === 'poorScan'), [{ code: 'poorScan', files: [POOR.filename] }]);
  assert.equal(books.receipts.find((r) => r.id === POOR.id)!.needsVisionReview, true);
  assert.ok(!asked.some((p) => p.includes('Laden AG')), 'the filed receipt was not sent to the model');
  assert.deepEqual(facts(books.receipts.find((r) => r.id === FILED.id)!), facts(FILED), 'nor changed');

  const askedBefore = asked.length;
  assert.equal(vatCandidates(books).some((r) => r.id === POOR.id || r.id === FILED.id), false);
  const second = await step();
  assert.deepEqual(second.notes, [], 'nothing to say the second time');
  assert.equal(asked.length, askedBefore);
});

test('without a model: a receipt whose text proves Swiss VAT gets it from the text, one whose figures do not add up waits', async () => {
  const books: Books = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT))));
  const proven: Receipt = { ...structuredClone(NEW), id: 'vat-text-proven', extractedText: 'Kaffee AG\nCHE-123.456.789 MWST\nTotal exkl. MWST\nMWST 8.1%\nTotal CHF\n100.00\n8.10\n108.10' };
  const unclear: Receipt = { ...structuredClone(NEW), id: 'vat-text-unclear', extractedText: 'Kaffee AG\nCHE-123.456.789 MWST\nTotal CHF 10.80\nMWST 8.1% CHF 0.90' };
  books.receipts.push(proven, unclear);
  const port: BooksPort = { read: () => structuredClone(books), update: (fn) => fn(books) };
  const { notes } = await vatStep()({ ws: undefined as never, books: port, ask: undefined, progress: () => {}, log: () => {} });
  const after = (id: string) => books.receipts.find((r) => r.id === id)!;
  assert.equal(after(proven.id).hasSwissVat, true);
  assert.deepEqual(after(proven.id).vatSummary, [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }]);
  assert.equal(after(proven.id).vatId, 'CHE-123.456.789');
  assert.equal(after(unclear.id).hasSwissVat, undefined, 'figures that do not add up stay for the model');
  assert.ok(notes.some((n) => n.code === 'noModel'));
});
