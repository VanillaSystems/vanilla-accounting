/**
 * Every app path answers with the app; the API, the books and the files stay data
 * (src/server/app-paths.ts). /receipts/<id> is the app, /receipts/<name>.pdf the file.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppPath } from '../src/server/app-paths.js';
import { startApi, type ApiServer } from './support/api-server.js';

test('app paths and data paths', () => {
  for (const p of ['/', '/receipts', '/receipts/3f2a9c01b7d4e5f6', '/journal/M2026-001', '/vat/codes/I81', '/payments/ZKB-4711~2', '/bank/1021-2026-09', '/invoices/2026-001', '/invoices/draft-in_x', '/invoices/sent/sd_x', '/de/2026-Q3/journal-entries']) {
    assert.ok(isAppPath(p), p);
  }
  for (const p of ['/api', '/api/status', '/scan', '/scan/manifest.json', '/books.json', '/receipts/20260930-coop.pdf', '/bank-statements/zkb/sept.xml', '/invoices/2026-001.pdf', '/invoices/sent/sd_x.pdf', '/assets/index-abc.js', '/favicon.svg']) {
    assert.ok(!isAppPath(p), p);
  }
});

let api: ApiServer;
let dist: string;
before(async () => {
  dist = mkdtempSync(join(tmpdir(), 'belege-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
  api = await startApi('tests/fixtures/period-lock-index.json', { APP_DIST: dist });
  mkdirSync(join(api.root, 'transactional-data/2026/receipts'), { recursive: true });
  writeFileSync(join(api.root, 'transactional-data/2026/receipts', 'scan.pdf'), '%PDF-1.4');
});
after(() => { api?.stop(); rmSync(dist, { recursive: true, force: true }); });

test('the server answers every app path with the built app, and files as files', async () => {
  const get = (path: string) => fetch(`http://127.0.0.1:${api.port}${path}`);
  for (const path of ['/journal/M2026-001', '/receipts/3f2a9c01b7d4e5f6', '/receipts', '/vat/codes/I81?period=2026-Q3', '/de/2026-Q3/journal-entries']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>app<\/title>/, path);
  }
  assert.equal(await (await get('/receipts/scan.pdf')).text(), '%PDF-1.4');
  assert.equal((await get('/receipts/missing.pdf')).status, 404);
  assert.deepEqual(await (await get('/api/status')).json(), { ok: true, readonly: false });
  assert.equal((await get('/api/nope')).status, 404);
});
