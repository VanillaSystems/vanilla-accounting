/**
 * The desktop app's phone access (src/desktop/server.ts, src/server/phone.ts): off until switched
 * on; on, a second listener on the local network answers the phone's paths only, the API ones
 * only with the pairing token; the books API on 127.0.0.1 stays as it was, behind its host guard;
 * port and token stay across a restart; a new code locks out the old one.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer, listen, portOf } from '../src/desktop/server.js';
import { tokenMatches } from '../src/server/phone.js';
import { fromNetwork, lan, type NetworkInit } from './support/from-network.js';
import { readState } from '../src/desktop/state.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'phone-runs-'));
const home = mkdtempSync(join(tmpdir(), 'vanilla-phone-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const stateFile = join(home, 'desktop.json');
const make = () => desktopServer({ stateFile, demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const desktop = make();
const server: Server = await listen(desktop.app, '127.0.0.1', undefined);
const port = portOf(server);
desktop.allowHost(`127.0.0.1:${port}`);
await desktop.openDemo();
const inbox = (await import('../src/server/books.js')).WS.paths.inbox;
after(async () => { await desktop.phone.set(false); server.close(); });

const PDF = '%PDF-1.4 phone';

const local = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
// Another device as the server sees it: this machine's LAN address is not loopback.
const fromPhone = (phonePort: number, path: string, init: NetworkInit = {}, token?: string) =>
  fromNetwork(phonePort, path, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
const upload = { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Captured-At': '2026-10-16T08:12:00' }, body: PDF };
const inboxFiles = () => (existsSync(inbox) ? readdirSync(inbox) : []);

test('off by default: nothing listens for the phone, and the state names no token', async () => {
  const info = desktop.phone.info();
  assert.equal(info.on, false);
  assert.equal(info.qr, undefined);
  assert.equal(readState(stateFile).phone, undefined);
});

test('on: the phone paths answer from the network, the API ones only with the token; nothing else answers', async () => {
  const info = await desktop.phone.set(true);
  assert.equal(info.on, true);
  assert.ok(info.port && info.port !== port, 'a port of its own');
  const token = readState(stateFile).phone!.token;
  assert.ok(token.length >= 40, 'a long random token');
  if (lan) assert.equal(info.url, `http://${lan}:${info.port}/scan#token=${token}`, 'the QR code carries the scan page and the token');
  if (lan) assert.match(info.qr ?? '', /^<svg /);

  for (const path of ['/books.json', '/api/journal-entries', '/api/workspace', '/api/desktop', '/api/inbox', '/']) {
    assert.equal((await fromPhone(info.port!, path, {}, token)).status, 404, `${path} is not there for the phone, token or not`);
  }
  assert.equal((await fromPhone(info.port!, '/api/upload', { method: 'PUT', body: PDF }, token)).status, 404, 'only POST uploads');
  assert.equal((await fromPhone(info.port!, '/scan')).status, 200, 'the scan page loads without the token');

  assert.equal((await fromPhone(info.port!, '/api/status')).status, 401);
  assert.equal((await fromPhone(info.port!, '/api/status', {}, 'wrong')).status, 401);
  assert.equal((await fromPhone(info.port!, '/api/status', {}, token)).status, 200);

  const before = inboxFiles();
  const refused = await fromPhone(info.port!, '/api/upload', upload);
  assert.deepEqual([refused.status, (await refused.json()).code], [401, 'phoneToken']);
  assert.equal((await fromPhone(info.port!, '/api/upload', upload, `${token}x`)).status, 401);
  assert.deepEqual(inboxFiles(), before, 'a refused upload writes nothing');
  const taken = await fromPhone(info.port!, '/api/upload', upload, token);
  assert.equal(taken.status, 200);
  assert.ok(inboxFiles().includes((await taken.json()).filename), 'with the token the scan is in the inbox');
});

test('the books API on 127.0.0.1 is as it was: served there, its host guard holds, the UI uploads without a token', async () => {
  assert.equal((await local('/books.json')).status, 200);
  const other = await new Promise<number>((resolve) => {
    httpRequest({ host: '127.0.0.1', port, path: '/books.json', headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode!); }).end();
  });
  assert.equal(other, 403, 'a page under another name is refused');
  assert.equal((await local('/api/upload', upload)).status, 200, "the app's own upload needs no token");
  if (lan) {
    const direct = await fetch(`http://${lan}:${port}/books.json`).then((r) => r.status, () => 'refused');
    assert.equal(direct, 'refused', 'the books port is not on the network');
  }
});

test('off closes the listener; on again (and after a restart) has the same port and token; a new code locks out the old', async () => {
  const { port: phonePort } = desktop.phone.info();
  const { token } = readState(stateFile).phone!;
  assert.equal((await desktop.phone.set(false)).on, false);
  assert.equal(await fromPhone(phonePort!, '/api/status', {}, token).then((r) => r.status, () => 'refused'), 'refused');
  assert.equal(readState(stateFile).phone!.token, token, 'off keeps the token');

  const again = await desktop.phone.resume();
  assert.equal(again.on, false, 'resume leaves it off when it was off');
  const on = await desktop.phone.set(true);
  assert.equal(on.port, phonePort, 'the same port');
  assert.equal((await fromPhone(phonePort!, '/api/status', {}, token)).status, 200, 'a paired phone gets through again');

  desktop.phone.renew();
  const fresh = readState(stateFile).phone!.token;
  assert.notEqual(fresh, token);
  assert.equal((await fromPhone(phonePort!, '/api/status', {}, token)).status, 401, 'the old code is refused');
  assert.equal((await fromPhone(phonePort!, '/api/status', {}, fresh)).status, 200);
  assert.equal(statSync(stateFile).mode & 0o077, 0, 'the state file holding the token is readable by its user only');

  await desktop.phone.set(false);
  writeFileSync(stateFile, JSON.stringify({ ...readState(stateFile), phone: { on: true, token: fresh, port: phonePort } }));
  const restarted = make();
  const resumed = await restarted.phone.resume();
  try {
    assert.deepEqual([resumed.on, resumed.port], [true, phonePort], 'after a restart it is on again, on its port');
    const status = await fromPhone(phonePort!, '/api/status', {}, fresh);
    assert.equal(status.status, 409, 'with the same token (no books open in the new app yet)');
    assert.equal((await fromPhone(phonePort!, '/api/status', {}, token)).status, 401);
  } finally {
    await restarted.phone.set(false);
  }
});

test('the token is compared whole', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  for (const given of [undefined, '', 'ab', 'abcd', 'ABC']) assert.equal(tokenMatches(given, 'abc'), false, String(given));
});

test('the LAN listener hands the books nothing but the phone paths: every other path, method or spelling is refused before the books see it (corner-45)', async () => {
  const { phoneApp } = await import('../src/server/phone.js');
  const reached: string[] = [];
  const lanApp = phoneApp((req, res) => { reached.push(`${req.method} ${req.path}`); res.json({ ok: true }); }, () => 'tok');
  const s = await listen(lanApp, '127.0.0.1', undefined);
  const at = (path: string, init: RequestInit = {}, token?: string) =>
    fetch(`http://127.0.0.1:${portOf(s)}${path}`, { ...init, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try {
    for (const [method, path] of [['GET', '/books.json'], ['GET', '/api/journal-entries'], ['POST', '/api/journal-entries'], ['PATCH', '/api/receipts/x'], ['GET', '/api/workspace'],
      ['GET', '/api/desktop/phone'], ['POST', '/api/desktop/phone'], ['GET', '/'], ['GET', '/API/STATUS'], ['GET', '/api/status/'], ['GET', '/api/status/../workspace'], ['GET', '/scan/../books.json'],
      ['DELETE', '/api/upload'], ['PUT', '/api/upload'], ['GET', '/api/upload'], ['POST', '/api/status'], ['GET', '/api/assistant']] as const) {
      assert.equal((await at(path, { method }, 'tok')).status, 404, `${method} ${path}`);
    }
    assert.equal((await at('/api/status')).status, 401, 'no token');
    assert.equal((await at('/api/upload', { method: 'POST', body: 'x' }, 'other')).status, 401, 'another token');
    assert.deepEqual(reached, [], 'the books saw none of it');
    assert.equal((await at('/api/status', {}, 'tok')).status, 200);
    assert.equal((await at('/scan')).status, 200, 'the page needs no token');
    assert.deepEqual(reached, ['GET /api/status', 'GET /scan']);
  } finally {
    s.close();
  }
});
