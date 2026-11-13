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
import { readManifest } from '../src/workspace/manifest.js';
import { parseDocument } from 'yaml';
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

test('books schema 7 (#254): books of schema 6 load and verify their seals, npm run update writes 7 with a backup and no record changed; a statement\'s question and a reconciliation survive a save; an app of schema 6 refuses books of 7', async () => {
  assert.ok(BOOKS_SCHEMA >= 7);
  const dir = mkdtempSync(join(tmpdir(), 'schema-7-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  writeFileSync(ws.paths.ledger, JSON.stringify({ ...ledger, schema: 6 }, null, 2) + '\n');
  const records = () => booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]);
  const before = records();
  assert.ok(before.length > 0);

  const loaded = loadBooks(ws);
  assert.equal(loaded.schema, BOOKS_SCHEMA);
  const seals = sealsOf(loaded).checks;
  assert.ok(seals.length > 0 && seals.every((c) => c.status !== 'broken'), 'every seal still verifies');

  const { done } = await upgradeWorkspace(ws);
  const books = done.find((d) => d.file === ws.paths.ledger);
  assert.deepEqual(books && { from: books.from, to: books.to }, { from: 6, to: BOOKS_SCHEMA });
  assert.equal(JSON.parse(readFileSync(books!.backup, 'utf8')).schema, 6);
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, BOOKS_SCHEMA);
  assert.deepEqual(records(), before, 'no record of the books changed');

  const again = loadBooks(ws);
  const open = again.transactions.find((t) => t.date > (again.config.closedThrough ?? ''))!;
  again.reconciliations = [{ account: '1021', from: open.date, to: open.date, since: '2026-10-28', covered: [{ from: open.date, to: open.date }], read: [open.ref], bank: [], pairs: [] }];
  const statement = { iban: 'CH6580808000000000001', currency: 'CHF', opening: { date: '2026-11-01', amount: 10 }, closing: { date: '2026-11-30', amount: 10 }, movements: [] };
  again.statementAsks = [{ file: 'Raiffeisen/Kontoauszug 01.11.2026 - 30.11.2026.pdf', account: '1021', date: '2026-11-30', since: '2026-12-01', read: { by: 'model', statement, check: { ok: true, gaps: [] }, known: [] } }];
  saveBooks(ws, again);
  const after = loadBooks(ws);
  assert.deepEqual(after.reconciliations, again.reconciliations);
  assert.deepEqual(after.statementAsks, again.statementAsks);
  assert.ok(booksFiles(ws.paths.transactional).some((f) => f.endsWith('2026/books/asks.jsonl')), 'kept in the year of the statement\'s last day');
  assert.ok(booksFiles(ws.paths.transactional).some((f) => f.endsWith(`${open.date.slice(0, 4)}/books/reconcile.jsonl`)), 'a reconciliation in the year of its last day');

  const clone = (d: Record<string, unknown>) => structuredClone(d);
  assert.throws(() => climb<Record<string, unknown>>({}, 7, 6, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError);
});

test('books schema 8 (#409): books of schema 7 load with their seals whole and no receipt given lines, the step adds nothing and a save writes 8 with no record changed; card lines and a line\'s link survive a save; an app of schema 7 refuses books of 8', async () => {
  assert.ok(BOOKS_SCHEMA >= 8);
  const dir = mkdtempSync(join(tmpdir(), 'schema-8-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  writeFileSync(ws.paths.ledger, JSON.stringify({ ...ledger, schema: 7 }, null, 2) + '\n');
  const before = booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]);

  const loaded = loadBooks(ws);
  assert.equal(loaded.schema, BOOKS_SCHEMA);
  assert.ok(sealsOf(loaded).checks.every((c) => c.status !== 'broken'), 'every seal still verifies');
  assert.ok(loaded.receipts.every((r) => !('cardLines' in r)) && loaded.mappings.every((m) => !('line' in m)), 'the step adds no field, not even an empty one');

  // npm run update itself is the schema 7 test's (6 → current, with its backup); here the step from 7: pure, nothing added.
  const clone = (d: Record<string, unknown>) => structuredClone(d);
  const raw = { schema: 7, receipts: [{ id: 'r' }], mappings: [{ transactionRef: 't', receiptId: 'r' }] };
  assert.deepEqual(climb<Record<string, unknown>>(raw, 7, 8, BOOKS_MIGRATIONS, 'ledger.json', clone), raw);
  saveBooks(ws, loaded);
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, BOOKS_SCHEMA);
  assert.deepEqual(booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]), before, 'no record of the books changed');

  const again = loadBooks(ws);
  const open = again.transactions.find((t) => t.date > (again.config.closedThrough ?? '') && !again.mappings.some((m) => m.transactionRef === t.ref))!;
  const card = { id: 'card-409', filename: 'card.pdf', originalFilename: 'card.pdf', extractedText: 'Kreditkartenabrechnung', extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: open.date, location: 'archived' as const, date: open.date, cardLines: [{ day: open.date, merchant: 'HOTEL', amount: 164 }] };
  const bill = { ...card, id: 'bill-409', filename: 'bill.pdf', originalFilename: 'bill.pdf', cardLines: undefined };
  delete bill.cardLines;
  again.receipts.push(card, bill);
  again.mappings.push({ transactionRef: open.ref, receiptId: card.id }, { transactionRef: open.ref, receiptId: bill.id, by: 'human', line: 0 });
  saveBooks(ws, again);
  const after = loadBooks(ws);
  assert.deepEqual(after.receipts.find((r) => r.id === card.id)?.cardLines, card.cardLines);
  assert.deepEqual(after.mappings.find((m) => m.receiptId === bill.id), { transactionRef: open.ref, receiptId: bill.id, by: 'human', line: 0 });

  assert.throws(() => climb<Record<string, unknown>>({}, 8, 7, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError);
});

test('books schema 9 (#450): books of schema 8 load with their seals whole and no receipt given a count, the step adds nothing and a second run changes nothing, a save writes 9 with no record changed; a count survives a save; an app of schema 8 refuses books of 9', () => {
  assert.equal(BOOKS_SCHEMA, 9);
  const dir = mkdtempSync(join(tmpdir(), 'schema-9-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  writeFileSync(ws.paths.ledger, JSON.stringify({ ...ledger, schema: 8 }, null, 2) + '\n');
  const before = booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]);

  const loaded = loadBooks(ws);
  assert.equal(loaded.schema, 9);
  assert.ok(sealsOf(loaded).checks.every((c) => c.status !== 'broken'), 'every seal still verifies');
  assert.ok(loaded.receipts.every((r) => !('vatReadFailures' in r)), 'the step adds no count, not even 0');

  const clone = (d: Record<string, unknown>) => structuredClone(d);
  const raw = { schema: 8, receipts: [{ id: 'r', extractedText: 'Total 80.00' }] };
  const once = climb<Record<string, unknown>>(raw, 8, 9, BOOKS_MIGRATIONS, 'ledger.json', clone);
  assert.deepEqual(once, raw, 'old in, the same records out');
  assert.deepEqual(climb<Record<string, unknown>>(once, 8, 9, BOOKS_MIGRATIONS, 'ledger.json', clone), once, 'a second run changes nothing');
  saveBooks(ws, loaded);
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, 9);
  assert.deepEqual(booksFiles(ws.paths.transactional).map((f) => [f, readFileSync(f, 'utf8')]), before, 'no record of the books changed');

  const again = loadBooks(ws);
  const open = again.receipts.find((r) => !!r.date && r.date > (again.config.closedThrough ?? ''))!;
  open.vatReadFailures = 2;
  saveBooks(ws, again);
  assert.equal(loadBooks(ws).receipts.find((r) => r.id === open.id)?.vatReadFailures, 2);

  assert.throws(() => climb<Record<string, unknown>>({}, 9, 8, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError);
});

test('manifest schema 4 (#452): a manifest of schema 3 loads with its UID, npm run update writes 4 and changes nothing else; one of 4 without a UID loads; an app of schema 3 refuses a manifest of 4', async () => {
  assert.equal(WORKSPACE_SCHEMA, 4);
  const dir = mkdtempSync(join(tmpdir(), 'manifest-4-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const path = workspaceAt(dir).paths.manifest;
  const current = readFileSync(path, 'utf8');
  assert.match(current, /^schema: 4\n/m);
  const old = current.replace(/^schema: 4\n/m, 'schema: 3\n');
  writeFileSync(path, old);

  assert.equal(readManifest(path).company.uid, 'CHE-123.456.789');
  const ws = workspaceAt(dir);
  const { done } = await upgradeWorkspace(ws);
  const step = done.find((d) => d.file === path);
  assert.deepEqual(step && { from: step.from, to: step.to }, { from: 3, to: 4 });
  assert.equal(readFileSync(step!.backup, 'utf8'), old);
  assert.equal(readFileSync(path, 'utf8'), current, 'only the number changed');

  writeFileSync(path, current.replace(/^ {2}uid: .*\n/m, ''));
  assert.doesNotMatch(readFileSync(path, 'utf8'), /uid:/);
  const loaded = readManifest(path);
  assert.equal(loaded.company.uid, undefined);
  assert.equal(loaded.company.name.length > 0, true);

  assert.throws(() => climb(parseDocument(current), 4, 3, MANIFEST_MIGRATIONS, path, (d) => d.clone()), (e: Error) => e instanceof SchemaTooNewError);
});

function booksFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /books\/.*\.jsonl$/.test(f)).map((f) => join(dir, f)).sort();
}
