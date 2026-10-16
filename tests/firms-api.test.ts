/**
 * The books API for the other kinds of firm (persona round 5): on the net tax rate method and
 * without VAT registration, the server takes only the codes the firm's form takes, a check of the
 * year close that fails answers an error instead of hanging, and a firm without returns closes its
 * year without one. On the real API server (tests/support/api-server.ts) with the demo manifest of
 * each kind of firm and a temp copy of tests/fixtures/sale-vat-index.json.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT, yearPaths } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';

const FIXTURE = 'tests/fixtures/sale-vat-index.json';
const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });
async function start(manifestOf?: string): Promise<ApiServer> {
  const api = await startApi(FIXTURE, {}, manifestOf ? { manifestOf: join(APP_ROOT, manifestOf, APP_FOLDER) } : {});
  servers.push(api);
  return api;
}

const ENTRY = { date: '2026-08-12', accountDebit: '4000', accountCredit: '1020', amount: 540.5, description: 'Holz Beispiel' };

test('a year-close check that cannot be computed answers an error, never a request that hangs (r5f-23)', async () => {
  const api = await start();
  const filings = yearPaths(api.ws.paths, '2026').filings;
  mkdirSync(filings, { recursive: true });
  writeFileSync(join(filings, 'mwst-ech0217-2026-Q1.xml'), '<?xml version="1.0"?><VATDeclaration>broken</VATDeclaration>');
  const res = await api.fetch('/api/year-close/2026', { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 500);
  const body = await res.json() as { error: string };
  assert.match(body.error, /2026-Q1|reportingPeriod|VATDeclaration/);
});

test('net tax rate method: the server refuses an input-tax code on an entry, a change and a payment booked by hand; the firm\'s own code passes (r5f-17)', async () => {
  const api = await start('demo-schreinerei');
  const refused = await api.send('POST', '/api/journal-entries', { ...ENTRY, vatCode: 'I81' });
  assert.deepEqual([refused.status, refused.json.code], [400, 'codeNotTaken'], JSON.stringify(refused.json));
  assert.deepEqual(refused.json.params, { code: 'I81', method: 'net-rate' });
  assert.ok(!loadBooks(api.ws).journalEntries.some((e) => e.vatCode === 'I81'), 'nothing was saved');

  const ok = await api.send('POST', '/api/journal-entries', { date: '2026-08-12', accountDebit: '1020', accountCredit: '3400', amount: 1000, description: 'Barverkauf', vatCode: 'F1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const id = (ok.json.entry as { id: string }).id;
  const changed = await api.send('PATCH', `/api/journal-entries/${id}`, { vatCode: 'I81' });
  assert.deepEqual([changed.status, changed.json.code], [400, 'codeNotTaken']);
  assert.equal(loadBooks(api.ws).journalEntries.find((e) => e.id === id)?.vatCode, 'F1');

  const booked = loadBooks(api.ws).journalEntries.find((e) => e.transactionRef === 'S-CH')!;
  assert.equal((await api.send('DELETE', `/api/journal-entries/${booked.id}`)).status, 200);
  const payment = await api.send('POST', '/api/transactions/S-CH/entries', { lines: [{ accountDebit: '1020', accountCredit: '3400', amount: 1081, vatCode: 'I81', description: 'Beratung' }] });
  assert.deepEqual([payment.status, payment.json.code], [400, 'codeNotTaken']);
});

test('not registered: the server refuses every VAT code, a code typed by hand included (r5f-5)', async () => {
  const api = await start('demo-coiffeur');
  const refused = await api.send('POST', '/api/journal-entries', { ...ENTRY, vatCode: 'M81' });
  assert.deepEqual([refused.status, refused.json.code, refused.json.params], [400, 'codeNotTaken', { code: 'M81', method: 'none' }], JSON.stringify(refused.json));
  const ok = await api.send('POST', '/api/journal-entries', ENTRY);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});
