/**
 * A late receipt's pointer at a filed payment (Receipt.filedPayment, #187) by the person, over the
 * API: put back only while no bank payment pays the receipt, a pointer replaced is a pair taken
 * apart, and a pointer whose correction is booked stays until the correction goes. Each guard keeps
 * the 0535 from counting a receipt's input tax twice.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { booksOnDisk } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/pairing-filed-index.json'); });
after(() => api?.stop());

const receipt = (id: string) => loadBooks(workspaceAt(api.ws.paths.root)).receipts.find((r) => r.id === id)!;

test('a receipt a bank payment pays is not pointed at a filed payment: its input tax would count twice', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await api.send('POST', '/api/receipts/rb/filed-payment', { payment: 'F3' });
  assert.equal(status, 409);
  assert.equal(json.code, 'pointerLinked');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'nothing changed');
});

test('a pointer replaced by another is a pair taken apart: the old one is never paired again', async () => {
  const { status } = await api.send('POST', '/api/receipts/ra/filed-payment', { payment: 'F3' });
  assert.equal(status, 200);
  const r = receipt('ra');
  assert.equal(r.filedPayment, 'F3');
  assert.deepEqual(r.notPaidBy, ['F1']);
});

test('a pointer whose correction is booked stays: the correction is deleted first', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await api.send('POST', '/api/receipts/rc/filed-payment', { payment: null });
  assert.equal(status, 409);
  assert.equal(json.code, 'correctionBooked');
  assert.equal((json.params as { entry: string }).entry, 'jm');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'nothing changed');
});

test('a pointer whose correction is booked is not moved to another filed payment either', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await api.send('POST', '/api/receipts/rc/filed-payment', { payment: 'F1' });
  assert.equal(status, 409);
  assert.equal(json.code, 'correctionBooked');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'nothing changed');
});
