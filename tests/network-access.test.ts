/**
 * The API listens on the network only for the phone app's scan upload. A request from another device
 * (here: from this machine's own LAN address, which the server sees as non-loopback) reaches nothing
 * else, and the phone's API paths only with the pairing token: VANILLA_PHONE_TOKEN, or without it a
 * new token at each start, which the terminal prints in the pairing links.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { fromNetwork, lan, type NetworkInit } from './support/from-network.js';

let api: ApiServer;
let paired: ApiServer;
const TOKEN = 'test-token-of-this-phone';
const upload = { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' };

// Listens on every interface, as `npm start` does.
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '', VANILLA_PHONE_TOKEN: '' });
  paired = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '', VANILLA_PHONE_TOKEN: TOKEN });
});
after(async () => { await Promise.all([api?.stop(), paired?.stop()]); });

const withToken = (port: number) => (path: string, init: NetworkInit = {}, token?: string) =>
  fromNetwork(port, path, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

/** The token of a start, from the pairing link the terminal prints for this machine's LAN address. */
const printedToken = (s: ApiServer) => s.output().match(new RegExp(`http://${lan}:${s.port}/scan#token=([\\w-]+)`))?.[1];

test('from this computer, the books are served', async () => {
  const res = await api.fetch('/books.json');
  assert.equal(res.status, 200);
});

test('from the network, only the phone paths answer', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = (path: string, init?: NetworkInit) => fromNetwork(api.port, path, init);
  for (const path of ['/books.json', '/api/journal-entries', '/api/workspace']) {
    const res = await at(path);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, 'localOnly', path);
  }
  const write = await at('/api/journal-entries/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(write.status, 403, 'writes from the network are refused');
  assert.equal((await at('/scan')).status, 200, 'the scan page loads');
});

test('without VANILLA_PHONE_TOKEN: from the network the upload and status need the token of this start, which the terminal prints', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = withToken(api.port);
  const refused = await at('/api/upload', upload);
  assert.deepEqual([refused.status, (await refused.json()).code], [401, 'phoneToken'], 'an upload without the token is refused');
  assert.equal((await at('/api/status')).status, 401, 'status without the token is refused');
  const token = printedToken(api);
  assert.ok(token && token.length >= 40, 'the terminal prints the pairing link with a long random token');
  assert.equal((await at('/api/upload', upload, `${token}x`)).status, 401, 'another token is refused');
  assert.equal((await at('/api/status', {}, token)).status, 200, 'the phone app finds the server with the token');
  assert.equal((await at('/api/upload', upload, token)).status, 200, 'the phone uploads with the token');
  assert.equal((await at('/books.json', {}, token)).status, 403, 'the token opens the phone paths only');
  assert.equal((await api.fetch('/api/upload', upload)).status, 200, 'this computer needs no token');
});

test('each start makes its own token: one start\'s token opens no other', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const other = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '', VANILLA_PHONE_TOKEN: '' });
  try {
    const token = printedToken(api);
    assert.ok(printedToken(other) && printedToken(other) !== token, 'a token of its own');
    assert.equal((await withToken(other.port)('/api/upload', upload, token)).status, 401);
  } finally {
    await other.stop();
  }
});

test('with VANILLA_PHONE_TOKEN: from the network the upload and status need it; from this computer nothing changes', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = withToken(paired.port);
  assert.equal((await at('/api/status')).status, 401);
  const refused = await at('/api/upload', upload, 'not-the-token');
  assert.deepEqual([refused.status, (await refused.json()).code], [401, 'phoneToken']);
  assert.equal((await at('/api/status', {}, TOKEN)).status, 200);
  assert.equal((await at('/api/upload', upload, TOKEN)).status, 200);
  assert.equal((await at('/books.json', {}, TOKEN)).status, 403, 'the token opens the phone paths only');
  assert.equal((await at('/scan')).status, 200);
  assert.equal(printedToken(paired), TOKEN, 'the terminal prints the pairing link with that token');
  assert.equal((await paired.fetch('/api/upload', upload)).status, 200, 'this computer needs no token');
});
