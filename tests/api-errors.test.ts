/**
 * An unexpected failure inside a route reaches the UI as a JSON `{ error }` with the cause, not
 * Express's HTML 500 page (which the client could only show as "HTTP 500").
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
let bin = '';

before(async () => {
  bin = mkdtempSync(join(tmpdir(), 'api-errors-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\necho "model down" >&2\nexit 1\n');
  chmodSync(join(bin, 'claude'), 0o755);
  api = await startApi('tests/fixtures/classify-index.json', { PATH: `${bin}:${process.env.PATH}` });
  mkdirSync(join(api.root, 'transactional-data/2026/receipts'), { recursive: true });
  writeFileSync(join(api.root, 'transactional-data/2026/receipts', '2026-08-12_shop-eu_rechnung.pdf'), 'PDF rw');
});
after(() => {
  api?.stop();
  rmSync(bin, { recursive: true, force: true });
});

test('a failing model call answers 500 with a JSON error naming the cause', async () => {
  const { status, json } = await api.send('POST', '/api/vision/extract', { receiptId: 'rw' });
  assert.equal(status, 500);
  assert.match(String(json.error), /claude exited 1: model down/);
});
