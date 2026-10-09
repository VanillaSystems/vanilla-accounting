/**
 * The schema of books.json and of the manifest (src/workspace/schema.ts): old files read,
 * newer ones are refused, and the ladder runs forward, pure and once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, type Ladder } from '../src/workspace/schema.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');

test('books from before the schema read as schema 1, and the next save stamps it first', () => {
  const ws = tempWorkspace('schema-');
  copyFileSync(FIXTURE, ws.paths.books);
  assert.equal(JSON.parse(readFileSync(ws.paths.books, 'utf8')).schema, undefined);
  const books = loadBooks(ws);
  assert.equal(books.schema, BOOKS_SCHEMA);
  saveBooks(ws, books);
  assert.equal(Object.keys(JSON.parse(readFileSync(ws.paths.books, 'utf8')))[0], 'schema');
});

test('books of a newer schema are refused with what to do', () => {
  const ws = tempWorkspace('schema-');
  writeFileSync(ws.paths.books, JSON.stringify({ schema: BOOKS_SCHEMA + 1, receipts: [], transactions: [], mappings: [], bankStatements: [] }));
  assert.throws(() => loadBooks(ws), new RegExp(`schema ${BOOKS_SCHEMA + 1}; this version of the app reads up to ${BOOKS_SCHEMA}\\. Update the app: npm run update`));
});

test('a manifest without schema reads as schema 1', () => {
  const ws = tempWorkspace('schema-');
  writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^schema: 1\n/m, ''));
  assert.doesNotMatch(readFileSync(ws.paths.manifest, 'utf8'), /^schema:/m);
  assert.equal(workspaceAt(ws.paths.root).bankAccounts.length > 0, true);
});

test('every schema below the current one has its step', () => {
  for (const [name, ladder, current] of [['books', BOOKS_MIGRATIONS, BOOKS_SCHEMA], ['manifest', MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA]] as const) {
    for (let n = 1; n < current; n++) assert.equal(typeof (ladder as Ladder<unknown>)[n], 'function', `${name} step ${n} → ${n + 1}`);
  }
});

// A ladder of the shape a real one takes: an old file, the expected file, and every step once.
type Doc = Record<string, unknown>;
const ladder: Ladder<Doc> = {
  1: ({ entries, ...rest }) => ({ ...rest, journalEntries: entries }),
  2: (doc) => ({ ...doc, config: { ...(doc.config as Doc), currency: 'CHF' } }),
};
const clone = (d: Doc) => structuredClone(d);

test('climb: an old file reaches the expected one, pure, and a second run changes nothing', () => {
  const old = { entries: [{ id: 'a' }], config: {} };
  const expected = { journalEntries: [{ id: 'a' }], config: { currency: 'CHF' } };
  const once = climb(old, 1, 3, ladder, 'books.json', clone);
  assert.deepEqual(once, expected);
  assert.deepEqual(old, { entries: [{ id: 'a' }], config: {} }, 'the input is not changed');
  assert.equal(climb(once, 3, 3, ladder, 'books.json', clone), once, 'at the current schema nothing runs');
  assert.deepEqual(climb(climb(old, 1, 2, ladder, 'books.json', clone), 2, 3, ladder, 'books.json', clone), expected, 'a run cut in two ends the same');
});

test('climb refuses a gap in the ladder and a newer file', () => {
  assert.throws(() => climb({}, 1, 4, ladder, 'books.json', clone), /no migration from schema 3 to 4/);
  assert.throws(() => climb({}, 4, 3, ladder, 'books.json', clone), /schema 4; this version of the app reads up to 3/);
});
