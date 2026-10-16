/**
 * «Nach Beleg buchen» on an entry (Buchungen): PATCH /api/journal-entries/:id with the proposed code
 * and the receipts seen writes both, as a person's entry. Runs the real API server against
 * tests/fixtures/period-lock-index.json.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;

before(async () => { api = await startApi(FIXTURE); });
after(async () => { await api?.stop(); });
beforeEach(() => writeIndex(api.ws, JSON.parse(readFileSync(FIXTURE, 'utf8'))));

const entry = (id: string) => loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.find((e) => e.id === id)!;

test('the proposal sets the code and records the receipts; the entry stays a person\'s', async () => {
  const { status, json } = await api.send('PATCH', '/api/journal-entries/jo', { vatCode: 'I0', receipts: ['ro'] });
  assert.equal(status, 200, String(json.error));
  const jo = entry('jo');
  assert.equal(jo.vatCode, 'I0');
  assert.deepEqual(jo.receipts, ['ro']);
  assert.equal(jo.origin, 'manual');
});

test('receipts the books do not hold are refused, nothing changes', async () => {
  const { status } = await api.send('PATCH', '/api/journal-entries/jo', { vatCode: 'I0', receipts: ['nope'] });
  assert.equal(status, 400);
  assert.equal(entry('jo').vatCode, 'I81');
  assert.equal(entry('jo').receipts, undefined);
});

test('a filed quarter refuses it (403)', async () => {
  const { status } = await api.send('PATCH', '/api/journal-entries/jc', { vatCode: 'I0', receipts: ['rc'] });
  assert.equal(status, 403);
  assert.equal(entry('jc').vatCode, 'I81');
});
