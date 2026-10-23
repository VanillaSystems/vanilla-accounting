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
import { loadFxResolver } from '../src/accounting/fx-rates.js';
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

/**
 * A receipt only the books know, written while no run of the server writes them (#71: the inbox
 * run a private payment starts saved its own copy of the books over a receipt written meanwhile,
 * 404). Its file first: the run keeps only receipts whose file is there.
 */
async function addReceipt(filename: string, bytes: string, facts: Partial<Receipt>): Promise<string> {
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  await api.rest();
  writeFileSync(join(api.root, 'transactional-data/2026/receipts', filename), bytes);
  const books = loadBooks(api.ws);
  books.receipts.push({ id, filename, originalFilename: filename, extractionMethod: 'pdftotext', fileSize: bytes.length, indexedAt: '2026-08-01T08:00:00Z', location: 'archived', ...facts } as Receipt);
  saveBooks(api.ws, books);
  return id;
}

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
  const bare = await addReceipt('ohne-datum.pdf', '%PDF-1.4 ohne Datum', { extractedText: 'ohne Datum' });
  const { status, json } = await api.send('POST', `/api/receipts/${bare}/private-payment`);
  assert.equal(status, 400, JSON.stringify(json));
  assert.match(String(json.error), /Datum und Betrag/);
  assert.equal(loadBooks(api.ws).mappings.some((m) => m.receiptId === bare), false, 'nothing written');
});

test('r8k-10: a receipt dated in the filed period is paid privately as a correction in the open one: the payment on the first open day, naming the receipt\'s date, its booking by hand with corrects', async () => {
  const late = await addReceipt('kiosk.pdf', '%PDF-1.4 Kiosk Quittung 20.06.', { extractedText: 'Kiosk Quittung', date: '2026-06-20', amount: 12.5, currency: 'CHF', description: 'Kiosk, Zeitung' });
  const { status, json } = await api.send('POST', `/api/receipts/${late}/private-payment`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual([json.date, json.corrects], ['2026-07-01', '2026-Q2'], 'the first open day, correcting the filed quarter');
  const ref = json.ref as string;
  const after = loadBooks(api.ws);
  const tx = after.transactions.find((t) => t.ref === ref)!;
  assert.deepEqual([tx.source, tx.date, tx.amount, tx.direction], ['manual', '2026-07-01', 12.5, 'DBIT']);
  assert.match(tx.description, /20\.06\.2026/, 'the payment names the receipt\'s day');
  assert.deepEqual(after.mappings.filter((m) => m.receiptId === late), [{ transactionRef: ref, receiptId: late }]);
  assert.ok(after.receipts.find((r) => r.id === late)!.date === '2026-06-20', 'the receipt keeps its date');

  const booked = await api.send('POST', `/api/transactions/${ref}/entries`, { lines: [{ accountDebit: '6500', accountCredit: '2451', amount: 12.5, description: 'Kiosk, Zeitung' }] });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  const entries = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref);
  assert.deepEqual(entries.map((e) => [e.date, e.corrects]), [['2026-07-01', '2026-Q2']], 'booked in the open period, declared on the 0535 of Q2');
});

test('#87: only a part of a foreign receipt was business: the owner\'s payment is that part in the receipt\'s currency, named, at the ESTV rate of the receipt date; a part above the total is refused', async () => {
  const cafe = await addReceipt('cafe.pdf', '%PDF-1.4 Cafe Central Wien', { extractedText: 'Café Central Wien Melange Kuchen Summe EUR 70.57', date: '2026-08-12', amount: 70.57, currency: 'EUR', description: 'Café Central', hasSwissVat: false });
  const tooMuch = await api.send('POST', `/api/receipts/${cafe}/private-payment`, { amount: 80, part: 'Kaffee' });
  assert.deepEqual([tooMuch.status, tooMuch.json.code, tooMuch.json.params], [400, 'partAmount', { total: 70.57, currency: 'EUR' }]);

  const { status, json } = await api.send('POST', `/api/receipts/${cafe}/private-payment`, { amount: 17.99, part: 'Kaffee' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.exchangeRate, loadFxResolver().daily('EUR', '2026-08-12'));
  const tx = loadBooks(api.ws).transactions.find((t) => t.ref === json.ref)!;
  assert.deepEqual([tx.bank, tx.amount, tx.currency, tx.businessPart], ['manual', 17.99, 'EUR', { what: 'Kaffee' }]);
});

test('#90: a receipt paid privately is linked to no second payment, not even confirmed: the bank payment that pays the owner back belongs to the owner\'s account', async () => {
  const paid = loadBooks(api.ws).receipts.find((r) => r.filename === 'cafe.pdf')!.id;
  const before = JSON.stringify(loadBooks(api.ws));
  const { status, json } = await api.send('POST', '/api/mapping/add', { receiptId: paid, transactionRef: 'OI', confirm: true });
  assert.deepEqual([status, json.code, (json.params as { receipt: string }).receipt], [409, 'paidPrivately', paid]);
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'nothing written');
});

test('#87: a booking by hand of the receipt\'s amount holds the private payment (409 bookedByHand, nothing written); «ersetzen» replaces it in the same write', async () => {
  const shop = await addReceipt('papeterie.pdf', '%PDF-1.4 Papeterie Zumstein', { extractedText: 'Papeterie Zumstein Quittung Total CHF 42.80', date: '2026-08-20', amount: 42.8, currency: 'CHF', description: 'Papeterie Zumstein' });
  const hand = await api.send('POST', '/api/journal-entries', { date: '2026-08-20', accountDebit: '6500', accountCredit: '2451', amount: 42.8, description: 'Papeterie Zumstein, Büromaterial' });
  assert.equal(hand.status, 200, JSON.stringify(hand.json));
  const ref = loadBooks(api.ws).journalEntries.find((e) => e.description === 'Papeterie Zumstein, Büromaterial')!.transactionRef;

  const before = JSON.stringify(loadBooks(api.ws));
  const held = await api.send('POST', `/api/receipts/${shop}/private-payment`, {});
  assert.deepEqual([held.status, held.json.code, (held.json.params as { entry: string }).entry], [409, 'bookedByHand', ref]);
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'nothing written');

  const replaced = await api.send('POST', `/api/receipts/${shop}/private-payment`, { replace: ref });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  const books = loadBooks(api.ws);
  assert.equal(books.journalEntries.some((e) => e.transactionRef === ref), false, 'the booking by hand gave way');
  assert.deepEqual(books.mappings.filter((m) => m.receiptId === shop).map((m) => m.transactionRef), [replaced.json.ref]);

  const undone = await api.send('POST', `/api/receipts/${shop}/private-payment/undo`, { ref: replaced.json.ref, restore: replaced.json.replaced });
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  const back = loadBooks(api.ws);
  assert.equal(back.transactions.some((t) => t.ref === replaced.json.ref), false, 'the private payment gone');
  assert.deepEqual(back.journalEntries.filter((e) => e.transactionRef === ref).map((e) => e.description), ['Papeterie Zumstein, Büromaterial'], 'the booking by hand back, in the same write');
});
