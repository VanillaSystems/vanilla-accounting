/**
 * src/books/history.ts: every saveBooks is a git commit of books.json by the writer, history()
 * reads it back as record changes, and a workspace that is not a git repository saves without one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, mutateJournal, saveBooks } from '../src/books/store.js';
import { git, history, repoOf, setWriter } from '../src/books/history.js';
import { DEMO_ROOTS, tempWorkspace } from './support/workspace.js';

const DEMO = DEMO_ROOTS.find((r) => r.endsWith('demo-consulting'))!;

function repoWorkspace() {
  const ws = tempWorkspace('history-', DEMO);
  copyFileSync(join(DEMO, 'books.json'), ws.paths.books);
  writeFileSync(join(ws.paths.root, '.gitignore'), 'data/\n');
  git(ws.paths.root, ['init', '-q', '-b', 'main']);
  git(ws.paths.root, ['add', '-A']);
  git(ws.paths.root, ['-c', 'user.name=Owner', '-c', 'user.email=', 'commit', '-q', '-m', 'start']);
  return ws;
}

test('saveBooks commits books.json as the writer, with the action as message; no change, no commit', () => {
  const ws = repoWorkspace();
  writeFileSync(join(ws.paths.root, 'notes.txt'), 'not part of the books');
  const books = loadBooks(ws);
  mutateJournal(books, (b) => { b.journalEntries.find((e) => e.date > '2026-04-01')!.description = 'neu'; });
  setWriter({ name: 'Anna Muster', email: 'anna@example.ch' });
  try {
    saveBooks(ws, books, 'test: Beschreibung');
  } finally {
    setWriter(undefined);
  }
  assert.equal(git(ws.paths.root, ['log', '-1', '--format=%an <%ae>|%s']).trim(), 'Anna Muster <anna@example.ch>|test: Beschreibung');
  assert.match(git(ws.paths.root, ['status', '--porcelain']), /\?\? notes.txt/, 'only books.json is committed');
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  saveBooks(ws, loadBooks(ws), 'test: unchanged');
  assert.equal(git(ws.paths.root, ['rev-parse', 'HEAD']).trim(), head);

  const [last] = history(ws, { limit: 1 });
  assert.equal(last.author.name, 'Anna Muster');
  assert.equal(last.changes.length, 1);
  assert.equal(last.changes[0].collection, 'entries');
  assert.equal((last.changes[0].after as { description: string }).description, 'neu');
  assert.ok(existsSync(join(ws.paths.data, 'log', `${last.hash}.json`)), 'cached per commit');
  assert.deepEqual(history(ws, { limit: 1 })[0].changes, last.changes);
});

test('a workspace that is not the top of a git repository saves without a commit', () => {
  const ws = tempWorkspace('history-nogit-', DEMO);
  copyFileSync(join(DEMO, 'books.json'), ws.paths.books);
  assert.equal(repoOf(ws), undefined);
  saveBooks(ws, loadBooks(ws), 'test');
  assert.deepEqual(history(ws), []);
  assert.equal(repoOf({ ...ws, paths: { ...ws.paths, root: DEMO } }), undefined, 'a demo inside the app repo is never committed');
});
