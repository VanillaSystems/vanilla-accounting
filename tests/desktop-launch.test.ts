/**
 * What the Mac app shows when it starts (src/desktop/state.ts launchDecision): the start screen,
 * unless books are marked "Immer diese Buchhaltung öffnen"; ⌥ held shows the start screen once; marked
 * books whose folder is gone show the start screen with a notice. The mark lives in desktop.json.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { launchDecision, opened, readState, writeState, type DesktopState } from '../src/desktop/state.js';
import { DEMO_ROOT } from './support/workspace.js';

const here = (root: string) => (r: string) => r === root;

test('no mark: the start screen, also with recent books (a desktop.json from before the mark)', () => {
  assert.deepEqual(launchDecision({ recent: ['/b/a', '/b/b'] }, false, () => true), { kind: 'start' });
});

test('marked books open directly', () => {
  assert.deepEqual(launchDecision({ recent: ['/b/a', '/b/b'], autoOpen: '/b/b' }, false, here('/b/b')), { kind: 'open', root: '/b/b' });
});

test('marked books whose folder is gone: the start screen, naming them', () => {
  assert.deepEqual(launchDecision({ recent: ['/b/a'], autoOpen: '/b/moved' }, false, here('/b/a')), { kind: 'start', missing: '/b/moved' });
});

test('⌥ held: the start screen once, the mark kept', () => {
  const state: DesktopState = { recent: ['/b/a'], autoOpen: '/b/a' };
  assert.deepEqual(launchDecision(state, true, () => true), { kind: 'start' });
  assert.equal(state.autoOpen, '/b/a');
});

test('desktop.json: an old file reads without a mark; the marked books stay on the recent list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-launch-'));
  const file = join(dir, 'desktop.json');
  writeFileSync(file, JSON.stringify({ recent: ['/b/a'], port: 4000 }));
  assert.deepEqual(readState(file), { recent: ['/b/a'], port: 4000 });
  let state: DesktopState = { recent: ['/b/0'], autoOpen: '/b/0' };
  for (let i = 1; i <= 9; i++) state = opened(state, `/b/${i}`);
  assert.equal(state.recent.length, 8);
  assert.equal(state.recent[0], '/b/9');
  assert.ok(state.recent.includes('/b/0'), 'the marked books are still listed');
  writeState(file, state);
  assert.equal(readState(file).autoOpen, '/b/0');
});

const home = mkdtempSync(join(tmpdir(), 'vanilla-launch-server-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, demoSource: DEMO_ROOT });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
desktop.allowHost(`127.0.0.1:${port}`);
after(() => server.close());
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};

test('the start screen marks one of its recent books, moves the mark, removes it; a missing mark is reported until changed', async () => {
  const demo = (await call('POST', '/api/desktop/demo')).json.root;
  assert.equal((await call('GET', '/api/desktop')).json.autoOpen, null);
  assert.equal((await call('PUT', '/api/desktop/auto-open', { root: '/not/listed' })).status, 400, 'only recent books');
  const marked = await call('PUT', '/api/desktop/auto-open', { root: demo });
  assert.equal(marked.json.autoOpen, demo);
  assert.equal(readState(join(home, 'desktop.json')).autoOpen, demo);
  desktop.autoOpenMissing(demo);
  assert.equal((await call('GET', '/api/desktop')).json.autoOpenMissing, demo);
  const cleared = await call('PUT', '/api/desktop/auto-open', { root: null });
  assert.equal(cleared.json.autoOpen, null);
  assert.equal(cleared.json.autoOpenMissing, null);
  assert.equal(readState(join(home, 'desktop.json')).autoOpen, undefined);
});
