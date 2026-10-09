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

const FIXTURE = 'tests/fixtures/period-lock-index.json';
let api: ApiServer;
let receiptsDir = '';

before(async () => {
  api = await startApi(FIXTURE);
  receiptsDir = join(api.root, 'receipts');
});
after(() => {
  chmodSync(dirname(api.indexPath), 0o755);
  api?.stop();
});

beforeEach(() => {
  chmodSync(dirname(api.indexPath), 0o755);
  copyFileSync(FIXTURE, api.indexPath);
  rmSync(receiptsDir, { recursive: true, force: true });
  mkdirSync(receiptsDir);
  writeFileSync(join(receiptsDir, 'open.pdf'), 'PDF ro');
  writeFileSync(join(receiptsDir, 'taken.pdf'), 'PDF other');
});

const readIndex = (): Index => JSON.parse(readFileSync(api.indexPath, 'utf8'));
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
  const rest = (i: Index) => ({ ...i, schema: undefined, receipts: undefined, transactions: undefined });
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
  ['an unknown field', { filename: 'neu.pdf', kind: 'noise' }],
];

for (const [what, body] of invalid) {
  test(`receipt: ${what} refuses the whole edit (400), nothing changes`, async () => {
    const before = readFileSync(api.indexPath);
    const { status } = await api.send('PATCH', '/api/receipts/ro', body);
    assert.equal(status, 400);
    assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
    assert.deepEqual(files(), ['open.pdf', 'taken.pdf']);
  });
}

test('receipt: renaming onto an existing file is refused (409), nothing changes', async () => {
  const before = readFileSync(api.indexPath);
  const { status, json } = await api.send('PATCH', '/api/receipts/ro', { filename: 'taken.pdf', description: 'neu' });
  assert.equal(status, 409);
  assert.match(String(json.error), /taken\.pdf existiert bereits/);
  assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
  assert.equal(readFileSync(join(receiptsDir, 'taken.pdf'), 'utf8'), 'PDF other');
  assert.equal(readFileSync(join(receiptsDir, 'open.pdf'), 'utf8'), 'PDF ro');
});

test('receipt: a failed index write undoes the rename', async () => {
  const before = readFileSync(api.indexPath);
  chmodSync(dirname(api.indexPath), 0o555);
  const { status } = await api.send('PATCH', '/api/receipts/ro', { filename: 'neu.pdf', description: 'neu' });
  assert.equal(status, 500);
  assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
  assert.deepEqual(files(), ['open.pdf', 'taken.pdf'], 'the file has its old name again');
});

test('receipt: closed period refuses the whole edit (403)', async () => {
  writeFileSync(join(receiptsDir, 'closed.pdf'), 'PDF rc');
  const before = readFileSync(api.indexPath);
  const { status } = await api.send('PATCH', '/api/receipts/rc', { filename: 'neu.pdf', remarks: 'neu' });
  assert.equal(status, 403);
  assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
  assert.ok(existsSync(join(receiptsDir, 'closed.pdf')) && !existsSync(join(receiptsDir, 'neu.pdf')));
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
  const before = readFileSync(api.indexPath);
  const { status } = await api.send('PATCH', '/api/transactions/O1', { remarks: 'Notiz', description: '  ' });
  assert.equal(status, 400);
  assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
});

test('transaction: unknown ref is 404', async () => {
  const { status } = await api.send('PATCH', '/api/transactions/NOPE', { remarks: 'x' });
  assert.equal(status, 404);
});
