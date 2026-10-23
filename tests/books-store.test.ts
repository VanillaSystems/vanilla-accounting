/**
 * src/books/store.ts owns the books' files (ADR 0013) and golden rule 1 (AGENTS.md). Runs against temp
 * copies of tests/fixtures/period-lock-index.json (closedThrough 2026-06-30: C1/jc closed,
 * O1/jo open, M2026-001 a closed manual transaction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DuplicateFileError, findFile, yearPaths, yearsOf, type Workspace } from '../src/workspace/workspace.js';
import { BOOKS_SCHEMA } from '../src/workspace/schema.js';
import { booksOnDisk, tempWorkspace, writeIndex } from './support/workspace.js';
import { BeforeBooksError, ClosedPeriodError, loadBooks, moduleActor, OldLayoutError, OwnershipError, PERSON, periodLock, saveBooks, StaleBooksError, update, type Actor, type Books } from '../src/books/store.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');

function root(content?: string): Workspace {
  const ws = tempWorkspace('books-store-');
  writeIndex(ws, JSON.parse(content ?? readFileSync(FIXTURE, 'utf8')));
  return ws;
}

const fixtureBooks = (): Books => loadBooks(root());

test('saveBooks writes ledger.json and each year\'s books/*.jsonl, one record per line sorted by id, with no temp file left', () => {
  const dir = root();
  const before = booksOnDisk(dir);
  assert.deepEqual(Object.keys(before), ['ledger.json', '2026/entries.jsonl', '2026/mappings.jsonl', '2026/receipts.jsonl', '2026/transactions.jsonl']);
  const ids = before['2026/entries.jsonl'].trimEnd().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(JSON.parse(before['ledger.json']), { schema: BOOKS_SCHEMA, config: JSON.parse(readFileSync(FIXTURE, 'utf8')).config });
  saveBooks(dir, loadBooks(dir));
  assert.deepEqual(booksOnDisk(dir), before, 'load + save is a fixed point');
  assert.deepEqual(readdirSync(dir.paths.root).sort(), ['belege.workspace.yaml', 'ledger.json', 'transactional-data']);
});

test('loadBooks reads every year, and saveBooks writes a record into the year of its date', () => {
  const dir = root(JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [] }));
  const books = loadBooks(dir);
  assert.deepEqual([books.journalEntries.length, books.config], [0, {}]);
  books.journalEntries.push({ id: 'n', transactionRef: 'x', date: '2027-01-03', accountDebit: '6500', accountCredit: '1021', amount: 1 });
  saveBooks(dir, books);
  assert.deepEqual(yearsOf(dir.paths), ['2027']);
  assert.equal(loadBooks(dir).journalEntries[0].id, 'n');
});

test('loadBooks throws when there are no books, and names npm run update for books.json of 0.3', () => {
  assert.throws(() => loadBooks(tempWorkspace('books-store-')), /npm run init/);
  const old = tempWorkspace('books-store-');
  writeFileSync(join(old.paths.root, 'books.json'), '{}');
  assert.throws(() => loadBooks(old), OldLayoutError);
});

test('a closed year\'s files are never written: a change to one is refused before anything is saved', () => {
  const dir = root(JSON.stringify({
    receipts: [{ id: 'r25', filename: 'a.pdf', originalFilename: 'a.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2025-12-01T00:00:00Z', location: 'archived', date: '2025-12-01' }],
    transactions: [], mappings: [], bankStatements: [], config: { closedThrough: '2025-12-31' },
  }));
  const books = loadBooks(dir);
  const before = booksOnDisk(dir);
  books.receipts[0].remarks = 'later';
  assert.throws(() => saveBooks(dir, books), /2025 ist abgeschlossen/);
  assert.deepEqual(booksOnDisk(dir), before);
});

test('a new receipt dated in a closed year goes to the earliest open year', () => {
  const dir = root(JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [], config: { closedThrough: '2025-12-31' } }));
  const books = loadBooks(dir);
  books.receipts.push({ id: 'late', filename: 'late.pdf', originalFilename: 'late.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-01-10T00:00:00Z', location: 'archived', date: '2025-12-20' });
  saveBooks(dir, books);
  assert.match(booksOnDisk(dir)['2026/receipts.jsonl'], /"late"/);
});

test('an unbooked receipt dated before the books begin lies in their first year', () => {
  const dir = root(JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [], config: { openingBalances: { 2026: { 1020: 100 } } } }));
  const books = loadBooks(dir);
  books.receipts.push({ id: 'old', filename: 'old.pdf', originalFilename: 'old.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-02-01T00:00:00Z', location: 'archived', date: '2024-11-03' });
  saveBooks(dir, books);
  assert.deepEqual(yearsOf(dir.paths), ['2026']);
});

test('the write door refuses an entry dated before the books begin, and lets one there stay and be moved in (#39)', () => {
  const opened = (): Books => ({ ...fixtureBooks(), config: { openingBalances: { 2026: { 1020: 100 } } } });
  const early = { id: 'early', transactionRef: 'O1', date: '2025-12-27', accountDebit: '1093', accountCredit: '3200', amount: 5 };
  for (const actor of ACTORS) {
    assert.throws(() => update(opened(), actor, (b) => { b.journalEntries.push({ ...early }); }), BeforeBooksError);
    assert.throws(() => update(opened(), actor, (b) => { b.journalEntries.find((e) => e.id === 'jo')!.date = '2025-12-31'; }), /Die Bücher beginnen am 2026-01-01/);
  }
  const legacy = opened();
  legacy.journalEntries.push({ ...early });
  assert.doesNotThrow(() => update(legacy, PERSON, (b) => { b.journalEntries.find((e) => e.id === 'early')!.description = 'alt'; }));
  assert.doesNotThrow(() => update(legacy, PERSON, (b) => { b.journalEntries.find((e) => e.id === 'early')!.date = '2026-01-02'; }));
  assert.doesNotThrow(() => update({ ...fixtureBooks(), config: {} }, PERSON, (b) => { b.config.openingBalances = { 2026: {} }; b.transactions.push({ ref: 'N', bank: 'Wise', date: '2025-12-30', amount: 1, currency: 'CHF', direction: 'DBIT', description: '' }); }), 'opening balances set beside an earlier payment change no entry');
});

test('a receipt\'s file moves to the year of the entry that first books it, open years only, on save and on load', () => {
  const dir = root(JSON.stringify({
    receipts: [{ id: 'dec', filename: 'dec.pdf', originalFilename: 'dec.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-12-28T00:00:00Z', location: 'archived', date: '2026-12-28' }],
    transactions: [], mappings: [], bankStatements: [],
  }));
  const in2026 = join(yearPaths(dir.paths, '2026').receipts, 'dec.pdf');
  mkdirSync(dirname(in2026), { recursive: true });
  writeFileSync(in2026, 'pdf');
  const books = loadBooks(dir);
  books.transactions.push({ ref: 'jan', bank: 'manual', date: '2027-01-04', amount: 5, currency: 'CHF', direction: 'DBIT', description: 'paid in January' });
  books.journalEntries.push({ id: 'e', transactionRef: 'jan', date: '2027-01-04', accountDebit: '6500', accountCredit: '1021', amount: 5 });
  books.mappings.push({ transactionRef: 'jan', receiptId: 'dec' });
  saveBooks(dir, books);
  assert.equal(findFile(dir.paths, 'receipts', 'dec.pdf'), join(yearPaths(dir.paths, '2027').receipts, 'dec.pdf'));
  assert.match(booksOnDisk(dir)['2027/receipts.jsonl'], /"dec"/);

  // A move a crash left undone: the next load finishes it.
  renameSync(join(yearPaths(dir.paths, '2027').receipts, 'dec.pdf'), in2026);
  loadBooks(dir);
  assert.equal(findFile(dir.paths, 'receipts', 'dec.pdf'), join(yearPaths(dir.paths, '2027').receipts, 'dec.pdf'));
});

test('a file name in two year folders is refused, not resolved to the first', () => {
  const dir = root();
  for (const y of ['2025', '2026']) {
    mkdirSync(yearPaths(dir.paths, y).receipts, { recursive: true });
    writeFileSync(join(yearPaths(dir.paths, y).receipts, 'same.pdf'), y);
  }
  assert.throws(() => findFile(dir.paths, 'receipts', 'same.pdf'), DuplicateFileError);
});

test('periodLock: the closedThrough day itself is closed, the day after is open', () => {
  const lock = periodLock(fixtureBooks());
  assert.equal(lock.closedThrough, '2026-06-30');
  assert.equal(lock.isClosed('2026-06-30'), true);
  assert.equal(lock.isClosed('2026-01-01'), true);
  assert.equal(lock.isClosed('2026-07-01'), false);
  assert.equal(lock.isClosed(undefined), false);
  assert.throws(() => lock.assertOpen('2026-06-30', 'Nein.'), (e) => e instanceof ClosedPeriodError && /Periode geschlossen bis 2026-06-30\. Nein\./.test(e.message));
  assert.doesNotThrow(() => lock.assertOpen('2026-07-01', 'Ja.'));
});

test('periodLock without closedThrough closes nothing', () => {
  const lock = periodLock({ config: {} });
  assert.equal(lock.isClosed('2000-01-01'), false);
});

const closedChanges: Array<[string, (b: Books) => void]> = [
  ['edit a closed entry', (b) => { b.journalEntries.find((e) => e.id === 'jc')!.amount = 11; }],
  ['delete a closed entry', (b) => { b.journalEntries = b.journalEntries.filter((e) => e.id !== 'jc'); }],
  ['move a closed entry into the open period', (b) => { b.journalEntries.find((e) => e.id === 'jc')!.date = '2026-07-01'; }],
  ['add an entry dated in the closed period', (b) => { b.journalEntries.push({ id: 'new', transactionRef: 'O1', date: '2026-06-30', accountDebit: '6500', accountCredit: '1021', amount: 1 }); }],
  ['add a mapping to a closed transaction', (b) => { b.mappings.push({ transactionRef: 'C1', receiptId: 'ro' }); }],
  ['remove a mapping to a closed transaction', (b) => { b.mappings = b.mappings.filter((m) => m.transactionRef !== 'C1'); }],
  ['add a mapping to a closed manual transaction', (b) => { b.mappings.push({ transactionRef: 'M2026-001', receiptId: 'rm' }); }],
  ['edit a closed transaction', (b) => { b.transactions.find((t) => t.ref === 'C1')!.description = 'x'; }],
  ['delete a closed transaction', (b) => { b.transactions = b.transactions.filter((t) => t.ref !== 'M2026-001'); }],
  ['add a closed transaction', (b) => { b.transactions.push({ ref: 'C9', bank: 'Raiffeisen', date: '2026-03-01', amount: 1, currency: 'CHF', direction: 'DBIT', description: 'x' }); }],
  ['move closedThrough back over days with no records', (b) => { b.config.closedThrough = '2026-06-15'; }],
  ['move closedThrough on (closing a quarter is not a journal mutation)', (b) => { b.config.closedThrough = '2026-07-15'; }],
];

const ACTORS: Actor[] = [PERSON, moduleActor('intake'), { kind: 'run', id: 'r1', workflow: 'booking' }];

for (const [name, change] of closedChanges) {
  for (const actor of ACTORS) {
    test(`update as ${actor.kind} throws: ${name}`, () => {
      assert.throws(() => update(fixtureBooks(), actor, change), ClosedPeriodError);
    });
  }
}

const persons = (b: Books) => { b.journalEntries.push({ id: 'pm', transactionRef: 'O1', date: '2026-07-02', accountDebit: '6500', accountCredit: '1021', amount: 5, origin: 'manual' }); return b; };
const ownChanges: Array<[string, (b: Books) => void]> = [
  ['edit a person\'s entry', (b) => { b.journalEntries.find((e) => e.id === 'pm')!.amount = 6; }],
  ['delete a person\'s entry', (b) => { b.journalEntries = b.journalEntries.filter((e) => e.id !== 'pm'); }],
];

for (const [name, change] of ownChanges) {
  test(`only a person may ${name}`, () => {
    assert.doesNotThrow(() => update(persons(fixtureBooks()), PERSON, change));
    assert.throws(() => update(persons(fixtureBooks()), moduleActor('intake'), change), OwnershipError);
    assert.throws(() => update(persons(fixtureBooks()), { kind: 'run', id: 'r1', workflow: 'booking' }, change), /Lauf r1 \(booking\)/);
  });
}

test('a module may add entries beside a person\'s and change its own and unowned ones', () => {
  assert.doesNotThrow(() => update(persons(fixtureBooks()), moduleActor('intake'), (b) => {
    b.journalEntries.find((e) => e.id === 'jo')!.amount = 22;
    b.journalEntries.push({ id: 'cl', transactionRef: 'O1', date: '2026-07-03', accountDebit: '6500', accountCredit: '1021', amount: 1, origin: 'classify' });
  }));
});

test('update throws after an async mutation', async () => {
  await assert.rejects(update(fixtureBooks(), PERSON, async (b) => { b.journalEntries.find((e) => e.id === 'jc')!.amount = 11; }), ClosedPeriodError);
});

test('update guards a saveBooks inside it: nothing reaches the disk', () => {
  const dir = root();
  const books = loadBooks(dir);
  const before = booksOnDisk(dir);
  assert.throws(() => update(books, PERSON, (b) => {
    b.mappings.push({ transactionRef: 'C1', receiptId: 'ro' });
    saveBooks(dir, b);
  }), ClosedPeriodError);
  assert.deepEqual(booksOnDisk(dir), before);
});

test('update passes open-period changes and a reorder, and returns fn’s result', () => {
  const books = fixtureBooks();
  const result = update(books, PERSON, (b) => {
    b.journalEntries.find((e) => e.id === 'jo')!.amount = 21;
    b.journalEntries.push({ id: 'n', transactionRef: 'O1', date: '2026-07-01', accountDebit: '6500', accountCredit: '1021', amount: 1, corrects: '2026-Q2' });
    b.mappings.push({ transactionRef: 'O1', receiptId: 'rc' });
    b.mappings = b.mappings.filter((m) => m.transactionRef !== 'M2026-002');
    b.transactions.find((t) => t.ref === 'O1')!.remarks = 'ok';
    b.journalEntries.reverse();
    b.receipts[0].description = 'receipts are not journal';
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(books.journalEntries.length, 3);
});

const entry = (id: string, amount = 1) => ({ id, transactionRef: 'O1', date: '2026-07-01', accountDebit: '6500', accountCredit: '1021', amount });

test('a save over books another process saved since the load is refused, and the other\'s edit survives (#123)', () => {
  const dir = root();
  const first = loadBooks(dir);
  const second = loadBooks(dir);
  first.journalEntries.push(entry('first'));
  saveBooks(dir, first);
  const saved = booksOnDisk(dir);
  second.journalEntries.push(entry('second'));
  assert.throws(() => saveBooks(dir, second), StaleBooksError);
  assert.deepEqual(booksOnDisk(dir), saved, 'nothing written');
  assert.deepEqual(loadBooks(dir).journalEntries.map((e) => e.id).sort(), ['first', 'jc', 'jo']);
});

test('a stale save writes none of its files, though only one of them changed underneath it', () => {
  const dir = root();
  const other = loadBooks(dir);
  const books = loadBooks(dir);
  other.receipts[0].remarks = 'other';
  saveBooks(dir, other);
  const saved = booksOnDisk(dir);
  books.journalEntries.push(entry('mine'));
  books.receipts[1].remarks = 'mine';
  assert.throws(() => saveBooks(dir, books), StaleBooksError);
  assert.deepEqual(booksOnDisk(dir), saved);
});

test('a save is refused when ledger.json changed since the load, though the save leaves it as it is', () => {
  const dir = root();
  const books = loadBooks(dir);
  const ledger = JSON.parse(readFileSync(dir.paths.ledger, 'utf8'));
  writeFileSync(dir.paths.ledger, JSON.stringify({ ...ledger, config: { ...ledger.config, closedThrough: '2026-09-30' } }, null, 2) + '\n');
  const saved = booksOnDisk(dir);
  books.journalEntries.push(entry('mine'));
  assert.throws(() => saveBooks(dir, books), StaleBooksError);
  assert.deepEqual(booksOnDisk(dir), saved);
});

test('a save is refused when a file it would create was created by another process meanwhile', () => {
  const dir = root(JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [] }));
  const other = loadBooks(dir);
  const books = loadBooks(dir);
  other.journalEntries.push({ ...entry('other'), date: '2027-01-03' });
  saveBooks(dir, other);
  books.journalEntries.push({ ...entry('mine'), date: '2027-01-04' });
  assert.throws(() => saveBooks(dir, books), StaleBooksError);
  assert.deepEqual(loadBooks(dir).journalEntries.map((e) => e.id), ['other']);
});

test('one process saves the same books again and again, and edits to other files of another process survive', () => {
  const dir = root();
  const books = loadBooks(dir);
  for (const id of ['a', 'b', 'c']) {
    books.journalEntries.push(entry(id));
    saveBooks(dir, books);
  }
  const other = loadBooks(dir);
  other.receipts[0].remarks = 'other';
  saveBooks(dir, other);
  books.journalEntries.push(entry('d'));
  saveBooks(dir, books);
  const now = loadBooks(dir);
  assert.deepEqual(now.journalEntries.map((e) => e.id).sort(), ['a', 'b', 'c', 'd', 'jc', 'jo']);
  assert.equal(now.receipts[0].remarks, 'other');
});

test('the server runs a change once more on books loaded afresh when another process saved meanwhile; a change with effects elsewhere runs once', async () => {
  const { reopenWorkspace, updateBooks, updateBooksWithEffects } = await import('../src/server/books.js');
  const dir = root();
  reopenWorkspace(dir.paths.root);
  const otherSaves = (id: string) => { const b = loadBooks(dir); b.journalEntries.push(entry(id)); saveBooks(dir, b); };
  let runs = 0;
  const count = updateBooks((books) => {
    if (runs++ === 0) otherSaves('other');
    books.journalEntries.push(entry('mine'));
    return books.journalEntries.length;
  });
  assert.deepEqual([runs, count], [2, 4]);
  assert.deepEqual(loadBooks(dir).journalEntries.map((e) => e.id).sort(), ['jc', 'jo', 'mine', 'other']);
  runs = 0;
  assert.throws(() => updateBooksWithEffects((books) => {
    runs++;
    otherSaves('other2');
    books.journalEntries.push(entry('mine2'));
  }), StaleBooksError);
  assert.equal(runs, 1);
  assert.deepEqual(loadBooks(dir).journalEntries.map((e) => e.id).sort(), ['jc', 'jo', 'mine', 'other', 'other2']);
});
