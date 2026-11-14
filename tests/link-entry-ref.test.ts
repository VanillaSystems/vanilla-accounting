/**
 * A booking a module or an older import made under a ref of its own (a payment provider's order
 * booked without a payout row, an invoice's event) takes a receipt by hand as a person's booking
 * without a payment does: whatever the app links there, a person can link too. A ref whose entries
 * lie in a filed quarter is refused (403), one that books and pays nothing stays 404. Runs the real
 * API on tests/fixtures/period-lock-index.json (closedThrough 2026-06-30) with two made-up order
 * bookings added: SHOP-2001 in the open quarter, SHOP-1001 in the filed one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Index, JournalEntry, Receipt } from '../src/types/index.js';
import { loadBooks } from '../src/books/store.js';
import { journalOf, receiptsFor } from '../src/app/areas/journal/model.js';
import { bookingsWithoutPayment, ledgerOf } from '../src/app/areas/receipts/model.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';
import './support/jurisdiction.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;

const report: Receipt = { id: 'rfee', filename: 'zahlungsanbieter-gebuehren-august.csv', originalFilename: 'fees.csv', extractedText: 'Order,Fee', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-08-31T00:00:00Z', location: 'archived', date: '2026-08-31', amount: 20, currency: 'CHF' };
const orders: JournalEntry[] = [
  { id: 'jso', transactionRef: 'SHOP-2001', date: '2026-08-12', accountDebit: '1100', accountCredit: '3200', amount: 20, vatCode: 'V81', description: 'Bestellung 2001', origin: 'classify' },
  { id: 'jsc', transactionRef: 'SHOP-1001', date: '2026-05-12', accountDebit: '1100', accountCredit: '3200', amount: 20, vatCode: 'V81', description: 'Bestellung 1001', origin: 'classify' },
];

before(async () => {
  api = await startApi(FIXTURE);
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Index & { journalEntries: JournalEntry[] };
  writeIndex(api.ws, { ...f, receipts: [...f.receipts, report], journalEntries: [...f.journalEntries, ...orders] });
});
after(async () => { await api?.stop(); });

const linksOf = (receipt: string) => loadBooks(api.ws).mappings.filter((m) => m.receiptId === receipt).map((m) => m.transactionRef);

test('the journal and the link dialog offer a receipt to an open booking under a ref of its own, never to a filed one', () => {
  const books = loadBooks(api.ws);
  assert.ok(receiptsFor(books, books.journalEntries.filter((e) => e.transactionRef === 'SHOP-2001')).some((r) => r.id === 'rfee'), '«Beleg zuordnen» on the order booking');
  const l = ledgerOf(books, '2026-07-01');
  const offered = bookingsWithoutPayment(l.byId.get('rfee')!, l).map((u) => u.ref);
  assert.ok(offered.includes('SHOP-2001'), 'the link dialog lists it among the bookings without a payment');
  assert.ok(!offered.includes('SHOP-1001'), 'never the filed one');
});

test('a booking a module made under a ref of its own takes a receipt by hand, and its detail shows it', async () => {
  const { status, json } = await api.send('POST', '/api/mapping/add', { receiptId: 'rfee', transactionRef: 'SHOP-2001' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(linksOf('rfee'), ['SHOP-2001']);
  const books = loadBooks(api.ws);
  assert.equal(books.mappings.find((m) => m.receiptId === 'rfee')!.by, 'human');
  assert.deepEqual(books.journalEntries.find((e) => e.id === 'jso'), orders[0], 'the module\'s booking itself is not touched');
  assert.deepEqual(journalOf(books).byId.get('jso')!.receipts.map((r) => r.id), ['rfee'], 'the entry\'s detail shows the linked receipt');

  const unlinked = await api.send('POST', '/api/mapping/remove', { receiptId: 'rfee', transactionRef: 'SHOP-2001' });
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.json));
  assert.deepEqual(linksOf('rfee'), []);
  assert.deepEqual(loadBooks(api.ws).journalEntries.find((e) => e.id === 'jso'), orders[0]);
});

test('such a booking of a filed quarter takes no receipt (403 periodClosed); a ref that books and pays nothing stays 404 gone', async () => {
  const before = JSON.stringify(loadBooks(api.ws));
  const closed = await api.send('POST', '/api/mapping/add', { receiptId: 'rfee', transactionRef: 'SHOP-1001' });
  assert.deepEqual([closed.status, closed.json.code], [403, 'periodClosed'], JSON.stringify(closed.json));
  const unknown = await api.send('POST', '/api/mapping/add', { receiptId: 'rfee', transactionRef: 'SHOP-9999' });
  assert.deepEqual([unknown.status, unknown.json.code], [404, 'gone'], JSON.stringify(unknown.json));
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'books unchanged');
});
