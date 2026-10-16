/**
 * Runs write, they do not save (the mockup's screen 7; src/workflows/runlog.ts): a run that wrote
 * leaves its booking and its run-log line uncommitted, waiting in Änderungen as the books; a run
 * that changed nothing and needed nobody leaves neither a line nor a change; a waiting run leaves
 * its line; a direct edit waits the same way. Checked with the git program as an independent reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, saveBooks, update, PERSON } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { changesView } from '../src/saving/changes.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { openEngine } from '../src/workflows/engine.js';
import { readLog } from '../src/workflows/runlog.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'records-runs-'));
process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

ACTIONS['rc.book'] = {
  outcomes: ['booked'], effects: ['ledger.book'],
  run: (_i, fx) => { fx['ledger.book']!([{ id: 'rc1', transactionRef: 'rc', date: '2026-09-20', accountDebit: '6500', accountCredit: '1020', amount: 7 } as JournalEntry]); return { outcome: 'booked' }; },
};
ACTIONS['rc.noop'] = { outcomes: ['ok'], effects: [], run: () => ({ outcome: 'ok' }) };

/** The demo's books in a company repository: vanilla-accounting/ under a git root. */
async function company(): Promise<{ ws: Workspace; git: (...a: string[]) => string }> {
  const repo = mkdtempSync(join(tmpdir(), 'records-repo-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  await initRepository(repo, 'Workspace set up');
  return { ws: workspaceAt(join(repo, APP_FOLDER)), git: (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim() };
}

function app(): string {
  const root = mkdtempSync(join(tmpdir(), 'records-app-'));
  const wf = (id: string, steps: Record<string, string>) => {
    mkdirSync(join(root, 'workflows', id), { recursive: true });
    writeFileSync(join(root, 'workflows', id, 'workflow.yaml'), `label: { en: ${id}, de: ${id} }\nphase: book\nfor: transaction\nsteps: [${Object.keys(steps).join(', ')}]\n`);
    for (const [s, yaml] of Object.entries(steps)) { mkdirSync(join(root, 'workflows', id, s)); writeFileSync(join(root, 'workflows', id, s, 'step.yaml'), yaml); }
  };
  wf('booker', { book: 'uses: rc.book\neffects: [ledger.book]\noutcomes: { booked: done }\n' });
  wf('quiet', { look: 'uses: rc.noop\noutcomes: { ok: done }\n' });
  wf('asker', { ask: 'by: person\ntask: { title: Look }\noutcomes: { done: done }\n' });
  return root;
}

async function engineFor(ws: Workspace) {
  const engine = openEngine(ws, { appRoot: app() });
  return { engine, settle: () => engine.idle() };
}

test('a run writes its booking and its run-log line and does not save: both wait in Änderungen as the books', async () => {
  const { ws, git } = await company();
  writeFileSync(join(ws.paths.repository, 'notes.md'), 'not part of the books');
  const { engine, settle } = await engineFor(ws);
  const r = await engine.start('booker', { kind: 'transaction', id: 'rc' }, { kind: 'manual' });
  await settle();
  const id = r.ok ? r.run! : '';
  assert.equal(git('log', '--format=%s'), 'Workspace set up', 'no commit of its own');
  assert.deepEqual(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), [
    'M vanilla-accounting/transactional-data/2026/books/entries.jsonl', '?? notes.md', '?? vanilla-accounting/transactional-data/2026/runs.jsonl',
  ].sort());
  assert.equal((await changesView(ws)).books.files, 2, 'the books wait to be saved');
  const [line] = readLog(ws);
  assert.deepEqual([line.run, line.event, line.wrote?.entries], [id, 'done', ['rc1']]);
  assert.equal(loadBooks(ws).journalEntries.find((e) => e.id === 'rc1')?.run, id);
});

test('a run that changed nothing and needed nobody leaves no line and nothing to save', async () => {
  const { ws, git } = await company();
  const { engine, settle } = await engineFor(ws);
  await engine.start('quiet', { kind: 'transaction', id: 'q' }, { kind: 'manual' });
  await settle();
  assert.equal(git('log', '--format=%s'), 'Workspace set up');
  assert.deepEqual(readLog(ws), []);
  assert.equal(existsSync(yearPaths(ws.paths, '2026').runLog), false);
  assert.equal((await changesView(ws)).books.files, 0);
});

test('a run that waits for a person leaves its line; its answer leaves the closing line', async () => {
  const { ws, git } = await company();
  const { engine, settle } = await engineFor(ws);
  const r = await engine.start('asker', { kind: 'transaction', id: 'a' }, { kind: 'manual' });
  await settle();
  assert.deepEqual(readLog(ws).map((l) => [l.event, l.step]), [['waiting', 'ask']]);
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'done' });
  await settle();
  assert.deepEqual(readLog(ws).map((l) => l.event), ['waiting', 'done']);
  assert.equal(git('log', '--format=%s'), 'Workspace set up', 'nothing saved without the person');
  assert.equal(readFileSync(yearPaths(ws.paths, '2026').runLog, 'utf8').split('\n').filter(Boolean).length, 2, 'lines are appended, never rewritten');
});

test('a direct edit waits too', async () => {
  const { ws, git } = await company();
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.journalEntries.push({ id: 'p1', transactionRef: 'p', date: '2026-09-21', accountDebit: '6500', accountCredit: '1020', amount: 3, origin: 'manual' }); });
  saveBooks(ws, books);
  assert.equal(git('log', '--format=%s'), 'Workspace set up');
  assert.deepEqual(await changesView(ws).then((v) => v.books), { files: 1, runs: [], hand: [], receipts: [], records: [] });
});
