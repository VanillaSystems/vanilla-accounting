/**
 * POST /api/upload puts a PDF into the inbox under its capture time; files captured in the same
 * second (several dropped at once) each keep their own file.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

test('two PDFs of the same second are both kept', async () => {
  const send = (body: string) => fetch(`http://127.0.0.1:${api.port}/api/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Captured-At': '2026-10-09T10:11:12' }, body,
  }).then((r) => r.json() as Promise<{ filename: string }>);
  const a = await send('%PDF-1.4 a');
  const b = await send('%PDF-1.4 b');
  assert.equal(a.filename, '20261009-101112.pdf');
  assert.equal(b.filename, '20261009-101112-2.pdf');
  const inbox = join(api.root, 'beleg-import');
  assert.deepEqual(readdirSync(inbox).sort(), [a.filename, b.filename].sort());
  assert.equal(readFileSync(join(inbox, b.filename), 'utf8'), '%PDF-1.4 b');
});
