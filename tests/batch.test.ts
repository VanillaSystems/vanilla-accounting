/**
 * Several objects at once (#216, src/server/batch.ts, POST /api/batch): each object's change is its
 * single change by hand, a filed object is left out and named while the others change, a preview
 * changes nothing, the undo takes the whole batch back in one write, and the limit is told.
 * Runs the real API on a copy of tests/fixtures/period-lock-index.json (closed through 2026-06-30).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks, saveBooks } from '../src/books/store.js';
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
  const undo = await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
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
  await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
  assert.equal(entry('jo')?.accountDebit, '6500');
});

test('payments without a booking booked by hand in one write; the undo takes the entries back', async () => {
  const { status, json } = await batch({ action: { kind: 'book', account: '3200', vat: '' }, ids: ['OI', 'O1'] });
  assert.equal(status, 200, json.error);
  const made = books().journalEntries.filter((e) => e.transactionRef === 'OI');
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].accountDebit, made[0].accountCredit, made[0].amount, made[0].origin], ['1021', '3200', 108.1, 'manual']);
  assert.deepEqual(json.left.map((l) => [l.id, l.refusal?.code]), [['O1', 'batchBooked']], 'a booked payment is not booked twice');
  await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
  assert.equal(books().journalEntries.filter((e) => e.transactionRef === 'OI').length, 0);
});

test('a receipt set aside as «kein Beleg» loses its link; the undo links it again', async () => {
  const { status, json } = await batch({ action: { kind: 'notReceipt' }, ids: ['ro'] });
  assert.equal(status, 200, json.error);
  assert.equal(books().receipts.find((r) => r.id === 'ro')?.kind, 'noise');
  assert.ok(!books().mappings.some((m) => m.receiptId === 'ro'));
  await api.rest();
  const undo = await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
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

test('a VAT code with input tax is not set by batch on an entry without a receipt or other proof (#134)', async () => {
  const b = books();
  b.transactions.push({ ref: 'P9', bank: 'Raiffeisen', source: 'camt', date: '2026-08-22', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Werkzeug ohne Beleg' } as never);
  b.journalEntries.push({ id: 'j9', transactionRef: 'P9', date: '2026-08-22', accountDebit: '6500', accountCredit: '1021', amount: 50, vatCode: 'I0', description: 'Werkzeug ohne Beleg' } as never);
  b.transactions.push({ ref: 'P7', bank: 'Raiffeisen', source: 'camt', date: '2026-08-23', amount: 30, currency: 'CHF', direction: 'DBIT', description: 'Werkzeug mit Vertrag', inputTaxProof: { text: 'Vertrag mit MWST und Zahlungsbestätigung', at: '2026-08-23T10:00:00Z' } } as never);
  b.journalEntries.push({ id: 'j7', transactionRef: 'P7', date: '2026-08-23', accountDebit: '6500', accountCredit: '1021', amount: 30, vatCode: 'I0', description: 'Werkzeug mit Vertrag' } as never);
  saveBooks(api.ws, b);
  const { status, json } = await batch({ action: { kind: 'vatCode', to: 'I81' }, ids: ['j9', 'j7'] });
  assert.equal(status, 200, json.error);
  assert.deepEqual(json.left.map((l) => [l.id, l.refusal?.code]), [['j9', 'batchNoReceipt']], 'named per object');
  assert.equal(entry('j9')?.vatCode, 'I0', 'no receipt, no input tax');
  assert.equal(entry('j7')?.vatCode, 'I81', 'the other proof the person named backs it');
  const zero = await batch({ action: { kind: 'vatCode', to: 'I0' }, ids: ['j7'] });
  assert.equal(zero.status, 200);
  assert.equal(entry('j7')?.vatCode, 'I0', 'a code without input tax is set as ever');
});

test('the undo is the server\'s: a forged list takes nothing back, an id is used once', async () => {
  const forged = await api.send('POST', '/api/batch/undo', { undo: [{ kind: 'unbook', ref: 'P9', entries: ['j9'] }] });
  assert.equal(forged.status, 400);
  assert.ok(entry('j9'), 'no entry deleted the batch never made');
  const unknown = await api.send('POST', '/api/batch/undo', { batchId: 'not-a-batch' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'batchUndoGone');
  const { json } = await batch({ action: { kind: 'noReceiptNeeded' }, ids: ['O1'] });
  assert.ok(json.batchId);
  assert.equal((await api.send('POST', '/api/batch/undo', { batchId: json.batchId })).status, 200);
  assert.equal((await api.send('POST', '/api/batch/undo', { batchId: json.batchId })).status, 404, 'taken back once');
});

test('an undo over a later change by the person is refused and names the object; her change and her name stay', async () => {
  const { status, json } = await batch({ action: { kind: 'account', from: '6500', to: '6800' }, ids: ['jo'] });
  assert.equal(status, 200, json.error);
  assert.ok(json.batchId);
  const p = await api.send('PATCH', '/api/journal-entries/jo', { vatCode: 'I0', description: 'meine Änderung' });
  assert.equal(p.status, 200, String(p.json.error));
  const mine = entry('jo');
  const u = await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
  assert.equal(u.status, 409);
  assert.equal(u.json.code, 'batchChangedSince');
  assert.match(String(u.json.error), /jo/);
  assert.deepEqual(entry('jo'), mine, 'nothing written over her change, her origin and name kept');
  // Set back by hand for the tests after.
  await api.send('PATCH', '/api/journal-entries/jo', { accountDebit: '6500', vatCode: 'I81' });
});

test('an undo after the period was filed is refused (403) and writes nothing', async () => {
  const { json } = await batch({ action: { kind: 'noReceiptNeeded' }, ids: ['OI'] });
  assert.ok(json.batchId);
  const b = books();
  const closed = b.config.closedThrough;
  b.config.closedThrough = '2026-09-30';
  saveBooks(api.ws, b);
  const before = JSON.stringify(books());
  const u = await api.send('POST', '/api/batch/undo', { batchId: json.batchId });
  assert.equal(u.status, 403);
  assert.equal(JSON.stringify(books()), before);
  const back = books();
  back.config.closedThrough = closed;
  saveBooks(api.ws, back);
});
