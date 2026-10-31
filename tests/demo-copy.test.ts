/**
 * A running app never writes into a bundled demo (src/workspace/demo-copy.ts): a mailbox connected
 * in `VANILLA_WORKSPACE=demo npm start` fetched real receipts into the public repository. Each
 * test names the wrong behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VANILLA_DEMO_DIR = mkdtempSync(join(tmpdir(), 'demo-copy-'));
process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'demo-approvals-'));
const { bundledDemo, demoCopy, resetDemoCopy } = await import('../src/workspace/demo-copy.js');
const { resetDemo, approvalsPath } = await import('../src/workflows/switch-on.js');
const { APP_ROOT } = await import('../src/workspace/workspace.js');
const { DEMO_REPO, DEMO_ROOT, tempWorkspace } = await import('./support/workspace.js');

test('a bundled demo is known as one, by its repository or its app folder; a copy of it or a company is not', () => {
  assert.equal(bundledDemo(DEMO_ROOT), 'demo');
  assert.equal(bundledDemo(DEMO_REPO), 'demo');
  assert.equal(bundledDemo(join(APP_ROOT, 'demo-consulting')), 'demo-consulting');
  assert.equal(bundledDemo(tempWorkspace().paths.root), undefined, 'a copy outside the app is the person\'s own');
  assert.equal(bundledDemo(APP_ROOT), undefined);
});

test('the demo opens as a copy outside the repository, kept between starts, without the original\'s local data/', () => {
  const root = demoCopy(DEMO_ROOT);
  assert.ok(root.startsWith(process.env.VANILLA_DEMO_DIR!), `opened ${root}, inside the repository`);
  assert.ok(existsSync(join(root, 'belege.workspace.yaml')));
  assert.equal(existsSync(join(root, 'data')), false, 'chat transcripts of the original must not travel');
  writeFileSync(join(root, 'played.txt'), 'x');
  assert.equal(demoCopy(DEMO_REPO), root, 'the same copy again');
  assert.ok(existsSync(join(root, 'played.txt')), 'a second start must not throw away what the person did');
  resetDemoCopy('demo');
  assert.equal(existsSync(join(demoCopy(DEMO_ROOT), 'played.txt')), false, 'reset starts afresh');
});

test('a company workspace opens as itself', () => {
  const ws = tempWorkspace();
  assert.equal(demoCopy(ws.paths.root), ws.paths.root);
});

test('npm start with VANILLA_WORKSPACE=demo opens the copy, so nothing it writes reaches demo/', async () => {
  process.env.VANILLA_WORKSPACE = 'demo';
  const { WS } = await import('../src/server/books.js');
  assert.ok(WS.paths.root.startsWith(process.env.VANILLA_DEMO_DIR!), `the server opened ${WS.paths.root}`);
});

test('resetting a demo also drops the copy\'s switch-on record, or the fresh copy shows as changed and not switched on', () => {
  const root = demoCopy(DEMO_ROOT);
  const record = approvalsPath({ paths: { root } });
  mkdirSync(join(record, '..'), { recursive: true });
  writeFileSync(record, '{}');
  resetDemo('demo');
  assert.equal(existsSync(record), false, 'the old copy\'s record outlived the copy');
  assert.equal(existsSync(root), false);
});
