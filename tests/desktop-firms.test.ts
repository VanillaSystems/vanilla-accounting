/**
 * The desktop app's server with books of two kinds of firm on one machine: the engines compute for
 * the books open now, whatever other books the start screen lists (persona round 5, r5f-18/22/23:
 * the recent list held a firm not registered for VAT, and the open net-rate firm's half year was
 * «no filing period» and its filed H1 «none of the firm's approved net rates»).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { desktopServer } from '../src/desktop/server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-desktop-firms-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
desktop.allowHost(`127.0.0.1:${port}`);
after(() => server.close());

const copyOf = (demo: string, name: string): string => {
  const root = join(home, name);
  cpSync(join(APP_ROOT, demo, APP_FOLDER), join(root, APP_FOLDER), { recursive: true });
  return root;
};

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

test('the start screen listing books of another kind of firm leaves the open books on their own setup', async () => {
  const salon = copyOf('demo-coiffeur', 'Salon');
  const schreinerei = copyOf('demo-schreinerei', 'Schreinerei');
  assert.equal((await call('POST', '/api/desktop/open', { root: salon })).status, 200);
  assert.equal((await call('POST', '/api/desktop/open', { root: schreinerei })).status, 200);

  const info = await call('GET', '/api/desktop');
  assert.deepEqual(info.json.recent.map((b: { name: string }) => b.name), ['Schreinerei Beispiel GmbH', 'Salon Beispiel']);

  const filed = await call('GET', '/api/vat/filed?year=2026');
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  assert.deepEqual(filed.json.map((r: { period: string }) => r.period), ['2026-H1'], 'the filed half year reads with the firm\'s net rate');
});
