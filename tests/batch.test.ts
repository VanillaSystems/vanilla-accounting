/**
 * Several objects at once (#216, src/server/batch.ts, POST /api/batch): each object's change is its
 * single change by hand, a filed object is left out and named while the others change, a preview
 * changes nothing, the undo takes the whole batch back in one write, and the limit is told.
 * Runs the real API on a copy of tests/fixtures/period-lock-index.json (closed through 2026-06-30).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { BatchAnswer } from '../src/types/batch.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

const books = () => loadBooks(workspaceAt(api.ws.paths.root));
const entry = (id: string) => books().journalEntries.find((e) => e.id === id);
async function batch(body: unknown): Promise<{ status: number; json: BatchAnswer & { error?: string; code?: string } }> {
  const r = await api.send('POST', '/api/batch', body);
  return { status: r.status, json: r.json as unknown as BatchAnswer & { error?: string; code?: string } };
}

test('a preview shows the change and the filed object left out, and saves nothing', async () => {
  const before = JSON.stringify(books().journalEntries);
  const { status, json } = await batch({ action: { kind: 'vatCode', to: 'I0' }, ids: ['jc', 'jo'], preview: true });
  assert.equal(status, 200, json.error);
  assert.deepEqual(json.changes, [{ id: 'jo', field: 'vatCode', from: 'I81', to: 'I0' }]);
  assert.deepEqual(json.left.map((l) => [l.id, l.refusal?.code]), [['jc', 'periodClosed']]);
  assert.equal(JSON.stringify(books().journalEntries), before, 'a preview writes nothing');
});

test('the VAT code of several entries: the open one changes as by hand, the filed one stays; the undo puts it back', async () => {
  const { status, json } = await batch({ action: { kind: 'vatCode', to: 'I0' }, ids: ['jc', 'jo'] });
  assert.equal(status, 200, json.error);
  assert.equal(entry('jo')?.vatCode, 'I0');
  assert.equal(entry('jo')?.by?.kind, 'person', 'the person decided it');
  assert.equal(entry('jc')?.vatCode, 'I81', 'the filed quarter is set in stone');
  const undo = await api.send('POST', '/api/batch/undo', { undo: json.undo });
  assert.equal(undo.status, 200, String(undo.json.error));
  assert.equal(entry('jo')?.vatCode, 'I81');
  assert.equal(entry('jo')?.by, undefined, 'the undo puts back who booked it');
});

test('an account moved: only the side on it, and an entry not on it is named', async () => {
  const { status, json } = await batch({ action: { kind: 'account', from: '6500', to: '6800' }, ids: ['jo'] });
  assert.equal(status, 200, json.error);
  assert.equal(entry('jo')?.accountDebit, '6800');
  assert.equal(entry('jo')?.accountCredit, '1021');
  const again = await batch({ action: { kind: 'account', from: '6500', to: '6800' }, ids: ['jo'] });
  assert.deepEqual(again.json.left.map((l) => l.refusal?.code), ['batchNotOn']);
  await api.send('POST', '/api/batch/undo', { undo: json.undo });
  assert.equal(entry('jo')?.accountDebit, '6500');
});

test('payments without a booking booked by hand in one write; the undo takes the entries back', async () => {
  const { status, json } = await batch({ action: { kind: 'book', account: '3200', vat: '' }, ids: ['OI', 'O1'] });
  assert.equal(status, 200, json.error);
  const made = books().journalEntries.filter((e) => e.transactionRef === 'OI');
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].accountDebit, made[0].accountCredit, made[0].amount, made[0].origin], ['1021', '3200', 108.1, 'manual']);
  assert.deepEqual(json.left.map((l) => [l.id, l.refusal?.code]), [['O1', 'batchBooked']], 'a booked payment is not booked twice');
  await api.send('POST', '/api/batch/undo', { undo: json.undo });
  assert.equal(books().journalEntries.filter((e) => e.transactionRef === 'OI').length, 0);
});

test('a receipt set aside as «kein Beleg» loses its link; the undo links it again', async () => {
  const { status, json } = await batch({ action: { kind: 'notReceipt' }, ids: ['ro'] });
  assert.equal(status, 200, json.error);
  assert.equal(books().receipts.find((r) => r.id === 'ro')?.kind, 'noise');
  assert.ok(!books().mappings.some((m) => m.receiptId === 'ro'));
  await api.rest();
  const undo = await api.send('POST', '/api/batch/undo', { undo: json.undo });
  assert.equal(undo.status, 200, String(undo.json.error));
  await api.rest();
  assert.equal(books().receipts.find((r) => r.id === 'ro')?.kind, undefined);
  assert.ok(books().mappings.some((m) => m.receiptId === 'ro' && m.transactionRef === 'O1'));
});

test('more than the limit is refused and says so', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
  const { status, json } = await batch({ action: { kind: 'noReceiptNeeded' }, ids });
  assert.equal(status, 400);
  assert.equal(json.code, 'batchLimit');
});

test('a code the firm\'s form does not take refuses the whole batch before anything changes', async () => {
  const before = JSON.stringify(books().journalEntries);
  const { status } = await batch({ action: { kind: 'vatCode', to: 'F1' }, ids: ['jo'] });
  assert.equal(status, 400);
  assert.equal(JSON.stringify(books().journalEntries), before);
});
