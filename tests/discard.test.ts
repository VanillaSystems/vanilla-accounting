/**
 * «Löschen» of a file that is no receipt (#228): a quarantined file, and a file listed as «keine
 * Belege», deleted for good through the API. Refused, all or none, when anything in the books
 * refers to a file or it is a receipt; its file leaves the workspace folder it lies in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Receipt } from '../src/types/index.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { yearPaths } from '../src/workspace/workspace.js';
import { putInQuarantine, quarantined } from '../src/intake/quarantine.js';
import { isNoReceipt } from '../src/books/discard.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
const receipts = () => join(yearPaths(api.ws.paths, '2026').receipts);

const doc = (id: string, filename: string, more: Partial<Receipt> = {}): Receipt => ({
  id, filename, originalFilename: filename, extractedText: 'Allgemeine Geschäftsbedingungen', extractionMethod: 'pdftotext', fileSize: 1,
  indexedAt: '2026-08-12T00:00:00Z', location: 'archived', date: '2026-08-12', kind: 'noise', kindBy: 'human', ...more,
});

before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => {
    b.receipts.push(
      doc('agb', 'agb.pdf'),
      doc('prospekt', 'prospekt.pdf', { kind: undefined, kindBy: undefined, amount: 0 }),
      doc('linked', 'linked.pdf'),
      doc('named', 'named.pdf'),
      doc('stmt', 'auszug.pdf', { kind: 'statement' }),
      doc('real', 'rechnung.pdf', { kind: undefined, kindBy: undefined, amount: 12 }),
      doc('twin', 'twin.pdf', { kind: 'duplicate', distinctFrom: ['agb'] }),
    );
    b.mappings.push({ receiptId: 'linked', transactionRef: 'O1' });
    b.journalEntries.find((e) => e.id === 'jo')!.receipts = ['named'];
    b.bankStatements.push({ bank: 'Raiffeisen', filename: 'auszug.pdf', fromDate: '2026-08-01', toDate: '2026-08-31' });
  });
  saveBooks(api.ws, books);
  mkdirSync(receipts(), { recursive: true });
  for (const f of ['agb.pdf', 'prospekt.pdf', 'linked.pdf', 'named.pdf', 'auszug.pdf', 'rechnung.pdf', 'twin.pdf']) writeFileSync(join(receipts(), f), '%PDF-1.4');
});
after(() => api?.stop());

test('a quarantined file is deleted, its reason with it; one that is not there refuses all', async () => {
  const data = api.ws.paths.data;
  const a = putInQuarantine(data, 'agb-shop.pdf', Buffer.from('%PDF a'), { kind: 'not-receipt', why: 'terms' });
  const b = putInQuarantine(data, 'newsletter.pdf', Buffer.from('%PDF b'), { kind: 'not-receipt', why: 'newsletter' });
  const c = putInQuarantine(data, 'preise.pdf', Buffer.from('%PDF c'), { kind: 'held' });

  const missing = await api.send('POST', '/api/quarantine/delete', { files: [a, 'gibt-es-nicht.pdf'] });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json.params, { what: 'quarantined' });
  assert.equal(quarantined(data).length, 3, 'nothing deleted');

  const outside = await api.send('POST', '/api/quarantine/delete', { files: ['../ledger.json'] });
  assert.equal(outside.status, 404, 'never a file outside the quarantine');

  const one = await api.send('POST', '/api/quarantine/delete', { files: [a] });
  assert.equal(one.status, 200);
  assert.deepEqual(quarantined(data).map((q) => q.file).sort(), [b, c].sort());
  assert.equal(existsSync(join(data, 'quarantine', `${a}.reason.txt`)), false, 'its reason goes too');

  // «Alle in der Quarantäne löschen»: what the list shows.
  const all = await api.send('POST', '/api/quarantine/delete', { files: quarantined(data).map((q) => q.file) });
  assert.equal(all.status, 200);
  assert.equal(all.json.deleted, 2);
  assert.deepEqual(quarantined(data), []);
});

test('a file listed as «keine Belege» leaves the books and its folder; another receipt forgets it was told apart from it', async () => {
  const { status, json } = await api.send('POST', '/api/receipts/discard', { ids: ['agb', 'prospekt'] });
  assert.equal(status, 200, json.error as string);
  const books = loadBooks(api.ws);
  assert.equal(books.receipts.some((r) => r.id === 'agb' || r.id === 'prospekt'), false);
  assert.equal(existsSync(join(receipts(), 'agb.pdf')), false);
  assert.equal(existsSync(join(receipts(), 'prospekt.pdf')), false);
  assert.equal(books.receipts.find((r) => r.id === 'twin')?.distinctFrom, undefined);
});

for (const [id, file, refs] of [
  ['linked', 'linked.pdf', { payments: ['O1'], entries: [], statements: 0 }],
  ['named', 'named.pdf', { payments: [], entries: ['jo'], statements: 0 }],
  ['stmt', 'auszug.pdf', { payments: [], entries: [], statements: 1 }],
] as const) {
  test(`refused, all or none: ${file}, which ${JSON.stringify(refs)} refers to`, async () => {
    const { status, json } = await api.send('POST', '/api/receipts/discard', { ids: ['twin', id] });
    assert.equal(status, 409);
    assert.equal(json.code, 'fileReferenced');
    assert.deepEqual(json.params, { file, ...refs });
    const books = loadBooks(api.ws);
    assert.ok(books.receipts.some((r) => r.id === id) && books.receipts.some((r) => r.id === 'twin'), 'nothing deleted');
    assert.ok(existsSync(join(receipts(), file)) && existsSync(join(receipts(), 'twin.pdf')));
  });
}

test('refused: a receipt, an id the books lack, a body without ids', async () => {
  assert.equal((await api.send('POST', '/api/receipts/discard', { ids: ['real'] })).status, 400);
  assert.ok(existsSync(join(receipts(), 'rechnung.pdf')));
  const gone = await api.send('POST', '/api/receipts/discard', { ids: ['nie'] });
  assert.equal(gone.status, 404);
  assert.equal(gone.json.code, 'gone');
  assert.equal((await api.send('POST', '/api/receipts/discard', {})).status, 400);
  assert.equal((await api.send('POST', '/api/receipts/discard', { ids: [] })).status, 400);
});

test('isNoReceipt: the kinds set aside, or 0 without VAT and without a payment', () => {
  assert.equal(isNoReceipt(doc('a', 'a.pdf'), 0), true);
  assert.equal(isNoReceipt(doc('a', 'a.pdf', { kind: undefined, amount: 0 }), 0), true);
  assert.equal(isNoReceipt(doc('a', 'a.pdf', { kind: undefined, amount: 0 }), 1), false);
  assert.equal(isNoReceipt(doc('a', 'a.pdf', { kind: undefined, amount: 0, vatSummary: [{ ratePercent: 8.1, vat: 1 }] }), 0), false);
  assert.equal(isNoReceipt(doc('a', 'a.pdf', { kind: 'invoice' }), 0), false);
});
