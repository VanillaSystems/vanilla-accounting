/**
 * #89: a booking without a payment (a depreciation, an accrual, a private share, a correction,
 * typed in Buchungen or made by the AI) carries its receipt. `link` takes a manual ref that open
 * entries book; a booking of a filed quarter takes none (403) and the seal stays intact; a
 * privately paid receipt is linked to nothing else; deleting the booking takes its links along and
 * its undo brings them back. Runs the real API on tests/fixtures/manual-link-index.json
 * (closedThrough 2026-06-30: M2026-003 is a filed booking, M2026-002 an open depreciation,
 * M2026-001 the owner's payment of the receipt rp).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyBooks, loadBooks, update, PERSON, type Books } from '../src/books/store.js';
import { checkSeals, sealFile, writeSeal } from '../src/books/seal.js';
import { applyAnswer, applyChange, dropPayment, link, privatePayment } from '../src/server/edits.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { undoInput } from '../src/books/entry-input.js';
import { bookingsWithoutPayment, isOpen, ledgerOf } from '../src/app/areas/receipts/model.js';
import type { Receipt } from '../src/types/index.js';
import type { BookChange } from '../src/types/assistant.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

let api: ApiServer;
let sealed = '';

before(async () => {
  api = await startApi('tests/fixtures/manual-link-index.json');
  assert.equal(writeSeal(api.ws, loadBooks(api.ws), '2026-Q2', '2026-07-10T08:00:00Z').status, 'written');
  sealed = readFileSync(sealFile(api.ws, '2026-Q2'), 'utf8');
});
after(() => api?.stop());

const linksOf = (books: Books, receipt: string) => books.mappings.filter((m) => m.receiptId === receipt).map((m) => m.transactionRef);
const intact = () => {
  const report = checkSeals(api.ws, loadBooks(api.ws));
  assert.deepEqual(report.checks.map((c) => c.status), ['intact'], JSON.stringify(report.checks));
  assert.equal(readFileSync(sealFile(api.ws, '2026-Q2'), 'utf8'), sealed, 'the seal file is untouched');
};

test('a document linked to an open depreciation booking: linked, the receipt no longer «offen», the booking records it, the filed quarter\'s seal intact', async () => {
  const { status, json } = await api.send('POST', '/api/mapping/add', { receiptId: 'rd', transactionRef: 'M2026-002' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.kept, undefined, 'no payment booking to keep or rebook');
  const books = loadBooks(api.ws);
  assert.deepEqual(linksOf(books, 'rd'), ['M2026-002']);
  assert.deepEqual(books.journalEntries.find((e) => e.id === 'jd')!.receipts, ['rd'], 'the booking records the document it carries');
  const v = ledgerOf(books, '2026-07-01').byId.get('rd')!;
  assert.equal(isOpen(v), false, 'not «offen» once it hangs on the booking');
  assert.equal(v.locked, false);
  intact();
});

test('a booking of a filed quarter takes no document: 403 periodClosed, nothing written, the seal intact', async () => {
  const before = JSON.stringify(loadBooks(api.ws));
  const { status, json } = await api.send('POST', '/api/mapping/add', { receiptId: 'rq', transactionRef: 'M2026-003' });
  assert.equal(status, 403, JSON.stringify(json));
  assert.equal(json.code, 'periodClosed');
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'books unchanged');
  intact();
});

test('an unknown ref is refused with gone; a privately paid receipt hangs on no booking besides its payment', async () => {
  const unknown = await api.send('POST', '/api/mapping/add', { receiptId: 'rd', transactionRef: 'M2026-099' });
  assert.deepEqual([unknown.status, unknown.json.code], [404, 'gone']);
  const paid = await api.send('POST', '/api/mapping/add', { receiptId: 'rp', transactionRef: 'M2026-002', confirm: true });
  assert.deepEqual([paid.status, paid.json.code, (paid.json.params as { payment: string }).payment], [409, 'paidPrivately', 'M2026-001']);
  assert.deepEqual(linksOf(loadBooks(api.ws), 'rp'), ['M2026-001']);
});

test('a receipt that hangs on a booking without a payment is not paid privately on top', async () => {
  const before = JSON.stringify(loadBooks(api.ws));
  const { status, json } = await api.send('POST', '/api/receipts/rd/private-payment');
  assert.equal(status, 409, JSON.stringify(json));
  assert.deepEqual([json.code, (json.params as { entry: string }).entry, (json.params as { replaceable: boolean }).replaceable], ['bookedByHand', 'M2026-002', true], 'the booking that carries it is offered to be replaced');
  assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'books unchanged');
});

test('deleting the booking takes its link along, the receipt is «offen» again; the undo links it again', async () => {
  const entry = loadBooks(api.ws).journalEntries.find((e) => e.id === 'jd')!;
  const del = await api.send('DELETE', '/api/journal-entries/jd');
  assert.equal(del.status, 200, JSON.stringify(del.json));
  let books = loadBooks(api.ws);
  assert.deepEqual(linksOf(books, 'rd'), [], 'no link to a booking that is gone');
  assert.equal(isOpen(ledgerOf(books, '2026-07-01').byId.get('rd')!), true);

  const back = await api.send('POST', '/api/journal-entries', undoInput(entry));
  assert.equal(back.status, 200, JSON.stringify(back.json));
  books = loadBooks(api.ws);
  assert.deepEqual(linksOf(books, 'rd'), ['M2026-002'], 'the undo brings the document back onto the booking');
  intact();
});

test('unlinking from the booking: the receipt is «offen» again and the booking no longer records it', async () => {
  const { status, json } = await api.send('POST', '/api/mapping/remove', { receiptId: 'rd', transactionRef: 'M2026-002' });
  assert.equal(status, 200, JSON.stringify(json));
  const books = loadBooks(api.ws);
  assert.deepEqual(linksOf(books, 'rd'), []);
  assert.equal(books.journalEntries.find((e) => e.id === 'jd')!.receipts, undefined);
  intact();
});

const DAY = '2026-10-05';
const receipt = (id: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: id, extractionMethod: 'pdftotext', fileSize: 10, indexedAt: `${DAY}T08:00:00Z`, location: 'archived', date: DAY, amount: 80, currency: 'CHF', description: `Beleg ${id}` });
const ctx = { bankAccounts: [], chart: new Set<string>(), earlier: [], conversation: 'c1', clearing: new Set<string>() };

function books(): Books {
  const b = emptyBooks();
  b.receipts.push(receipt('gift'), receipt('accrual'));
  b.journalEntries.push({ id: 'ja', transactionRef: 'M2026-004', date: DAY, accountDebit: '6000', accountCredit: '2300', amount: 80, description: 'Abgrenzung Miete', origin: 'manual' });
  return b;
}

test('the AI links a document to a booking without a payment; the change\'s undo takes it back', () => {
  const b = books();
  const made = update(b, PERSON, (x) => applyAnswer(x, [{ kind: 'link', receipt: 'accrual', payment: 'M2026-004' }], ctx));
  assert.deepEqual(linksOf(b, 'accrual'), ['M2026-004']);
  assert.deepEqual(made[0].undo, { kind: 'unlink', receipt: 'accrual', payment: 'M2026-004' });
  update(b, PERSON, (x) => applyChange(x, made[0].undo as BookChange));
  assert.deepEqual(linksOf(b, 'accrual'), []);
});

test('the AI books a gift received with its document in one change; deleting the booking (its undo) takes the link, the redo brings it back', () => {
  const b = books();
  const made = update(b, PERSON, (x) => applyAnswer(x, [{ kind: 'newEntry', entry: { date: DAY, accountDebit: '6500', accountCredit: '7900', amount: 80, description: 'Geschenk erhalten', origin: 'manual', receipts: ['gift'] } }], ctx));
  const entry = b.journalEntries.find((e) => e.description === 'Geschenk erhalten')!;
  assert.match(entry.transactionRef, /^M2026-\d{3}$/);
  assert.notEqual(entry.transactionRef, 'M2026-004', 'a ref of its own');
  assert.deepEqual(linksOf(b, 'gift'), [entry.transactionRef]);
  const redo = update(b, PERSON, (x) => applyChange(x, made[0].undo as BookChange));
  assert.deepEqual(linksOf(b, 'gift'), []);
  update(b, PERSON, (x) => applyChange(x, redo!));
  assert.deepEqual(linksOf(b, 'gift'), [entry.transactionRef]);
});

test('paid privately after all (#87): the booking that carries the receipt gives way with its link; deleting the payment brings both back', () => {
  const b = books();
  update(b, PERSON, (x) => link(x, 'accrual', 'M2026-004'));
  const made = update(b, PERSON, (x) => privatePayment(x, 'accrual', { replace: 'M2026-004' }, loadFxResolver()));
  assert.deepEqual(linksOf(b, 'accrual'), [made.ref], 'the owner\'s payment holds the receipt alone');
  assert.equal(b.journalEntries.some((e) => e.transactionRef === 'M2026-004'), false);
  update(b, PERSON, (x) => dropPayment(x, made.ref));
  assert.deepEqual(linksOf(b, 'accrual'), ['M2026-004'], 'the booking is back with its receipt');
});

test('the link picker offers the open bookings without a payment of the receipt\'s amount, a search finds the others, never a filed one', () => {
  const b = books();
  b.config.closedThrough = '2026-06-30';
  b.journalEntries.push(
    { id: 'jx', transactionRef: 'M2026-005', date: DAY, accountDebit: '6800', accountCredit: '1520', amount: 500, description: 'Abschreibung', origin: 'manual' },
    { id: 'jf', transactionRef: 'M2026-001', date: '2026-05-31', accountDebit: '6000', accountCredit: '2300', amount: 80, description: 'Abgrenzung Mai', origin: 'manual' },
  );
  b.transactions.push({ ref: 'T1', bank: 'Raiffeisen', date: DAY, amount: 80, currency: 'CHF', direction: 'DBIT', description: 'Bank' });
  b.journalEntries.push({ id: 'jt', transactionRef: 'T1', date: DAY, accountDebit: '6000', accountCredit: '1020', amount: 80, description: 'Bank' });
  const l = ledgerOf(b, '2026-07-01');
  assert.deepEqual(bookingsWithoutPayment(l.byId.get('accrual')!, l).map((x) => x.ref), ['M2026-004']);
  assert.deepEqual(bookingsWithoutPayment(l.byId.get('accrual')!, l, 'abschreib').map((x) => x.ref), ['M2026-005']);
  assert.deepEqual(bookingsWithoutPayment(l.byId.get('accrual')!, l, 'abgrenzung').map((x) => x.ref), ['M2026-004'], 'the filed M2026-001 is never offered');
});
