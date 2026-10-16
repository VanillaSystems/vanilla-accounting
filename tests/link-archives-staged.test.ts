/**
 * «Zuordnen» by hand of a receipt that still lies in beleg-import/ (staged, no model ran) moves its
 * file into the year's receipts/ and marks it archived, as the model's match step does (r9n-26):
 * «Speichern» then saves the PDF with its link instead of leaving it in the inbox, which the
 * scaffold ignores in git. «Lösen» leaves the file where it is. On the real API server without a model.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index, JournalEntry, Receipt } from '../src/types/index.js';
import { findFile } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;
before(async () => { api = await startApi(FIXTURE); });
after(async () => { await api?.stop(); });

test('r9n-26: linking a staged receipt by hand archives its file; unlinking leaves it archived', async () => {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Index & { journalEntries: JournalEntry[] };
  const staged: Receipt = { id: 'rs', filename: 'HE-2210.pdf', originalFilename: 'HE-2210.pdf', extractedText: 'Holzhandel HE-2210', extractionMethod: 'pdftotext', fileSize: 10, indexedAt: '2026-08-11T08:00:00Z', location: 'staged', date: '2026-08-10', amount: 20, currency: 'CHF' };
  writeIndex(api.ws, { ...f, receipts: [...f.receipts, staged], mappings: f.mappings.filter((m) => m.transactionRef !== 'O1') });
  mkdirSync(api.ws.paths.inbox, { recursive: true });
  writeFileSync(join(api.ws.paths.inbox, 'HE-2210.pdf'), '%PDF-1.4 stub');

  const linked = await api.send('POST', '/api/mapping/add', { receiptId: 'rs', transactionRef: 'O1' });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  const r = loadBooks(api.ws).receipts.find((x) => x.id === 'rs')!;
  assert.equal(r.location, 'archived', 'the receipt is archived');
  assert.equal(r.filename, 'HE-2210.pdf');
  assert.equal(existsSync(join(api.ws.paths.inbox, 'HE-2210.pdf')), false, 'the file left the inbox');
  const archived = findFile(api.ws.paths, 'receipts', 'HE-2210.pdf');
  assert.ok(archived, 'and lies in a year\'s receipts folder');
  assert.equal(readFileSync(archived, 'utf8'), '%PDF-1.4 stub');
  assert.ok(loadBooks(api.ws).mappings.some((m) => m.receiptId === 'rs' && m.transactionRef === 'O1'), 'linked');

  const unlinked = await api.send('POST', '/api/mapping/remove', { receiptId: 'rs', transactionRef: 'O1' });
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.json));
  assert.equal(loadBooks(api.ws).receipts.find((x) => x.id === 'rs')!.location, 'archived', 'an unlink does not stage it again');
  assert.ok(existsSync(archived));
});
