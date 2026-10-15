/**
 * PATCH /api/receipts/:id and PATCH /api/transactions/:ref apply one edit as one write:
 * exactly the sent fields change, and a refused or failed edit changes nothing, on disk or in
 * the index. Runs the real API server against tests/fixtures/period-lock-index.json.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Index } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { booksOnDisk, writeIndex } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt, yearPaths } from '../src/workspace/workspace.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;
let receiptsDir = '';

before(async () => {
  api = await startApi(FIXTURE);
  receiptsDir = join(api.root, 'transactional-data/2026/receipts');
});
after(() => {
  chmodSync(yearPaths(api.ws.paths, '2026').books, 0o755);
  api?.stop();
});

beforeEach(() => {
  chmodSync(yearPaths(api.ws.paths, '2026').books, 0o755);
  writeIndex(api.ws, JSON.parse(readFileSync(FIXTURE, 'utf8')));
  rmSync(receiptsDir, { recursive: true, force: true });
  mkdirSync(receiptsDir);
  writeFileSync(join(receiptsDir, 'open.pdf'), 'PDF ro');
  writeFileSync(join(receiptsDir, 'taken.pdf'), 'PDF other');
});

const readIndex = (): Index => loadBooks(workspaceAt(api.ws.paths.root));
const files = () => readdirSync(receiptsDir).sort();

/** Every record of the index that differs from the fixture, as `<collection>[<key>].<field>`. */
function changedFields(after: Index): string[] {
  const fixture: Index = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const out: string[] = [];
  const collections = [
    ['receipts', (r: { id: string }) => r.id],
    ['transactions', (t: { ref: string }) => t.ref],
  ] as const;
  for (const [name, key] of collections) {
    const was = new Map((fixture[name] as Array<never>).map((r) => [key(r), r as Record<string, unknown>]));
    for (const rec of after[name] as Array<never>) {
      const old = was.get(key(rec)) ?? {};
      const now = rec as Record<string, unknown>;
      for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) {
        if (JSON.stringify(old[field]) !== JSON.stringify(now[field])) out.push(`${name}[${key(rec)}].${field}`);
      }
    }
  }
  // The books' files keep records sorted by id (ADR 0013), the fixture in its own order.
  const byKey = <T>(xs: T[] | undefined) => xs?.map((x) => JSON.stringify(x)).sort();
  const rest = (i: Index) => ({ ...i, schema: undefined, receipts: undefined, transactions: undefined, mappings: byKey(i.mappings), journalEntries: byKey(i.journalEntries) });
  assert.deepEqual(rest(after), rest(fixture), 'mappings, entries and config are untouched');
  return out.sort();
}

test('receipt: all changed fields land in one write, the file is renamed', async () => {
  const { status, json } = await api.send('PATCH', '/api/receipts/ro', {
    filename: ' neu.pdf ', date: '2026-08-12', amount: 21.5, currency: 'eur', description: 'Beschreibung', remarks: 'Notiz',
  });
  assert.equal(status, 200, String(json.error));
  const ro = readIndex().receipts.find((r) => r.id === 'ro')!;
  assert.deepEqual(
    { filename: ro.filename, date: ro.date, amount: ro.amount, currency: ro.currency, description: ro.description, remarks: ro.remarks },
    { filename: 'neu.pdf', date: '2026-08-12', amount: 21.5, currency: 'EUR', description: 'Beschreibung', remarks: 'Notiz' },
  );
  assert.deepEqual(json.receipt, ro, 'the response is the saved receipt');
  assert.deepEqual(changedFields(readIndex()), [
    'receipts[ro].amount', 'receipts[ro].currency', 'receipts[ro].date', 'receipts[ro].description', 'receipts[ro].filename', 'receipts[ro].remarks',
  ]);
  assert.deepEqual(files(), ['neu.pdf', 'taken.pdf']);
});

test('receipt: only the sent field changes', async () => {
  const { status } = await api.send('PATCH', '/api/receipts/ro', { remarks: 'Notiz' });
  assert.equal(status, 200);
  assert.deepEqual(changedFields(readIndex()), ['receipts[ro].remarks']);
  assert.deepEqual(files(), ['open.pdf', 'taken.pdf']);
});

test('receipt: an empty description or remark clears it', async () => {
  await api.send('PATCH', '/api/receipts/ro', { description: 'x', remarks: 'y' });
  const { status } = await api.send('PATCH', '/api/receipts/ro', { description: '', remarks: '' });
  assert.equal(status, 200);
  const ro = readIndex().receipts.find((r) => r.id === 'ro')!;
  assert.ok(!('description' in ro) && !('remarks' in ro));
});

const invalid: Array<[string, Record<string, unknown>]> = [
  ['an invalid amount', { filename: 'neu.pdf', description: 'neu', amount: 'zwölf', currency: 'CHF' }],
  ['amount without currency', { filename: 'neu.pdf', amount: 12 }],
  ['a bad date', { filename: 'neu.pdf', date: '12.08.2026' }],
  ['a path as filename', { filename: '../neu.pdf', description: 'neu' }],
  ['an unknown field', { filename: 'neu.pdf', vendor: 'neu' }],
  ['an unknown kind', { filename: 'neu.pdf', kind: 'brochure' }],
  ['a currency with a cleared amount', { filename: 'neu.pdf', amount: null, currency: 'EUR' }],
];

for (const [what, body] of invalid) {
  test(`receipt: ${what} refuses the whole edit (400), nothing changes`, async () => {
    const before = JSON.stringify(booksOnDisk(api.ws));
    const { status } = await api.send('PATCH', '/api/receipts/ro', body);
    assert.equal(status, 400);
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
    assert.deepEqual(files(), ['open.pdf', 'taken.pdf']);
  });
}

test('receipt: renaming onto an existing file is refused (409), nothing changes', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await api.send('PATCH', '/api/receipts/ro', { filename: 'taken.pdf', description: 'neu' });
  assert.equal(status, 409);
  assert.match(String(json.error), /taken\.pdf existiert bereits/);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  assert.equal(readFileSync(join(receiptsDir, 'taken.pdf'), 'utf8'), 'PDF other');
  assert.equal(readFileSync(join(receiptsDir, 'open.pdf'), 'utf8'), 'PDF ro');
});

test('receipt: a failed index write undoes the rename', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  chmodSync(yearPaths(api.ws.paths, '2026').books, 0o555);
  const { status } = await api.send('PATCH', '/api/receipts/ro', { filename: 'neu.pdf', description: 'neu' });
  assert.equal(status, 500);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  assert.deepEqual(files(), ['open.pdf', 'taken.pdf'], 'the file has its old name again');
});

test('receipt: closed period refuses the whole edit (403)', async () => {
  writeFileSync(join(receiptsDir, 'closed.pdf'), 'PDF rc');
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status } = await api.send('PATCH', '/api/receipts/rc', { filename: 'neu.pdf', remarks: 'neu' });
  assert.equal(status, 403);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  assert.ok(existsSync(join(receiptsDir, 'closed.pdf')) && !existsSync(join(receiptsDir, 'neu.pdf')));
});

const VAT = { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 1.62 }], vatId: ' CHE-111.222.333 ' };

test('receipt: VAT facts are checked at the door (400), nothing changes', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  for (const vat of [
    { hasSwissVat: true, vatSummary: [] },
    { hasSwissVat: true, vatSummary: [{ ratePercent: 19, vat: 3.8 }] },
    { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 'viel' }] },
    { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 1 }, { ratePercent: 8.1, vat: 2 }] },
    { hasSwissVat: true, vatSummary: [{ ratePercent: -8.1, vat: 1 }] },
    { vatSummary: [] },
  ]) assert.equal((await api.send('PATCH', '/api/receipts/ro', { description: 'neu', vat })).status, 400, JSON.stringify(vat));
  assert.equal((await api.send('PATCH', '/api/receipts/ro', { vatBy: null })).status, 400, 'vatBy only with facts');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
});

test('receipt: VAT facts of a receipt in a filed quarter are refused (403)', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  assert.equal((await api.send('PATCH', '/api/receipts/rc', { vat: VAT })).status, 403);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
});

test('transaction: all sent fields land in one write', async () => {
  const { status, json } = await api.send('PATCH', '/api/transactions/O1', { description: '  Neu  ', remarks: 'Notiz', noReceiptNeeded: true });
  assert.equal(status, 200, String(json.error));
  const o1 = readIndex().transactions.find((t) => t.ref === 'O1')!;
  assert.deepEqual([o1.description, o1.remarks, o1.noReceiptNeeded], ['Neu', 'Notiz', true]);
  assert.deepEqual(changedFields(readIndex()), ['transactions[O1].description', 'transactions[O1].noReceiptNeeded', 'transactions[O1].remarks']);
});

test('transaction: noReceiptNeeded false and an empty remark clear the fields', async () => {
  await api.send('PATCH', '/api/transactions/O1', { remarks: 'Notiz', noReceiptNeeded: true });
  const { status } = await api.send('PATCH', '/api/transactions/O1', { remarks: '', noReceiptNeeded: false });
  assert.equal(status, 200);
  assert.deepEqual(changedFields(readIndex()), []);
});

test('transaction: an empty description refuses the whole edit (400)', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status } = await api.send('PATCH', '/api/transactions/O1', { remarks: 'Notiz', description: '  ' });
  assert.equal(status, 400);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
});

test('transaction: unknown ref is 404', async () => {
  const { status } = await api.send('PATCH', '/api/transactions/NOPE', { remarks: 'x' });
  assert.equal(status, 404);
});
