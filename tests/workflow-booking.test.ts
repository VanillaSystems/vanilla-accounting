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
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { moduleActor } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { checkWorkflow, loadWorkflow } from '../src/workflows/load.js';
import { replayRun, runWorkflow } from '../src/workflows/runner.js';
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
  return { ws, ask, refs: [...answers.keys()] };
}

const comparable = (entries: JournalEntry[]) => entries.map(({ id: _, ...e }) => JSON.stringify(e)).sort();

test('workflows/booking/ passes its lint', () => {
  assert.deepEqual(checkWorkflow(workflow), []);
});

test('the lint finds an outcome that leads nowhere and an effect the action needs', () => {
  const broken = structuredClone(workflow);
  delete broken.steps.classify.outcomes.undecided;
  broken.steps.book.effects = [];
  const problems = checkWorkflow(broken);
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
      const run = await runWorkflow(workflow, ref, { ws: byRuns.ws, ask: byRuns.ask });
      assert.equal(run.status, 'done', `${ref}: ${JSON.stringify(run.steps)}`);
      saveRun(byRuns.ws, run);
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
    const run = await runWorkflow(workflow, refs[0], { ws, ask });
    const booked = loadBooks(ws).journalEntries.filter((e) => e.transactionRef === refs[0]);
    assert.deepEqual(run.steps.map((s) => `${s.step}:${s.outcome}`), ['open:open', 'classify:decided', 'book:booked']);
    assert.equal(run.steps[1].llm.length, 1, 'the model answer is recorded');

    const before = booksOnDisk(ws);
    const replay = await replayRun(workflow, { ...run, steps: run.steps }, { ws });
    assert.deepEqual(booksOnDisk(ws), before, 'a replay writes nothing');
    assert.deepEqual(replay.steps.map((s) => `${s.step}:${s.outcome}`), ['open:booked'], 'today the transaction is booked: the replay stops there');

    const again = await runWorkflow(workflow, refs[0], { ws, ask: async () => { throw new Error('no model call for a booked transaction'); } });
    assert.equal(again.status, 'done');
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
    const run = await runWorkflow(workflow, first.refs[0], { ws: first.ws, ask: first.ask });
    const live = loadBooks(first.ws).journalEntries.filter((e) => e.transactionRef === first.refs[0]);
    const before = booksOnDisk(second.ws);
    const replay = await replayRun(workflow, run, { ws: second.ws });
    assert.equal(replay.status, 'done');
    assert.deepEqual(booksOnDisk(second.ws), before);
    const effect = replay.steps.find((s) => s.step === 'book')!.effects[0];
    assert.equal(effect.applied, false);
    assert.deepEqual(comparable(effect.value as JournalEntry[]), comparable(live));
  } finally {
    rmSync(first.ws.paths.root, { recursive: true, force: true });
    rmSync(second.ws.paths.root, { recursive: true, force: true });
  }
});

test('without a model the run waits for a person and books nothing', async () => {
  const { ws, refs } = prepared();
  try {
    const before = booksOnDisk(ws);
    const run = await runWorkflow(workflow, refs[0], { ws });
    assert.equal(run.status, 'waiting');
    assert.deepEqual(booksOnDisk(ws), before);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});
