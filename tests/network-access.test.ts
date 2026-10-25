/**
 * The API listens on the network only for the phone app's scan upload. A request from another device
 * (here: from this machine's own LAN address, which the server sees as non-loopback) reaches nothing
 * else. With VANILLA_PHONE_TOKEN set, the phone's API paths need that token from the network.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { startApi, type ApiServer } from './support/api-server.js';

const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
let api: ApiServer;
let paired: ApiServer;
const TOKEN = 'test-token-of-this-phone';

// Listens on every interface, as `npm start` does.
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '' });
  paired = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_API_HOST: '', VANILLA_PHONE_TOKEN: TOKEN });
});
after(async () => { await Promise.all([api?.stop(), paired?.stop()]); });

/**
 * A request as from another device: sent from the LAN address to 127.0.0.1, so the server sees a
 * peer that is not loopback while the packets stay on the loopback interface. Sent to the LAN
 * address, a connection passes the machine's network filters (a firewall, a VPN), which under load
 * held it for up to 18 s or closed it before any answer (#122).
 */
function fromNetwork(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', localAddress: lan, port, path, method: init.method ?? 'GET', headers: { ...init.headers, connection: 'close' }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

test('from this computer, the books are served', async () => {
  const res = await api.fetch('/books.json');
  assert.equal(res.status, 200);
});

test('from the network, only the phone upload paths answer', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = (path: string, init?: Parameters<typeof fromNetwork>[2]) => fromNetwork(api.port, path, init);
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

test('with VANILLA_PHONE_TOKEN: from the network the upload and status need it; from this computer nothing changes', { skip: !lan && 'no LAN address on this machine' }, async () => {
  const at = (path: string, init: Parameters<typeof fromNetwork>[2] = {}, token?: string) =>
    fromNetwork(paired.port, path, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const upload = { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' };
  assert.equal((await at('/api/status')).status, 401);
  const refused = await at('/api/upload', upload, 'not-the-token');
  assert.deepEqual([refused.status, (await refused.json()).code], [401, 'phoneToken']);
  assert.equal((await at('/api/status', {}, TOKEN)).status, 200);
  assert.equal((await at('/api/upload', upload, TOKEN)).status, 200);
  assert.equal((await at('/books.json', {}, TOKEN)).status, 403, 'the token opens the phone paths only');
  assert.equal((await at('/scan')).status, 200);
  assert.equal((await paired.fetch('/api/upload', upload)).status, 200, 'this computer needs no token');
});
