/**
 * Audit mode (READONLY=1, `npm run start:audit`): /api/status says so, so the UI shows its bar
 * and hides edit controls, and every write is refused with a code the UI translates.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json', { READONLY: '1' }); });
after(() => api?.stop());

test('status reports audit mode', async () => {
  assert.deepEqual((await api.send('GET', '/api/status')).json, { ok: true, readonly: true });
});

test('a write in an open period is refused with code readonly, the books unchanged', async () => {
  const before = readFileSync(api.indexPath);
  const { status, json } = await api.send('PATCH', '/api/transactions/O1', { description: 'neu' });
  assert.equal(status, 403);
  assert.equal(json.code, 'readonly');
  assert.match(String(json.error), /Nur-Lese-Modus/);
  assert.ok(readFileSync(api.indexPath).equals(before), 'books.json is byte-identical');
});

test('reads still work', async () => {
  assert.equal((await api.send('GET', '/api/accounts')).status, 200);
});
