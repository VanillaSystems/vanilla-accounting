/**
 * The workflows collection and collect (src/workflows/collect.ts, ADR 0014): the collection finds
 * the sources with a feed due and starts one collect run per source; a pull that is ok ends the
 * run with its checkpoint in the ledger; a mail source without its password waits for a person;
 * a second collection finds nothing due.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveSource, sources } from '../src/platform/sources/index.js';
import { readLedger } from '../src/platform/sources/ledger.js';
import { openEngine } from '../src/workflows/engine.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'collect-runs-'));
process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'collect-approvals-'));
process.env.VANILLA_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'collect-secrets-')), 'none.json');

test('the collection pulls every source with a feed due, one run each; a mailbox without its password waits for a person', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collect-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  mkdirSync(join(ws.paths.root, 'sources', 'counter'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'counter', 'source.yaml'), 'label: Counter\ncode: ./source.ts\nfeeds:\n  ticks: { output: document, every: daily }\n');
  writeFileSync(join(ws.paths.root, 'sources', 'counter', 'source.ts'), 'export default { ticks: async function* (io: any, from: any) { yield io.out.checkpoint((from.cursor ?? 0) + 1); } };\n');
  mkdirSync(join(ws.paths.root, 'sources', 'office'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), 'label: Office\ncode: app:imap\nsettings: { boxes: [{ label: Office, address: office@example.com }] }\nreach:\n  mail: { host: imap.example.com, account: office@example.com, from: ["*"] }\nfeeds:\n  attachments: { output: document, every: daily }\n');
  for (const v of sources(ws, APP_ROOT)) if (v.kind !== 'invalid') approveSource(ws, v.decl);

  const engine = openEngine(() => ws, { appRoot: APP_ROOT });
  const r = await engine.start('collection', { kind: 'company', id: 'company' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const children = engine.runs().filter((x) => x.workflow === 'collect');
  const state = (id: string) => { const c = children.find((x) => x.item.id === id)!; return c.state.status === 'waiting' ? `waiting ${c.state.at}` : c.state.status; };
  assert.deepEqual([state('counter'), state('office')], ['done', 'waiting secret']);
  assert.deepEqual(readLedger(ws, 'counter').map((l) => ('cursor' in l ? l.cursor : undefined)), [1]);

  const again = await engine.start('collection', { kind: 'company', id: 'company' }, { kind: 'manual' });
  await engine.idle();
  const second = engine.run(again.ok ? again.run! : '')!;
  assert.deepEqual(second.steps[0].output?.sources, [{ kind: 'source', id: 'office' }], 'only the office is due: it has delivered nothing yet');
  assert.equal(readLedger(ws, 'counter').length, 1, 'the counter is not due again today');
});
