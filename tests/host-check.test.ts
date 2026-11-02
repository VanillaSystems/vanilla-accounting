/**
 * DNS rebinding: a page of any site can point its own name at 127.0.0.1, and its requests then come
 * from this computer's browser, naming that site in Host. The API answers this computer only under
 * a loopback name (localhost, 127.0.0.1, [::1], any port); under another name a request counts as
 * from the network: the books are refused, the phone paths need the pairing token.
 */
import { request } from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { fromNetwork, lan, type NetworkInit } from './support/from-network.js';

let api: ApiServer;
const TOKEN = 'test-token-of-this-phone';
const upload = { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' };
const withToken = (init: NetworkInit): NetworkInit => ({ ...init, headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` } });

// Listens on every interface, as `npm start` does.
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '', VANILLA_PHONE_TOKEN: TOKEN }); });
after(async () => { await api?.stop(); });

/** A request from this computer that names the server `host`, as a page whose name was rebound to 127.0.0.1 sends it. */
const underName = (host: string, path: string, init: NetworkInit = {}) => new Promise<Response>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: api.port, path, method: init.method ?? 'GET', headers: { ...init.headers, host, connection: 'close' }, agent: false }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
  });
  req.on('error', reject);
  req.end(init.body);
});

test('under another name the books, their files and every write are refused with foreignHost', async () => {
  const names = [`evil.example:${api.port}`, 'evil.example', `${lan ?? '192.168.1.20'}:${api.port}`, `localhost.evil.example:${api.port}`, `127.0.0.1.evil.example:${api.port}`];
  const requests = [['GET', '/books.json'], ['GET', '/api/journal-entries'], ['GET', '/receipts/x.pdf'], ['PATCH', '/api/journal-entries/x']] as const;
  for (const host of names) {
    for (const [method, path] of requests) {
      const res = await underName(host, path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 403, `${method} ${path} as ${host}`);
      assert.equal((await res.json()).code, 'foreignHost', `${method} ${path} as ${host}`);
    }
  }
});

test('under a loopback name, on any port, the books are served', async () => {
  for (const host of [`localhost:${api.port}`, 'localhost', `LOCALHOST:${api.port}`, `127.0.0.1:${api.port}`, `[::1]:${api.port}`, 'localhost:5181']) {
    assert.equal((await underName(host, '/books.json')).status, 200, host);
  }
});

test('under another name the phone upload and status need the pairing token, as from the network', async () => {
  const host = `evil.example:${api.port}`;
  const refused = await underName(host, '/api/upload', upload);
  assert.deepEqual([refused.status, (await refused.json()).code], [401, 'phoneToken'], 'no upload without the token');
  assert.equal((await underName(host, '/api/status')).status, 401);
  assert.equal((await underName(host, '/api/upload', withToken(upload))).status, 200, 'with the token as the phone sends it');
  assert.equal((await underName(`localhost:${api.port}`, '/api/upload', upload)).status, 200, 'this computer under localhost needs no token');
});

test('the phone on the local network, under the LAN address, still uploads with its token', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = (path: string, init: NetworkInit = {}) => fromNetwork(api.port, path, { ...init, headers: { ...init.headers, host: `${lan}:${api.port}` } });
  assert.equal((await at('/api/upload', withToken(upload))).status, 200);
  assert.equal((await at('/api/status', withToken({}))).status, 200);
  assert.equal((await at('/books.json', withToken({}))).status, 403, 'the token opens the phone paths only');
});
