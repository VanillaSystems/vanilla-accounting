/**
 * Cross-site writes to the Mac app's server (review of #551): a page of any other site in the
 * person's browser can send 127.0.0.1 a form or a no-cors fetch. Every write must come from the
 * app's own page (its Origin) or from no page at all (the main process, Node); reads stay open.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer, sameOrigin } from '../src/desktop/server.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-origin-'));
process.env.VANILLA_WORKSPACE = '';
process.chdir(home);
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
desktop.allowHost(base.slice('http://'.length));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (path: string, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array([1, 2, 3]) });

test('a write from another site is refused 403 foreignOrigin before it reaches any route: the hand-over drop, opening a copy, statements', async () => {
  for (const path of ['/api/desktop/handover', '/api/handover/open', '/api/statements', '/api/desktop/open']) {
    for (const headers of <Array<Record<string, string>>>[{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: 'http://localhost:5173' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: base, 'Sec-Fetch-Site': 'cross-site' }]) {
      const res = await post(path, headers);
      assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(((await res.json()) as { code?: string }).code, 'foreignOrigin');
    }
  }
});

test('the app\'s own page (its Origin, same-origin) and the main process (no Origin) reach the routes; reads from anywhere are not refused', async () => {
  for (const headers of <Array<Record<string, string>>>[{ Origin: base, 'Sec-Fetch-Site': 'same-origin' }, {}, { 'Sec-Fetch-Site': 'none' }]) {
    const res = await post('/api/desktop/handover', headers);
    assert.notEqual(((await res.json().catch(() => ({}))) as { code?: string }).code, 'foreignOrigin', JSON.stringify(headers));
  }
  const read = await fetch(`${base}/api/desktop`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.status, 200);
});

test('sameOrigin: the rule itself', () => {
  assert.equal(sameOrigin(undefined, undefined, '127.0.0.1:1'), true);
  assert.equal(sameOrigin('http://127.0.0.1:1', 'same-origin', '127.0.0.1:1'), true);
  assert.equal(sameOrigin('http://127.0.0.1:2', undefined, '127.0.0.1:1'), false);
  assert.equal(sameOrigin(undefined, 'cross-site', '127.0.0.1:1'), false);
  assert.equal(sameOrigin('http://127.0.0.1:1', undefined, undefined), false);
});
