/**
 * Änderungen, write (src/saving/saving.ts): the AI's proposal covers every changed file, a file
 * changed since makes it stale and a stale proposal is never saved, refresh keeps the saves that
 * did not move, a held save stays unsaved, a save holds its files and no books file, Rückgängig
 * of a customizing save goes back to the draft and of a run reverses its bookings in an open
 * period only, and sync pushes, refusing two diverged lines. Checked with the git program.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { draftDir } from '../src/saving/changes.js';
import { openRecordsCommitter } from '../src/saving/records.js';
import { openSaving, type Ask } from '../src/saving/saving.js';
import { loadBooks, saveBooks, update, moduleActor } from '../src/books/store.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const RULES = 'knowledge/rules/house.guide.yaml';
const STEP = 'workflows/booking/classify/step.yaml';

async function company(): Promise<{ ws: Workspace; repo: string; git: (...a: string[]) => string }> {
  const repo = mkdtempSync(join(tmpdir(), 'saving-repo-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  mkdirSync(join(repo, APP_FOLDER, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(repo, APP_FOLDER, RULES), 'rules:\n  - one\n');
  await initRepository(repo, 'Workspace set up');
  return { ws: workspaceAt(join(repo, APP_FOLDER)), repo, git: (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim() };
}

/** A model that puts each file the prompt shows into a save of its own, and holds back what the owner names. */
function fakeModel(): { ask: Ask; calls: string[] } {
  const calls: string[] = [];
  const ask: Ask = async (prompt, { step }) => {
    calls.push(step);
    const paths = [...prompt.matchAll(/^### (\S+) \(/gm)].map((m) => m[1]);
    const said = prompt.match(/The owner says: (.*)$/m)?.[1] ?? '';
    return JSON.stringify({ reply: said ? 'Gut.' : 'Vorbereitet.', saves: paths.map((p) => ({ message: `Geändert: ${p}`, why: 'Test.', files: [p], held: said.includes('noch nicht') && said.includes(p.split('/')[0]) })) });
  };
  return { ask, calls };
}

function changeBoth(ws: Workspace): void {
  writeFileSync(join(ws.paths.root, RULES), 'rules:\n  - one\n  - two\n');
  mkdirSync(join(draftDir(ws), 'workflows', 'booking', 'classify'), { recursive: true });
  writeFileSync(join(draftDir(ws), STEP), 'label: { en: Ours }\n');
}

test('a proposal covers every changed file; a file changed since makes it stale, and stale is never saved', async () => {
  const { ws, git } = await company();
  changeBoth(ws);
  const model = fakeModel();
  const saving = openSaving(ws, { ask: model.ask });
  assert.deepEqual(await saving.command({ kind: 'prepare' }), { ok: true, reply: 'Vorbereitet.' });
  let view = await saving.view();
  assert.deepEqual(view.proposal!.saves.map((s) => s.files.map((f) => `${f.source}:${f.path}`)), [[`draft:${STEP}`], [`outside:${RULES}`]]);
  assert.equal(view.proposal!.ready, true);
  writeFileSync(join(ws.paths.root, RULES), 'rules:\n  - one\n  - two\n  - three\n');
  view = await saving.view();
  assert.deepEqual([view.proposal!.ready, view.proposal!.stale.length], [false, 1]);
  const refused = await saving.command({ kind: 'save' });
  assert.equal(refused.ok ? '' : refused.refusal, 'stale');
  assert.equal(git('log', '--format=%s'), 'Workspace set up', 'nothing was committed');
  const kept = view.proposal!.saves.find((s) => !view.proposal!.stale.includes(s.id))!;
  await saving.command({ kind: 'refresh' });
  view = await saving.view();
  assert.equal(view.proposal!.ready, true);
  assert.ok(view.proposal!.saves.some((s) => s.id === kept.id && s.message === kept.message), 'the save that did not move stays as it was');
  assert.deepEqual(model.calls, ['saving#prepare', 'saving#prepare']);
});

test('a held save stays unsaved; a save commits exactly its files, never a books file', async () => {
  const { ws, git } = await company();
  changeBoth(ws);
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { b.journalEntries.push({ id: 'w1', transactionRef: 'w', date: '2026-09-20', accountDebit: '6500', accountCredit: '1020', amount: 1 }); });
  saveBooks(ws, books);
  const saving = openSaving(ws, fakeModel());
  await saving.command({ kind: 'prepare' });
  assert.deepEqual(await saving.command({ kind: 'talk', text: 'workflows noch nicht' }), { ok: true, reply: 'Gut.' });
  const result = await saving.command({ kind: 'save' });
  assert.deepEqual(result, { ok: true, saved: 1 });
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), [`vanilla-accounting/${RULES}`]);
  assert.match(git('log', '-1', '--format=%B'), /Vanilla-Kind: customizing/);
  assert.match(git('status', '--porcelain'), /entries\.jsonl/, 'the books file is left for the app to commit');
  const view = await saving.view();
  assert.deepEqual(view.proposal!.saves.map((s) => [s.files[0].path, s.held]), [[STEP, true]]);
  assert.ok(existsSync(join(draftDir(ws), STEP)), 'the held draft stays in the draft');
});

test('a saved draft file moves into the books folder; Rückgängig puts the old version back into the draft', async () => {
  const { ws, git } = await company();
  changeBoth(ws);
  const saving = openSaving(ws, fakeModel());
  await saving.command({ kind: 'prepare' });
  await saving.command({ kind: 'save' });
  assert.equal(readFileSync(join(ws.paths.root, STEP), 'utf8'), 'label: { en: Ours }\n');
  assert.equal(existsSync(join(draftDir(ws), STEP)), false);
  assert.equal((await saving.view()).proposal, undefined);
  const rulesSave = git('log', '--format=%H', '-1', '--', `vanilla-accounting/${RULES}`);
  assert.deepEqual(await saving.command({ kind: 'undo', oid: rulesSave }), { ok: true, reversed: 1 });
  assert.equal(readFileSync(join(draftDir(ws), RULES), 'utf8'), 'rules:\n  - one\n');
  assert.deepEqual((await saving.view()).draft.map((f) => f.path), [RULES]);
});

test('Rückgängig of a run reverses its bookings in an open period and refuses a closed one', async () => {
  const { ws, git } = await company();
  const book = async (id: string, date: string) => {
    const books = loadBooks(ws);
    update(books, { kind: 'run', id, workflow: 'booking' }, (b) => { b.journalEntries.push({ id: `e-${id}`, transactionRef: id, date, accountDebit: '6500', accountCredit: '1020', amount: 5, vatCode: 'I81', run: id }); });
    saveBooks(ws, books);
    await openRecordsCommitter(ws).commitRun({ id, workflow: 'booking', label: 'Buchen', item: id });
    return git('rev-parse', 'HEAD');
  };
  const open = await book('r-open', '2026-09-20');
  const saving = openSaving(ws, fakeModel());
  assert.deepEqual(await saving.command({ kind: 'undo', oid: open }), { ok: true, reversed: 1 });
  const storno = loadBooks(ws).journalEntries.find((e) => e.id === 'storno-e-r-open')!;
  assert.deepEqual([storno.accountDebit, storno.accountCredit, storno.vatCode, storno.date], ['1020', '6500', '-I81', '2026-09-20']);
  assert.equal(git('log', '-1', '--format=%s'), 'Storno: Buchungen von Lauf r-open');
  const again = await saving.command({ kind: 'undo', oid: open });
  assert.equal(again.ok ? '' : again.refusal, 'cannot-undo', 'reversed once only');

  const old = await book('r-old', '2026-05-10');
  const books = loadBooks(ws);
  books.config.closedThrough = '2026-06-30';
  saveBooks(ws, books);
  const closed = await saving.command({ kind: 'undo', oid: old });
  assert.match(closed.ok ? '' : closed.message, /2026-06-30/);
  assert.equal(closed.ok ? '' : closed.refusal, 'closed');
  assert.equal(loadBooks(ws).journalEntries.some((e) => e.id === 'storno-e-r-old'), false);
});

test('sync pushes what was saved; two diverged lines are refused as two versions', async () => {
  const { ws, repo, git } = await company();
  const remote = mkdtempSync(join(tmpdir(), 'saving-remote-'));
  execFileSync('git', ['init', '--bare', '--quiet', remote]);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('remote', 'add', 'origin', remote);
  git('push', '--quiet', '-u', 'origin', branch);
  const saving = openSaving(ws, fakeModel());
  assert.deepEqual((await saving.view()).sync, { remote: true, ahead: 0 });
  changeBoth(ws);
  await saving.command({ kind: 'prepare' });
  await saving.command({ kind: 'save' });
  assert.deepEqual((await saving.view()).sync, { remote: true, ahead: 2 });
  assert.deepEqual(await saving.command({ kind: 'sync' }), { ok: true });
  assert.deepEqual((await saving.view()).sync, { remote: true, ahead: 0 });

  const other = mkdtempSync(join(tmpdir(), 'saving-other-'));
  execFileSync('git', ['clone', '--quiet', remote, other]);
  writeFileSync(join(other, 'elsewhere.txt'), 'x');
  execFileSync('git', ['-C', other, 'add', '.']);
  execFileSync('git', ['-C', other, 'commit', '--quiet', '-m', 'Elsewhere']);
  execFileSync('git', ['-C', other, 'push', '--quiet']);
  writeFileSync(join(ws.paths.root, RULES), 'rules:\n  - here\n');
  await saving.command({ kind: 'prepare' });
  await saving.command({ kind: 'save' });
  const r = await saving.command({ kind: 'sync' });
  assert.equal(r.ok ? '' : r.refusal, 'two-versions');
  assert.equal(existsSync(join(repo, 'elsewhere.txt')), false, 'nothing merged, nothing rewritten');
});
