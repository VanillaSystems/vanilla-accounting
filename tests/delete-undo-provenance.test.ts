/**
 * «Rückgängig» of a deleted booking puts it back as it was, its provenance included (r8f-46): who
 * booked it (`by`), the rule, the reason, the run and the receipts it saw, so that Herkunft on the
 * booking page says «Regel …» again and not «Claude». The toast's undo sends what undoInput builds;
 * the API takes those fields only with the entry's `id` (an undo), never on a new booking.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Index, JournalEntry } from '../src/types/index.js';
import { undoInput } from '../src/books/entry-input.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;

const RULED: JournalEntry = {
  id: 'jo', transactionRef: 'O1', date: '2026-08-10', accountDebit: '6500', accountCredit: '1021', amount: 20, description: 'Rate 2 Garderobe', vatCode: 'I0',
  origin: 'classify', rule: 'garderobe', reason: 'Regel: Text «Garderobe», Ausgang → Konto 6500, ohne MWST', run: 'run-7', by: { kind: 'rule', rule: 'garderobe' }, receipts: [],
};

before(async () => {
  api = await startApi(FIXTURE);
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Index & { journalEntries: JournalEntry[] };
  writeIndex(api.ws, { ...f, journalEntries: f.journalEntries.map((e) => (e.id === 'jo' ? RULED : e)) });
});
after(async () => { await api?.stop(); });

const entry = async (id: string) => ((await api.send('GET', '/books.json')).json as unknown as { journalEntries: JournalEntry[] }).journalEntries.find((e) => e.id === id);

test('r8f-46: the undo of a deletion books the entry again with by, rule, reason, run and receipts', async () => {
  assert.equal((await api.send('DELETE', '/api/journal-entries/jo')).status, 200);
  assert.equal(await entry('jo'), undefined);
  const back = await api.send('POST', '/api/journal-entries', undoInput(RULED));
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.deepEqual(await entry('jo'), RULED, 'as it was, provenance included');
});

test('a new booking (no id) carries no provenance of its own: the fields are refused', async () => {
  const { id: _id, ...fresh } = undoInput(RULED);
  const refused = await api.send('POST', '/api/journal-entries', fresh);
  assert.equal(refused.status, 400, JSON.stringify(refused.json));
});
