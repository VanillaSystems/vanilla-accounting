/**
 * The inbox as runs (workflows/receipt-intake, src/intake/ as its steps): a run gives the books
 * the old job gave, record for record, its new records carrying the run's id; a run that crashed
 * between two steps resumes at its step and writes nothing twice. Without a model, as a CLI would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor, type Books } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { PIPELINE } from '../src/intake/run.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { openEngine } from '../src/workflows/engine.js';
import type { Run } from '../src/workflows/model.js';
import { saveRun } from '../src/workflows/store.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'intake-runs-'));

/** The demo with a phone scan in its inbox. */
function inbox(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'intake-runs-ws-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'beleg-import'));
  copyFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf'), join(dir, 'beleg-import', 'scan.pdf'));
  appendFileSync(join(dir, 'beleg-import', 'scan.pdf'), '\n% scanned\n');
  return workspaceAt(dir);
}

/** The books without the run's id and the moments of reading, which differ between two runs by design. */
function comparable(b: Books): unknown {
  const strip = <T extends object>(xs: T[]) => xs.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !['run', 'indexedAt', 'vatExtractedAt'].includes(k))));
  return { ...b, journalEntries: strip(b.journalEntries), mappings: strip(b.mappings), receipts: strip(b.receipts) };
}

async function byRun(ws: Workspace): Promise<Run> {
  const engine = openEngine(() => ws, { appRoot: APP_ROOT });
  const r = await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  return engine.run(r.run!)!;
}

test('a run gives the books the old job gave; what it added carries its id', async () => {
  const [job, run] = [inbox(), inbox()];
  await runIntake({ ws: job, books: storePort(job, moduleActor('intake')), steps: PIPELINE });
  const r = await byRun(run);
  assert.equal(r.state.status, 'done');
  assert.deepEqual(r.steps.map((s) => s.step), ['read', 'facts', 'match', 'book']);
  assert.deepEqual(comparable(loadBooks(run)), comparable(loadBooks(job)));
  const added = r.steps.flatMap((s) => s.effects.flatMap((e) => e.wrote.receipts ?? []));
  assert.equal(added.length, 1, 'the scan is the one receipt it added');
  assert.ok(loadBooks(run).receipts.some((x) => x.id === added[0] && x.filename === 'scan.pdf' && x.run === r.id), 'the receipt names the run that took it up');
});

test('a run that crashed between two steps resumes at its step and writes nothing twice', async () => {
  const ws = inbox();
  const done = await byRun(ws);
  const books = JSON.stringify(loadBooks(ws));
  const crashed: Run = { ...done, state: { status: 'running', at: 'match', since: done.startedAt }, steps: done.steps.slice(0, 2) };
  saveRun(ws, crashed);
  const after = openEngine(() => ws, { appRoot: APP_ROOT });
  await after.idle();
  const resumed = after.run(done.id)!;
  assert.deepEqual([resumed.state.status, resumed.steps.map((s) => s.step)], ['done', ['read', 'facts', 'match', 'book']]);
  assert.equal(JSON.stringify(loadBooks(ws)), books, 'the books as after the first run');
});
