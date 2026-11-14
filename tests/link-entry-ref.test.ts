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
import { emptyBooks, loadBooks, PERSON, update, type Books } from '../src/books/store.js';
import { applyChange, link } from '../src/server/edits.js';
import { journalOf, receiptsFor } from '../src/app/areas/journal/model.js';
import { bookingsWithoutPayment, ledgerOf, UNPAID_SHOWN } from '../src/app/areas/receipts/model.js';
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
  const offered = bookingsWithoutPayment(l.byId.get('rfee')!, l).rows.map((u) => u.ref);
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

const DAY = '2026-08-12';
const doc = (id: string): Receipt => ({ id, filename: `${id}.csv`, originalFilename: `${id}.csv`, extractedText: id, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: `${DAY}T08:00:00Z`, location: 'archived', date: DAY, amount: 20, currency: 'CHF' });
const order = (ref: string, id = `j-${ref}`): JournalEntry => ({ id, transactionRef: ref, date: DAY, accountDebit: '1100', accountCredit: '3200', amount: 20, vatCode: 'V81', description: `Bestellung ${ref}`, origin: 'classify', receipts: ['rep'] });
const refsOf = (b: Books, receipt: string) => b.mappings.filter((m) => m.receiptId === receipt).map((m) => m.transactionRef);

test('deleting the last entry of a module\'s booking takes the person\'s link along, the module\'s own stays; the undo links hers again', () => {
  const b = emptyBooks();
  b.receipts.push(doc('rep'), doc('hers'));
  b.journalEntries.push(order('SHOP-3001'));
  b.mappings.push({ transactionRef: 'SHOP-3001', receiptId: 'rep', by: 'rule', rule: 'sales-report' });
  update(b, PERSON, (x) => link(x, 'hers', 'SHOP-3001'));
  const undo = update(b, PERSON, (x) => applyChange(x, { kind: 'deleteEntry', id: 'j-SHOP-3001' }));
  assert.deepEqual(refsOf(b, 'hers'), [], 'no link of hers hangs on a booking that is gone');
  assert.deepEqual(b.receipts.find((r) => r.id === 'hers')!.notPaidBy, ['SHOP-3001'], 'taken apart, so no code pairs them again');
  assert.deepEqual(refsOf(b, 'rep'), ['SHOP-3001'], 'the module\'s own link stays with the module');

  update(b, PERSON, (x) => applyChange(x, undo!));
  assert.deepEqual(refsOf(b, 'hers'), ['SHOP-3001'], 'the undo brings her link back');
  assert.equal(b.mappings.find((m) => m.receiptId === 'hers')!.by, 'human');
  assert.deepEqual(refsOf(b, 'rep'), ['SHOP-3001'], 'the module\'s link once');
  assert.equal(b.receipts.find((r) => r.id === 'hers')!.notPaidBy, undefined);
});

test('one of two entries of a module\'s booking deleted: the links stay with the one left', () => {
  const b = emptyBooks();
  b.receipts.push(doc('rep'), doc('hers'));
  b.journalEntries.push(order('SHOP-3002', 'a'), order('SHOP-3002', 'b'));
  update(b, PERSON, (x) => link(x, 'hers', 'SHOP-3002'));
  update(b, PERSON, (x) => applyChange(x, { kind: 'deleteEntry', id: 'a' }));
  assert.deepEqual(refsOf(b, 'hers'), ['SHOP-3002']);
});

test('the link dialog names its limit: the first bookings without a payment of the receipt\'s amount, and how many there are', () => {
  const b = emptyBooks();
  b.receipts.push(doc('hers'));
  for (let i = 0; i < UNPAID_SHOWN + 3; i++) b.journalEntries.push(order(`SHOP-40${String(i).padStart(2, '0')}`));
  // The year close's own bookings take no receipt.
  b.journalEntries.push({ ...order('YE-2026-1'), origin: 'year-close' });
  const l = ledgerOf(b, '2026-07-01');
  const shown = bookingsWithoutPayment(l.byId.get('hers')!, l);
  assert.deepEqual([shown.rows.length, shown.total], [UNPAID_SHOWN, UNPAID_SHOWN + 3]);
  assert.ok(!shown.rows.some((u) => u.ref === 'YE-2026-1'));
  const searched = bookingsWithoutPayment(l.byId.get('hers')!, l, 'shop-400');
  assert.deepEqual([searched.rows.length, searched.total], [10, 10], 'a search shows all it finds below its limit');
});
