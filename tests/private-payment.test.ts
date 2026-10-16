/**
 * Belege › «Weitere Zahlung» › «Privat oder bar bezahlt» (persona round 7, r7h-23): one request
 * makes the owner's payment and links it; a receipt the bank (or an earlier private payment)
 * already paid is refused, in code, so the expense and its input tax are never booked twice. The
 * undo is one step: deleting the private payment takes its bookings and its link with it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, saveBooks } from '../src/books/store.js';
import type { Receipt } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
/** The inbox run a private payment starts keeps only receipts whose file is there, under the id of its bytes. */
const RP = '%PDF-1.4 Baucenter Gossau Quittung';
const rp = createHash('sha256').update(RP).digest('hex').slice(0, 16);

before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  // A receipt with date and amount that no payment pays yet.
  const books = loadBooks(api.ws);
  books.receipts.push({ id: rp, filename: 'quittung.pdf', originalFilename: 'quittung.pdf', extractedText: 'Baucenter Gossau Quittung', extractionMethod: 'pdftotext', fileSize: RP.length, indexedAt: '2026-08-01T08:00:00Z', location: 'archived', date: '2026-08-12', amount: 187.35, currency: 'CHF', description: 'Baucenter Gossau' } as Receipt);
  saveBooks(api.ws, books);
  const dir = join(api.root, 'transactional-data/2026/receipts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'quittung.pdf'), RP);
});
after(() => api?.stop());

test('a receipt the bank already paid is not paid privately on top: 409 receiptPaid names the payment, nothing written', async () => {
  const before = JSON.stringify(loadBooks(api.ws));
  const { status, json } = await api.send('POST', '/api/receipts/ro/private-payment');
  assert.equal(status, 409);
  assert.deepEqual([json.code, json.params], ['receiptPaid', { receipt: 'ro', payment: 'O1' }]);
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'books unchanged');
});

test('a receipt without a payment: one request makes the owner\'s payment on its date and amount and links it; a second request is refused', async () => {
  const { status, json } = await api.send('POST', `/api/receipts/${rp}/private-payment`);
  assert.equal(status, 200, JSON.stringify(json));
  const ref = json.ref as string;
  assert.match(ref, /^M2026-\d{3}$/);
  const books = loadBooks(api.ws);
  const tx = books.transactions.find((t) => t.ref === ref)!;
  assert.deepEqual([tx.source, tx.date, tx.amount, tx.currency, tx.direction, tx.description], ['manual', '2026-08-12', 187.35, 'CHF', 'DBIT', 'Baucenter Gossau']);
  assert.deepEqual(books.mappings.filter((m) => m.receiptId === rp), [{ transactionRef: ref, receiptId: rp }]);

  const again = await api.send('POST', `/api/receipts/${rp}/private-payment`);
  assert.deepEqual([again.status, again.json.code, (again.json.params as { payment: string }).payment], [409, 'receiptPaid', ref], 'paid once is paid');
});

test('the undo is one step: deleting the private payment takes its booking and its link with it', async () => {
  const ref = loadBooks(api.ws).mappings.find((m) => m.receiptId === rp)!.transactionRef;
  const booked = await api.send('POST', `/api/transactions/${ref}/entries`, { lines: [{ accountDebit: '6700', accountCredit: '2451', amount: 187.35, vatCode: 'I81', description: 'Baucenter Gossau' }] });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  assert.equal(loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref).length, 1);

  const { status, json } = await api.send('DELETE', `/api/transactions/${ref}`);
  assert.equal(status, 200, JSON.stringify(json));
  const books = loadBooks(api.ws);
  assert.equal(books.transactions.some((t) => t.ref === ref), false, 'payment gone');
  assert.equal(books.journalEntries.some((e) => e.transactionRef === ref), false, 'its booking gone');
  assert.equal(books.mappings.some((m) => m.transactionRef === ref), false, 'its link gone');
  assert.ok(books.receipts.some((r) => r.id === rp), 'the receipt stays');
});

test('a receipt without date or amount cannot be paid privately: 400, in words', async () => {
  const BARE = '%PDF-1.4 ohne Datum';
  const bare = createHash('sha256').update(BARE).digest('hex').slice(0, 16);
  const books = loadBooks(api.ws);
  books.receipts.push({ id: bare, filename: 'ohne-datum.pdf', originalFilename: 'ohne-datum.pdf', extractedText: 'ohne Datum', extractionMethod: 'pdftotext', fileSize: BARE.length, indexedAt: '2026-08-01T08:00:00Z', location: 'archived' } as Receipt);
  saveBooks(api.ws, books);
  writeFileSync(join(api.root, 'transactional-data/2026/receipts', 'ohne-datum.pdf'), BARE);
  const { status, json } = await api.send('POST', `/api/receipts/${bare}/private-payment`);
  assert.equal(status, 400, JSON.stringify(json));
  assert.match(String(json.error), /Datum und Betrag/);
  assert.equal(loadBooks(api.ws).mappings.some((m) => m.receiptId === bare), false, 'nothing written');
});
