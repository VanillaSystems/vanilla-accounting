/**
 * The API listens on the network only for the phone app's scan upload. A request from another device
 * (here: this machine's own LAN address, which the server sees as non-loopback) reaches nothing else.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { startApi, type ApiServer } from './support/api-server.js';

const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
let api: ApiServer;

before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

test('from this computer, the books are served', async () => {
  const res = await fetch(`http://127.0.0.1:${api.port}/books.json`);
  assert.equal(res.status, 200);
});

test('from the network, only the phone upload paths answer', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = (path: string, init?: RequestInit) => fetch(`http://${lan}:${api.port}${path}`, init);
  for (const path of ['/books.json', '/api/journal-entries', '/api/workspace']) {
    const res = await at(path);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, 'localOnly', path);
  }
  const write = await at('/api/journal-entries/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(write.status, 403, 'writes from the network are refused');
  assert.equal((await at('/api/status')).status, 200, 'the phone app can find the server');
  assert.equal((await at('/scan')).status, 200, 'the scan page loads');
  assert.notEqual((await at('/api/upload', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' })).status, 403, 'the phone can upload');
});
