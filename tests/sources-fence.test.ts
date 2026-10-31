/**
 * The boundary of a source's code (src/platform/sources/child.mjs, launcher.ts; ADR 0014): an echo
 * source round-trips its records, a checkpoint and a channel call answered by the host; inside the
 * child, writing a file, starting a process or a worker, reading outside its folder, fetch and
 * reaching a built-in through process all fail; a canary secret of the host never reaches the
 * child, by environment or by message; the static check refuses what the fence stops at runtime.
 * Plain node; the Mac app's utility process is a later proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeLauncher, runFeed, SourceError, type Launcher } from '../src/platform/sources/launcher.js';
import { checkCode } from '../src/platform/sources/load.js';
import type { ParentMessage, Yielded } from '../src/platform/sources/model.js';

const CANARY = 'canary-7f3a-not-for-sources';
process.env.VANILLA_CANARY = CANARY;

function source(code: string, files: Record<string, string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'fence-')), 'src');
  mkdirSync(dir);
  writeFileSync(join(dir, 'source.ts'), code);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

/** The node launcher, logging every message the host sends. */
function logged(): { launcher: Launcher; sent: ParentMessage[] } {
  const sent: ParentMessage[] = [];
  return {
    sent,
    launcher: { start: (folder) => { const c = nodeLauncher.start(folder); return { ...c, send: (m) => { sent.push(m); c.send(m); } }; } },
  };
}

async function collect(folder: string, launcher: Launcher = nodeLauncher, settings: Record<string, unknown> = {}): Promise<Yielded[]> {
  const out: Yielded[] = [];
  for await (const y of runFeed(launcher, { folder, entry: 'source.ts', feed: 'items', from: { kind: 'new' }, settings }, async (channel, method, args) => ({ channel, method, args }))) out.push(y);
  return out;
}

test('an echo source round-trips its records, a checkpoint and a channel call the host answers', async () => {
  const dir = source(`import { label } from './label.js';
export default {
  items: async function* (io: any) {
    for (const x of io.settings.items) yield io.out.record({ ...x, label: label(x.id) }, { key: String(x.id) });
    yield io.out.checkpoint(io.settings.items.length);
    const answer = await io.api.get('orders.json', { since: 1 });
    yield io.out.record(answer, { key: 'echo' });
  },
};
`, { 'label.ts': 'export const label = (n: number): string => `item ${n}`;\n' });
  assert.deepEqual(checkCode(dir, './source.ts'), []);
  const got = await collect(dir, nodeLauncher, { items: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(got, [
    { kind: 'record', record: { id: 1, label: 'item 1' }, key: '1' },
    { kind: 'record', record: { id: 2, label: 'item 2' }, key: '2' },
    { kind: 'checkpoint', cursor: 2 },
    { kind: 'record', record: { channel: 'api', method: 'get', args: ['orders.json', { since: 1 }] }, key: 'echo' },
  ]);
});

test('inside the fence: no writing, no process, no worker, no reading outside, no fetch, no built-in through process', async () => {
  const attempts: Record<string, string> = {
    write: "const fs = await import('node:fs'); fs.writeFileSync(join, 'x');",
    spawn: "const cp = await import('node:child_process'); const r = cp.spawnSync('ls'); if (r.error) throw r.error;",
    worker: "const w = await import('node:worker_threads'); new w.Worker('1', { eval: true });",
    read: "const fs = await import('node:fs'); fs.readFileSync('/etc/hosts');",
    fetch: "await fetch('https://example.com');",
    builtin: "(process as any).getBuiltinModule('node:net');",
  };
  for (const [what, line] of Object.entries(attempts)) {
    const dir = source(`const join = '/tmp/fence-${what}';\nexport default { items: async function* () { ${line} yield 1; } };\n`);
    await assert.rejects(collect(dir), (e: Error) => e instanceof SourceError && /ERR_ACCESS_DENIED|not defined|not a function|Access to this API/.test(e.message), what);
    assert.ok(checkCode(dir, './source.ts').length > 0 || what === 'fetch', `the static check refuses ${what} before it runs`);
  }
});

test('a canary secret of the host reaches the child neither by environment nor by message', async () => {
  const dir = source(`export default { items: async function* (io: any) { yield io.out.record({ env: typeof globalThis.process, keys: Object.keys(globalThis).filter((k) => /canary/i.test(k)) }, { key: 'k' }); } };\n`);
  const { launcher, sent } = logged();
  const [first] = await collect(dir, launcher);
  assert.deepEqual(first, { kind: 'record', record: { env: 'undefined', keys: [] }, key: 'k' });
  assert.ok(!JSON.stringify(sent).includes(CANARY), 'no message carries it');
});

test('the static check refuses a bare import and a built-in reached by name', () => {
  const dir = source("import x from 'lodash';\nconst m = (globalThis as any).process?.getBuiltinModule?.('node:net');\nexport default { items: async function* () {} };\n");
  assert.deepEqual(checkCode(dir, './source.ts').map((p) => p.line), [1, 2, 2]);
});
