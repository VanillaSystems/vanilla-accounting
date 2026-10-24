/**
 * npm run desktop:dev (tools/desktop/dev.mjs): the desktop server hands the page and its modules
 * to Vite and keeps the API, the start screen's routes and the host check its own, so the window
 * talks to the same server as in the packed app.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';

const listening = (s: Server) => new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port)));

const seen: string[] = [];
const vite = createServer((req, res) => { seen.push(req.url!); res.setHeader('content-type', 'text/plain'); res.end(`vite ${req.url} ${req.headers.host}`); });
const vitePort = await listening(vite);

const home = mkdtempSync(join(tmpdir(), 'vanilla-desktop-dev-'));
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist: join(home, 'no-dist'), devUi: `http://127.0.0.1:${vitePort}` });
const server = createServer(desktop.app);
const port = await listening(server);
desktop.allowHost(`127.0.0.1:${port}`);
// Without devUi the built UI, from a checkout under a dot folder as an agent's worktree is (.claude/worktrees/…).
const dist = join(home, '.claude', 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>built</title>');
// The books' API serves this built UI too (src/server/files.ts), as a checkout with a dist folder has it.
process.env.APP_DIST = dist;
const built = desktopServer({ stateFile: join(home, 'built.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist });
const builtServer = createServer(built.app);
const builtPort = await listening(builtServer);
built.allowHost(`127.0.0.1:${builtPort}`);
after(() => { server.close(); vite.close(); builtServer.close(); });

// node:http, since fetch does not let a request name another Host.
const get = (path: string, host = `127.0.0.1:${port}`, to = port) => new Promise<{ status: number; text: string }>((resolve, reject) => {
  request({ host: '127.0.0.1', port: to, path, headers: { host } }, (res) => {
    let text = '';
    res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => resolve({ status: res.statusCode!, text }));
  }).on('error', reject).end();
});

test('pages and modules come from Vite, with Vite as their host', async () => {
  for (const path of ['/', '/start?new', '/journal/M2026-001', '/@vite/client', '/src/main.tsx?t=1']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.text, `vite ${path} 127.0.0.1:${vitePort}`, path);
  }
});

test('the API, the start screen and the books\' files never reach Vite', async () => {
  seen.length = 0;
  assert.equal((await get('/api/desktop')).status, 200);
  assert.equal(JSON.parse((await get('/api/status')).text).code, 'noWorkspace');
  assert.equal((await get('/receipts/scan.pdf')).status, 404);
  assert.deepEqual(seen, []);
});

test('another host is refused before anything is forwarded', async () => {
  seen.length = 0;
  assert.equal((await get('/', 'evil.example:80')).status, 403);
  assert.deepEqual(seen, []);
});

test('without devUi nothing is forwarded: the built UI answers every app path', async () => {
  seen.length = 0;
  for (const path of ['/', '/start', '/journal/M2026-001']) {
    const res = await get(path, `127.0.0.1:${builtPort}`, builtPort);
    assert.equal(res.status, 200, path);
    assert.match(res.text, /<title>built<\/title>/, path);
  }
  assert.deepEqual(seen, []);
});

test('with books open, pages still come from Vite, not from the built UI the books\' API serves', async () => {
  await desktop.openDemo();
  seen.length = 0;
  for (const path of ['/', '/journal/M2026-001', '/src/main.tsx?t=2']) {
    const res = await get(path);
    assert.equal(res.text, `vite ${path} 127.0.0.1:${vitePort}`, path);
  }
  assert.equal((await get('/api/status')).status, 200);
  assert.deepEqual(seen, ['/', '/journal/M2026-001', '/src/main.tsx?t=2']);
});
