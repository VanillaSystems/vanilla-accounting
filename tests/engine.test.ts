/**
 * The workflow engine (src/workflows/engine.ts): runs move only by legal transitions and are saved
 * after every step; a crashed run resumes without booking twice; AI steps share two slots; a
 * person's answer continues a waiting run; an emitted event starts the workflows that listen; a
 * call waits for its children; a dry run checks a booking through the write door and saves nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { openEngine } from '../src/workflows/engine.js';
import { transition, RunStateError, type Run } from '../src/workflows/model.js';
import { listRuns, saveRun } from '../src/workflows/store.js';
import { DEMO_ROOT, booksOnDisk } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'engine-runs-'));

function demo(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'engine-ws-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  return workspaceAt(dir);
}

/** An app root with the given workflows: { id: { 'workflow.yaml': …, '<step>/step.yaml': … } }. */
function app(workflows: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-app-'));
  for (const [id, files] of Object.entries(workflows)) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, 'workflows', id, file.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(root, 'workflows', id, file), text);
    }
  }
  return root;
}

const wf = (steps: string[], extra = '') => `label: T\nphase: book\nfor: transaction\nsteps: [${steps.join(', ')}]\n${extra}`;

ACTIONS['test.ok'] = { outcomes: ['ok'], effects: [], run: () => ({ outcome: 'ok' }) };
let gate: Promise<void> = Promise.resolve();
ACTIONS['test.think'] = { outcomes: ['ok'], effects: [], ai: true, run: async () => { await gate; return { outcome: 'ok' }; } };
ACTIONS['test.list'] = { outcomes: ['ok'], effects: [], run: () => ({ outcome: 'ok', output: { items: [{ kind: 'transaction', id: 'a' }, { kind: 'transaction', id: 'b' }] } }) };
ACTIONS['test.book-open'] = {
  outcomes: ['booked'], effects: ['ledger.book'],
  run: (_i, fx) => { fx['ledger.book']!([{ id: 'y1', transactionRef: 'y', date: '2026-09-15', accountDebit: '6500', accountCredit: '1020', amount: 10 } as JournalEntry]); return { outcome: 'booked' }; },
};
ACTIONS['test.book-closed'] = {
  outcomes: ['booked'], effects: ['ledger.book'],
  run: (_i, fx) => { fx['ledger.book']!([{ id: 'x1', transactionRef: 'x', date: '2026-01-15', accountDebit: '6500', accountCredit: '1020', amount: 10 } as JournalEntry]); return { outcome: 'booked' }; },
};

test('a run moves only by legal transitions', () => {
  const run = { state: { status: 'done', finishedAt: '2026-10-14T00:00:00Z' }, id: 'r' } as Run;
  assert.throws(() => transition(run, { status: 'running', at: 'a', since: '' }), RunStateError);
  assert.equal(transition(run, { status: 'discarded', at: '', reason: 'x' }).state.status, 'discarded');
});

test('a person\'s answer continues a waiting run; an outcome the step does not have is refused', async () => {
  const root = app({ ask: { 'workflow.yaml': wf(['first', 'ask', 'last']), 'first/step.yaml': 'uses: test.ok\noutcomes: { ok: ask }\n', 'ask/step.yaml': 'by: person\ntask: { title: Look }\noutcomes: { yes: last, no: done }\n', 'last/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' } });
  const ws = demo();
  const engine = openEngine(() => ws, { appRoot: root });
  const r = await engine.start('ask', { kind: 'transaction', id: 't' }, { kind: 'manual' });
  await engine.idle();
  const id = r.ok ? r.run! : '';
  const waiting = engine.run(id)!.state;
  assert.deepEqual(waiting.status === 'waiting' && waiting.at, 'ask');
  assert.deepEqual(await engine.command({ kind: 'answer', run: id, outcome: 'maybe' }), { ok: false, refusal: 'unknown-outcome', detail: 'yes, no' });
  assert.deepEqual(await engine.command({ kind: 'answer', run: id, outcome: 'yes' }), { ok: true, run: id });
  await engine.idle();
  const done = engine.run(id)!;
  assert.equal(done.state.status, 'done');
  assert.deepEqual(done.steps.map((s) => `${s.step}:${s.outcome}`), ['first:ok', 'ask:yes', 'last:ok']);
});

test('two AI steps run at a time; the third waits for an AI slot', async () => {
  const root = app({ think: { 'workflow.yaml': wf(['think']), 'think/step.yaml': 'uses: test.think\noutcomes: { ok: done }\n' } });
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const ws = demo();
  const engine = openEngine(() => ws, { appRoot: root });
  for (const id of ['a', 'b', 'c']) await engine.start('think', { kind: 'transaction', id }, { kind: 'manual' });
  await new Promise((r) => setTimeout(r, 50));
  const states = engine.runs().map((r) => r.state.status === 'queued' ? `queued:${r.state.reason}` : r.state.status).sort();
  assert.deepEqual(states, ['queued:ai-slot', 'running', 'running']);
  open();
  await engine.idle();
  assert.deepEqual(engine.runs().map((r) => r.state.status), ['done', 'done', 'done']);
  gate = Promise.resolve();
});

test('what came in rides with a run: a drop while the run is under way gets a run that waits behind it, later drops join that one; a finishing step keeps the files and the «Geprüft» mark', async () => {
  const root = app({ inbox: { 'workflow.yaml': 'label: T\nphase: collect\nfor: company\nsteps: [think]\n', 'think/step.yaml': 'uses: test.think\noutcomes: { ok: done }\n' } });
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const ws = demo();
  const engine = openEngine(() => ws, { appRoot: root });
  const company = { kind: 'company', id: 'inbox' } as const;
  const idOf = (r: { ok: boolean; run?: string }) => (r.ok ? r.run! : '');
  const first = idOf(await engine.start('inbox', company, { kind: 'outside', file: 'a.pdf' }, 'live', [{ kind: 'receipt', file: 'a.pdf', id: 'aaaa000000000000' }]));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(engine.run(first)!.state.status, 'running');
  assert.equal(idOf(await engine.start('inbox', company, { kind: 'manual' })), first, 'the button while it runs is that run');
  const second = idOf(await engine.start('inbox', company, { kind: 'outside', file: 'b.pdf' }, 'live', [{ kind: 'receipt', file: 'b.pdf', id: 'bbbb000000000000' }]));
  assert.notEqual(second, first, 'b.pdf came after the run read the inbox: a run of its own');
  const third = idOf(await engine.start('inbox', company, { kind: 'outside', file: 'c.docx' }, 'live', [{ kind: 'refused', file: 'c.docx', reason: 'Word' }]));
  assert.equal(third, second, 'a later drop joins the run that waits');
  await new Promise((r) => setTimeout(r, 50));
  const waiting = engine.run(second)!.state;
  assert.deepEqual(waiting.status === 'queued' && waiting.reason, 'lane', 'it waits behind the first');
  assert.deepEqual(await engine.command({ kind: 'review', run: first, on: true }), { ok: true, run: first });
  open();
  await engine.idle();
  const a = engine.run(first)!, b = engine.run(second)!;
  assert.deepEqual([a.state.status, b.state.status], ['done', 'done']);
  assert.ok(Date.parse(b.steps[0].startedAt) >= Date.parse(a.steps[0].finishedAt!), 'one after the other');
  assert.deepEqual(a.arrived?.map((x) => x.file), ['a.pdf']);
  assert.deepEqual(b.arrived?.map((x) => x.file), ['b.pdf', 'c.docx'], 'the finishing step did not drop the joined file');
  assert.ok(a.reviewed, 'nor the mark set while it ran');
  assert.deepEqual(listRuns(ws).find((r) => r.id === second)?.arrived?.length, 2, 'stored');
  await engine.command({ kind: 'review', run: first, on: false });
  assert.equal(engine.run(first)!.reviewed, undefined);
  assert.deepEqual(await engine.command({ kind: 'review', run: 'nope', on: true }), { ok: false, refusal: 'not-found' });
  gate = Promise.resolve();
});

test('a finished run emits its event, and the workflow that listens starts for the same item', async () => {
  const root = app({
    first: { 'workflow.yaml': wf(['a'], 'emits: [thing.done]\n'), 'a/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' },
    second: { 'workflow.yaml': wf(['b'], 'triggers:\n  - event: { name: thing.done }\n'), 'b/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' },
    off: { 'workflow.yaml': wf(['c'], 'triggers:\n  - event: { name: thing.done, off: true }\n'), 'c/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' },
  });
  const ws = demo();
  const engine = openEngine(() => ws, { appRoot: root });
  await engine.start('first', { kind: 'transaction', id: 'x' }, { kind: 'manual' });
  await engine.idle();
  const second = engine.runs().find((r) => r.workflow === 'second')!;
  assert.deepEqual([second.item.id, second.startedBy.kind, second.state.status], ['x', 'event', 'done']);
  assert.equal(engine.runs().some((r) => r.workflow === 'off'), false, 'a switched-off trigger starts nothing');
});

test('a call starts one child run per item and goes on when all of them are done', async () => {
  const root = app({
    parent: { 'workflow.yaml': wf(['list', 'each', 'after']), 'list/step.yaml': 'uses: test.list\nemits: [items]\noutcomes: { ok: each }\n', 'each/step.yaml': 'calls: child\nfor-each: items\nreads: [items]\noutcomes: { done: after }\n', 'after/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' },
    child: { 'workflow.yaml': wf(['c']), 'c/step.yaml': 'uses: test.ok\noutcomes: { ok: done }\n' },
  });
  const ws = demo();
  const engine = openEngine(() => ws, { appRoot: root });
  const r = await engine.start('parent', { kind: 'transaction', id: 'p' }, { kind: 'manual' });
  await engine.idle();
  const parent = engine.run(r.ok ? r.run! : '')!;
  assert.equal(parent.state.status, 'done');
  assert.deepEqual(parent.steps.map((s) => s.step), ['list', 'each', 'after']);
  assert.deepEqual(engine.runs().filter((x) => x.workflow === 'child').map((x) => x.item.id).sort(), ['a', 'b']);
});

test('a crashed run goes back into the queue at its step and books nothing twice', async () => {
  const ws = demo();
  const root = app({ book: { 'workflow.yaml': wf(['book']), 'book/step.yaml': 'uses: test.book-open\neffects: [ledger.book]\noutcomes: { booked: done }\n' } });
  const engine = openEngine(() => ws, { appRoot: root });
  const r = await engine.start('book', { kind: 'transaction', id: 'y' }, { kind: 'manual' });
  await engine.idle();
  const run = engine.run(r.ok ? r.run! : '')!;
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.run === run.id).length, 1);
  const crashed: Run = { ...run, state: { status: 'running', at: 'book', since: run.startedAt }, steps: [] };
  saveRun(ws, crashed);
  const after = openEngine(() => ws, { appRoot: root });
  await after.idle();
  assert.equal(after.run(run.id)!.state.status, 'done', 'the crashed run was picked up again');
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'y').length, 1, 'and booked nothing twice');
});

test('a dry run checks the booking through the write door: a closed period is refused, nothing is written', async () => {
  const ws = demo();
  const root = app({ book: { 'workflow.yaml': wf(['book']), 'book/step.yaml': 'uses: test.book-closed\neffects: [ledger.book]\noutcomes: { booked: done }\n' } });
  assert.ok((loadBooks(ws).config.closedThrough ?? '') >= '2026-01-15', 'the demo has closed the period of the booking');
  const before = booksOnDisk(ws);
  const engine = openEngine(() => ws, { appRoot: root });
  const r = await engine.start('book', { kind: 'transaction', id: 'x' }, { kind: 'manual' }, 'dry');
  await engine.idle();
  const effect = engine.run(r.ok ? r.run! : '')!.steps[0].effects[0];
  assert.equal(effect.applied, false);
  assert.ok(effect.refused, 'the write door refused the booking');
  assert.deepEqual(booksOnDisk(ws), before);
});
