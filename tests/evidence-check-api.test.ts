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

/** The open receipt as a bill of two VAT groups (#406): CHF 10.81 at 8.1 %, 9.19 at 0 % (an export part). */
function twoGroups(entries: Array<{ id: string; amount: number; vatCode: string } & Record<string, unknown>>) {
  const books = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const ro = books.receipts.find((r: { id: string }) => r.id === 'ro');
  Object.assign(ro, { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 10, vat: 0.81 }, { ratePercent: 0, net: 9.19, vat: 0 }] });
  const jo = books.journalEntries.find((e: { id: string }) => e.id === 'jo');
  books.journalEntries = [...books.journalEntries.filter((e: { id: string }) => e.id !== 'jo'), ...entries.map((x) => ({ ...jo, ...x }))];
  writeIndex(api.ws, books);
}
const lines = () => loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.filter((e) => e.transactionRef === 'O1').map((e) => [e.id, e.amount, e.vatCode, e.origin]);

test('«Nach Beleg buchen» on a bill of two groups recodes the line booked at the wrong rate and keeps the other (#406)', async () => {
  twoGroups([{ id: 'jo', amount: 10.81, vatCode: 'I81' }, { id: 'jx', amount: 9.19, vatCode: 'I81' }]);
  const { status, json } = await api.send('POST', '/api/journal-entries/jx/by-receipt');
  assert.equal(status, 200, String(json.error));
  assert.deepEqual(lines(), [['jo', 10.81, 'I81', undefined], ['jx', 9.19, 'I0', 'manual']]);
  assert.deepEqual((json.after as Array<{ id: string }>).map((e) => e.id), ['jx'], 'the undo takes back only the line it changed');
  assert.deepEqual((json.before as Array<{ id: string; vatCode: string }>).map((e) => [e.id, e.vatCode]), [['jx', 'I81']]);
});

test('one line for the whole bill is booked as two, one per group', async () => {
  twoGroups([{ id: 'jo', amount: 20, vatCode: 'I0' }]);
  const { status, json } = await api.send('POST', '/api/journal-entries/jo/by-receipt');
  assert.equal(status, 200, String(json.error));
  const now = lines().sort((a, b) => Number(b[1]) - Number(a[1]));
  assert.equal(now.length, 2);
  assert.deepEqual(now[0], ['jo', 10.81, 'I81', 'manual']);
  assert.deepEqual(now[1].slice(1), [9.19, 'I0', 'manual']);
});

test('a booking that fits its groups is refused with notByReceipt, nothing changes', async () => {
  twoGroups([{ id: 'jo', amount: 10.81, vatCode: 'I81' }, { id: 'jx', amount: 9.19, vatCode: 'I0' }]);
  const { status, json } = await api.send('POST', '/api/journal-entries/jx/by-receipt');
  assert.equal(status, 409);
  assert.equal(json.code, 'notByReceipt');
  assert.deepEqual(lines(), [['jo', 10.81, 'I81', undefined], ['jx', 9.19, 'I0', undefined]]);
});

test('S1: a line a person booked is never rewritten by the click: refused on the server with decidedByHand', async () => {
  twoGroups([{ id: 'jo', amount: 10.81, vatCode: 'I81' }, { id: 'jx', amount: 9.19, vatCode: 'I81', origin: 'manual', by: { kind: 'person', at: '2026-08-11T09:00:00.000Z' }, receipts: ['ro'] }]);
  const { status, json } = await api.send('POST', '/api/journal-entries/jo/by-receipt');
  assert.equal(status, 409);
  assert.equal(json.code, 'decidedByHand');
  assert.deepEqual(lines(), [['jo', 10.81, 'I81', undefined], ['jx', 9.19, 'I81', 'manual']]);
});

test('a line rebooked in place is no longer the rule\'s: its rule id goes', async () => {
  twoGroups([{ id: 'jo', amount: 10.81, vatCode: 'I81' }, { id: 'jx', amount: 9.19, vatCode: 'I81', rule: 'post-porto', by: { kind: 'rule', rule: 'post-porto' } }]);
  assert.equal((await api.send('POST', '/api/journal-entries/jx/by-receipt')).status, 200);
  assert.equal(entry('jx').rule, undefined);
});

test('S4: the undo puts the lines back in one write; refused when a line changed since', async () => {
  twoGroups([{ id: 'jo', amount: 20, vatCode: 'I81' }]);
  const done = await api.send('POST', '/api/journal-entries/jo/by-receipt');
  assert.equal(done.status, 200, String(done.json.error));
  assert.equal(lines().length, 2);
  const undo = await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: done.json.undo });
  assert.equal(undo.status, 200, String(undo.json.error));
  assert.deepEqual(lines(), [['jo', 20, 'I81', undefined]]);

  const again = await api.send('POST', '/api/journal-entries/jo/by-receipt');
  assert.equal(again.status, 200);
  const made = (again.json.after as Array<{ id: string }>).find((x) => x.id !== 'jo')!;
  assert.equal((await api.send('PATCH', `/api/journal-entries/${made.id}`, { description: 'von Hand geändert' })).status, 200);
  const late = await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: again.json.undo });
  assert.equal(late.status, 409);
  assert.equal(late.json.code, 'changedSince');
  assert.equal(lines().length, 2, 'her change stands');
});

test('the undo takes only the id the click returned: lines in the body are ignored, a crafted or spent id refused (#406 review)', async () => {
  twoGroups([{ id: 'jo', amount: 20, vatCode: 'I81' }]);
  const crafted = { before: [{ id: 'jo', transactionRef: 'O1', date: '2026-99-99', accountDebit: '6500', accountCredit: '1021', amount: 'abc', corrects: 'banana', receipts: ['nope'] }], after: [] };
  const refused = await api.send('POST', '/api/journal-entries/by-receipt/undo', crafted);
  assert.equal(refused.status, 410);
  assert.equal(refused.json.code, 'undoGone');
  assert.deepEqual(lines(), [['jo', 20, 'I81', undefined]], 'nothing written');
  const done = await api.send('POST', '/api/journal-entries/jo/by-receipt');
  assert.equal(done.status, 200);
  assert.equal((await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: 'f'.repeat(16), ...crafted })).status, 410, 'an id the server never gave');
  assert.equal((await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: done.json.undo, ...crafted })).status, 200, 'the honest undo, whatever else the body says');
  assert.deepEqual(lines(), [['jo', 20, 'I81', undefined]]);
  assert.equal((await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: done.json.undo })).status, 410, 'spent');
});
