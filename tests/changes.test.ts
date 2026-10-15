/**
 * Änderungen read (src/saving/changes.ts, model.ts): the books wait as one item, the AI's draft and
 * files changed outside the app show with their line counts, Verlauf says whose a save was, a save
 * lists its files, and the line diff keeps every line once and in order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { changesView, draftDir, fileDiff, saveDetail } from '../src/saving/changes.js';
import { commitExactly } from '../src/workspace/git.js';
import { recordsPaths } from '../src/saving/changes.js';
import { relative } from 'node:path';
import { diffLines, hunks } from '../src/saving/model.js';
import { loadBooks, saveBooks, update, PERSON } from '../src/books/store.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

async function company(): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'changes-repo-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  mkdirSync(join(repo, APP_FOLDER, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(repo, APP_FOLDER, 'knowledge', 'rules', 'house.guide.yaml'), 'rules:\n  - one\n  - two\n');
  await initRepository(repo, 'Workspace set up');
  return workspaceAt(join(repo, APP_FOLDER));
}

test('the line diff keeps every line once, in order, and hunks cut the unchanged middle', () => {
  const d = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.map((l) => `${l.kind}${l.text}`), [' a', '-b', '+B', ' c', ' d', '+e']);
  const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const h = hunks(diffLines(long.join('\n'), [...long.slice(0, 19), 'x'].join('\n')), 2);
  assert.equal(h.filter((l) => l === null).length, 0, 'one hunk at the end, nothing before it to elide');
  assert.deepEqual(h.map((l) => l && `${l.kind}${l.text}`), [' l17', ' l18', '-l19', '+x']);
});

test('the books wait as one item, beside the AI\'s draft and an outside edit', async () => {
  const ws = await company();
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'house.guide.yaml'), 'rules:\n  - one\n  - two\n  - three\n');
  mkdirSync(join(draftDir(ws), 'workflows', 'booking', 'classify'), { recursive: true });
  writeFileSync(join(draftDir(ws), 'workflows', 'booking', 'classify', 'step.yaml'), 'label: { en: Ours }\n');
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.journalEntries.push({ id: 'x1', transactionRef: 'x', date: '2026-09-20', accountDebit: '6500', accountCredit: '1020', amount: 1, origin: 'manual' }); });
  saveBooks(ws, books);
  const view = await changesView(ws);
  assert.deepEqual(view.outside.map((f) => [f.path, f.state, f.added, f.removed]), [['knowledge/rules/house.guide.yaml', 'modified', 1, 0]]);
  assert.deepEqual(view.draft.map((f) => [f.path, f.state]), [['workflows/booking/classify/step.yaml', 'added']]);
  assert.deepEqual(view.books, { files: 1, runs: [] }, 'the books as one item: the runs that wrote are the engine\'s to name');
  assert.equal(view.outside.some((f) => f.path.includes('transactional-data') || f.path === 'ledger.json'), false);
  const diff = await fileDiff(ws, 'outside', 'knowledge/rules/house.guide.yaml');
  assert.deepEqual([diff!.before.split('\n').length, diff!.after.endsWith('three\n')], [4, true]);
});

test('Verlauf says whose a save was; a save lists the files it changed', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.journalEntries.push({ id: 'x2', transactionRef: 'y', date: '2026-09-21', accountDebit: '6500', accountCredit: '1020', amount: 2, origin: 'manual' }); });
  saveBooks(ws, books);
  await commitExactly(ws.paths.repository, 'Buchung bearbeitet\n\nVanilla-Kind: books', recordsPaths(ws).map((p) => relative(ws.paths.repository, p)));
  const view = await changesView(ws);
  assert.deepEqual(view.history.map((s) => [s.subject, s.kind]), [['Buchung bearbeitet', 'books'], ['Workspace set up', 'outside']]);
  const detail = await saveDetail(ws, view.history[0].oid);
  assert.deepEqual(detail!.files.map((f) => [f.path, f.state, f.added]), [['vanilla-accounting/transactional-data/2026/books/entries.jsonl', 'modified', 1]]);
  const first = await saveDetail(ws, view.history[1].oid);
  assert.ok(first!.files.length > 5, 'the first save lists every file it added');
});
