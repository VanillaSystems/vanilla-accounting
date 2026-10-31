/**
 * Migration step 9's gate: booking the demo's open transactions by runs of workflows/booking/
 * gives the entries `npm run classify` gives, from the same model answers. A replay books
 * nothing and shows the same entries; a second run of a booked transaction writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entriesForceMayRemove } from '../src/accounting/classify-force.js';
import { loadBooks, periodLock, saveBooks, update, PERSON } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { loadClassifyContext, mappedReceipts } from '../src/booking/classify.js';
import { providerOfPayment } from '../src/booking/providers.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { moduleActor } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { checkWorkflow, loadWorkflow } from '../src/workflows/load.js';
import { openEngine, type Ask as EngineAsk } from '../src/workflows/engine.js';
import { digestOf, runResult, type Run } from '../src/workflows/model.js';
import { listRuns, saveRun } from '../src/workflows/store.js';
import { DEMO_ROOT, booksOnDisk } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runs-'));
const workflow = loadWorkflow(APP_ROOT, 'booking');

/** A copy of the demo with classify's own open-period entries removed; the model answers with them. */
function prepared(): { ws: Workspace; ask: Ask; refs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-booking-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const removed = new Set(entriesForceMayRemove(books.journalEntries, new Set(books.transactions.map((t) => t.ref)), periodLock(books).closedThrough));
  const answers = new Map<string, JournalEntry[]>();
  for (const e of removed) answers.set(e.transactionRef, [...(answers.get(e.transactionRef) ?? []), e]);
  update(books, PERSON, (b) => { b.journalEntries = b.journalEntries.filter((e) => !removed.has(e)); });
  saveBooks(ws, books);
  const ask: Ask = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, {
      entries: (answers.get(ref) ?? []).map((e) => ({ accountDebit: e.accountDebit, accountCredit: e.accountCredit, amount: e.amount, vatCode: e.vatCode, description: e.description })),
    }])));
  };
  // A shop's payout waits for the person while its file names no clearing account (#203, tests/payment-providers.test.ts): no run books it.
  const counterparties = loadClassifyContext(ws).counterparties ?? [];
  const payout = (ref: string) => { const tx = books.transactions.find((t) => t.ref === ref); return !!tx && !!providerOfPayment(tx, mappedReceipts(books, tx), counterparties); };
  return { ws, ask, refs: [...answers.keys()].filter((ref) => !payout(ref)) };
}

const comparable = (entries: JournalEntry[]) => entries.map(({ id: _, run: __, ...e }) => JSON.stringify(e)).sort();

/** One run of `workflow` on `ref` through the engine, driven to rest. */
async function runOnce(ws: Workspace, ref: string, ask?: EngineAsk, mode: Run['mode'] = 'live'): Promise<Run> {
  const engine = openEngine(() => ws, { appRoot: APP_ROOT, ask: async () => ask });
  const started = await engine.start('booking', { kind: 'transaction', id: ref }, { kind: 'manual' }, mode);
  assert.ok(started.ok, JSON.stringify(started));
  await engine.idle();
  return engine.run(started.ok ? started.run! : '')!;
}

async function replayOf(ws: Workspace, of: Run): Promise<Run> {
  saveRun(ws, of);
  const engine = openEngine(() => ws, { appRoot: APP_ROOT });
  const started = await engine.command({ kind: 'replay', run: of.id });
  assert.ok(started.ok, JSON.stringify(started));
  await engine.idle();
  return engine.run(started.ok ? started.run! : '')!;
}

test('workflows/booking/ passes its lint', () => {
  assert.deepEqual(checkWorkflow(workflow, [workflow]), []);
});

test('the lint finds an outcome that leads nowhere and an effect the action needs', () => {
  const broken = structuredClone(workflow);
  delete broken.steps.find((s) => s.id === 'classify')!.outcomes.undecided;
  broken.steps.find((s) => s.id === 'book')!.effects = [];
  const problems = checkWorkflow(broken, [broken]);
  assert.ok(problems.includes('classify: outcome undecided of accounting.expenses.classification leads nowhere'), problems.join('\n'));
  assert.ok(problems.includes('book: ledger.book needs effect ledger.book, not declared'), problems.join('\n'));
});

test('booking by run equals booking by classify on the demo', async () => {
  const byClassify = prepared();
  const byRuns = prepared();
  try {
    assert.ok(byClassify.refs.length > 10, `the demo has open transactions to book (${byClassify.refs.length})`);
    await runIntake({ ws: byClassify.ws, books: storePort(byClassify.ws, moduleActor('intake')), ask: byClassify.ask, steps: [['classify', classifyStep()]] });
    for (const ref of byRuns.refs) {
      const run = await runOnce(byRuns.ws, ref, byRuns.ask);
      assert.equal(run.state.status, 'done', `${ref}: ${JSON.stringify(run.steps)}`);
    }
    assert.deepEqual(comparable(loadBooks(byRuns.ws).journalEntries), comparable(loadBooks(byClassify.ws).journalEntries));
    assert.equal(listRuns(byRuns.ws).length, byRuns.refs.length);
  } finally {
    rmSync(byClassify.ws.paths.root, { recursive: true, force: true });
    rmSync(byRuns.ws.paths.root, { recursive: true, force: true });
  }
});

test('a replay writes nothing and shows the entries the run booked; a second run books nothing', async () => {
  const { ws, ask, refs } = prepared();
  try {
    const run = await runOnce(ws, refs[0], ask);
    const booked = loadBooks(ws).journalEntries.filter((e) => e.transactionRef === refs[0]);
    assert.ok(booked.every((e) => e.run === run.id), 'every entry the run booked carries its id');
    assert.deepEqual(run.steps.map((s) => `${s.step}:${s.outcome}`), ['open:open', 'classify:decided', 'book:booked']);
    assert.equal(digestOf(run).entries, booked.length, 'the digest counts what the book step booked: «fertig, 1 Buchung gebucht», not 0 (r7f-34)');
    assert.equal(run.steps[1].llm.length, 1, 'the model answer is recorded');

    const before = booksOnDisk(ws);
    const replay = await replayOf(ws, run);
    assert.deepEqual(booksOnDisk(ws), before, 'a replay writes nothing');
    assert.deepEqual(replay.steps.map((s) => `${s.step}:${s.outcome}`), ['open:booked'], 'today the transaction is booked: the replay stops there');

    const again = await runOnce(ws, refs[0], async () => { throw new Error('no model call for a booked transaction'); });
    assert.equal(again.state.status, 'done');
    assert.deepEqual(booksOnDisk(ws), before);
    assert.ok(booked.length > 0);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});

test('a replay of a recorded run on unbooked books shows the would-be entries and books none', async () => {
  const first = prepared();
  const second = prepared();
  try {
    const run = await runOnce(first.ws, first.refs[0], first.ask);
    const live = loadBooks(first.ws).journalEntries.filter((e) => e.transactionRef === first.refs[0]);
    const before = booksOnDisk(second.ws);
    const replay = await replayOf(second.ws, run);
    assert.equal(replay.state.status, 'done');
    assert.deepEqual(booksOnDisk(second.ws), before);
    const effect = replay.steps.find((s) => s.step === 'book')!.effects[0];
    assert.equal(effect.applied, false);
    assert.deepEqual(comparable(effect.would as JournalEntry[]), comparable(live));
    assert.equal(effect.refused, undefined, 'the write door would accept the booking');
  } finally {
    rmSync(first.ws.paths.root, { recursive: true, force: true });
    rmSync(second.ws.paths.root, { recursive: true, force: true });
  }
});

test('without a model the run waits for a person and books nothing', async () => {
  const { ws, refs } = prepared();
  try {
    const before = booksOnDisk(ws);
    const run = await runOnce(ws, refs[0]);
    assert.deepEqual(run.state.status === 'waiting' && run.state.at, 'manual', 'it waits at the person step');
    assert.deepEqual(booksOnDisk(ws), before);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});

test('without a model and without a rule the run waits for a person and says why; the button says it in words (r4c-34)', async () => {
  const { ws, refs } = prepared();
  const run = await runOnce(ws, refs[0]);
  assert.deepEqual([run.state.status, run.state.status === 'waiting' ? run.state.at : ''], ['waiting', 'manual'], JSON.stringify(run.state) + JSON.stringify(run.steps.map((s) => s.error)));
  assert.deepEqual(run.steps.find((s) => s.step === 'classify')?.output, { why: 'noModel' });
  const detail = { ...run, status: 'waiting' as const, at: 'manual', digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] } };
  const waiting = runResult(workflow, detail);
  assert.deepEqual(waiting.kind === 'waiting' && [waiting.noModel, typeof waiting.step === 'string' ? waiting.step : waiting.step.de], [true, 'Von Hand buchen']);
  assert.deepEqual(runResult(workflow, { ...detail, status: 'done', digest: { ...detail.digest, entries: 2 } }), { kind: 'done', entries: 2 });
  rmSync(ws.paths.root, { recursive: true, force: true });
});
