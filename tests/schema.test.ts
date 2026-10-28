/**
 * The schema of the books (ledger.json) and of the manifest (src/workspace/schema.ts): old files read,
 * newer ones are refused, and the ladder runs forward, pure and once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, saveBooks, sealsOf } from '../src/books/store.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, MANIFEST_MIGRATIONS, SchemaTooNewError, WORKSPACE_SCHEMA, climb, type Ladder } from '../src/workspace/schema.js';
import { upgradeWorkspace } from '../src/workspace/upgrade.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT, tempWorkspace, writeIndex } from './support/workspace.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');

test('a ledger without schema reads as schema 1, and the next save stamps the current one first', () => {
  const ws = tempWorkspace('schema-');
  writeIndex(ws, JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const { config } = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  writeFileSync(ws.paths.ledger, JSON.stringify({ config }));
  const books = loadBooks(ws);
  assert.equal(books.schema, BOOKS_SCHEMA);
  saveBooks(ws, books);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(ws.paths.ledger, 'utf8'))), ['schema', 'config']);
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, BOOKS_SCHEMA);
});

test('books of a newer schema are refused with what to do', () => {
  const ws = tempWorkspace('schema-');
  writeFileSync(ws.paths.ledger, JSON.stringify({ schema: BOOKS_SCHEMA + 1, config: {} }));
  assert.throws(() => loadBooks(ws), new RegExp(`schema ${BOOKS_SCHEMA + 1}; this version of the app reads up to ${BOOKS_SCHEMA}\\. Update the app: npm run update`));
});

test('a manifest without schema reads as schema 1', () => {
  const ws = tempWorkspace('schema-');
  writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^schema: \d+\n/m, ''));
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

test('books schema 6 (#218): books of schema 5 load and verify their seals, npm run update writes 6 with a backup and no record changed; a receipt\'s handSet survives a save; an app of schema 5 refuses books of 6', async () => {
  assert.equal(BOOKS_SCHEMA, 6);
  const dir = mkdtempSync(join(tmpdir(), 'schema-6-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  writeFileSync(ws.paths.ledger, JSON.stringify({ ...ledger, schema: 5 }, null, 2) + '\n');
  const records = () => booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]);
  const before = records();
  assert.ok(before.length > 0);

  const loaded = loadBooks(ws);
  assert.equal(loaded.schema, 6);
  const seals = sealsOf(loaded).checks;
  assert.ok(seals.length > 0 && seals.every((c) => c.status !== 'broken'), 'every seal still verifies');

  const { done } = await upgradeWorkspace(ws);
  const books = done.find((d) => d.file === ws.paths.ledger);
  assert.deepEqual(books && { from: books.from, to: books.to }, { from: 5, to: 6 });
  assert.equal(JSON.parse(readFileSync(books!.backup, 'utf8')).schema, 5);
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, 6);
  assert.deepEqual(records(), before, 'no record of the books changed');

  const again = loadBooks(ws);
  const staged = again.receipts.find((r) => r.date && r.date > (again.config.closedThrough ?? ''))!;
  staged.handSet = ['amount', 'date'];
  saveBooks(ws, again);
  assert.deepEqual(loadBooks(ws).receipts.find((r) => r.id === staged.id)?.handSet, ['amount', 'date']);

  const clone = (d: Record<string, unknown>) => structuredClone(d);
  assert.throws(() => climb<Record<string, unknown>>({}, 6, 5, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError);
});

function booksFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /books\/.*\.jsonl$/.test(f)).map((f) => join(dir, f)).sort();
}
