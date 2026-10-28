/**
 * «Von Mitarbeitenden bezahlt» (#216): the employee's account is asked once and kept as a money
 * account of the firm (role employee); the outlay is that person's payment of the receipt, linked,
 * on their account, never on one the app made up. Runs the real API on a copy of
 * tests/fixtures/period-lock-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, saveBooks } from '../src/books/store.js';
import type { Receipt } from '../src/types/index.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  // A receipt with its file (an inbox run keeps only those), date and amount, that no payment pays yet.
  const dir = join(api.root, 'transactional-data/2026/receipts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spesen.pdf'), '%PDF-1.4 Spesen');
  const b = loadBooks(api.ws);
  b.receipts.push({ id: 'emp', filename: 'spesen.pdf', originalFilename: 'spesen.pdf', extractedText: 'Bahnbillett Zürich–Bern', extractionMethod: 'pdftotext', fileSize: 15, indexedAt: '2026-08-01T08:00:00Z', location: 'archived', date: '2026-08-12', amount: 20, currency: 'CHF' } as Receipt);
  saveBooks(api.ws, b);
});
after(() => api?.stop());

const books = () => loadBooks(workspaceAt(api.ws.paths.root));

test('an account that is no employee\'s is refused: the app never books on one it was not given', async () => {
  const r = await api.send('POST', '/api/receipts/emp/private-payment', { by: '2451' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'notEmployee');
});

test('asked once: the person and their account are kept as a money account of the firm', async () => {
  const r = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'Anna Muster', currency: 'CHF', account: '2160', label: 'Anna Muster', role: 'employee' } });
  assert.equal(r.status, 200, String(r.json.error));
  assert.match(readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8'), /role: employee/);
  const owner = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'Zweiter Inhaber', currency: 'CHF', account: '2170', label: 'x', role: 'owner' } });
  assert.equal(owner.status, 400, 'never a second owner');
});

test('the outlay is that person\'s payment of the receipt, linked, on their account', async () => {
  const r = await api.send('POST', '/api/receipts/emp/private-payment', { by: '2160' });
  assert.equal(r.status, 200, String(r.json.error));
  const tx = books().transactions.find((t) => t.ref === r.json.ref);
  assert.equal(tx?.bank, 'Anna Muster');
  assert.equal(tx?.source, 'manual');
  assert.equal(tx?.amount, 20);
  assert.ok(books().mappings.some((m) => m.receiptId === 'emp' && m.transactionRef === tx?.ref));
  await api.rest();
  const undo = await api.send('DELETE', `/api/transactions/${r.json.ref}`);
  assert.equal(undo.status, 200, 'the undo is the payment deleted, as for the owner\'s');
});
