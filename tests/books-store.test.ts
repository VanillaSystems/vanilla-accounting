/**
 * src/books/store.ts owns the books file and golden rule 1 (AGENTS.md). Runs against temp
 * copies of tests/fixtures/period-lock-index.json (closedThrough 2026-06-30: C1/jc closed,
 * O1/jo open, M2026-001 a closed manual transaction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';
import { ClosedPeriodError, loadBooks, moduleActor, OwnershipError, PERSON, periodLock, saveBooks, update, type Actor, type Books } from '../src/books/store.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');

function root(content?: string): Workspace {
  const ws = tempWorkspace('books-store-');
  if (content === undefined) copyFileSync(FIXTURE, ws.paths.books);
  else writeFileSync(ws.paths.books, content);
  return ws;
}

const fixtureBooks = (): Books => loadBooks(root());

test('saveBooks writes what the CLIs always wrote, stamped with the schema, atomically, with no temp file left', () => {
  const dir = root();
  const books = loadBooks(dir);
  const expected = JSON.stringify({ schema: 1, ...JSON.parse(readFileSync(FIXTURE, 'utf8')) }, null, 2);
  saveBooks(dir, books);
  assert.equal(readFileSync(dir.paths.books, 'utf8'), expected);
  assert.deepEqual(readdirSync(dir.paths.root).sort(), ['belege.workspace.yaml', 'books.json']);
  saveBooks(dir, loadBooks(dir));
  assert.equal(readFileSync(dir.paths.books, 'utf8'), expected, 'load + save is a fixed point');
});

test('loadBooks fills journalEntries and config, and saveBooks leaves them off while empty', () => {
  const bare = JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [] }, null, 2);
  const dir = root(bare);
  const books = loadBooks(dir);
  assert.equal(books.journalEntries.length, 0);
  assert.deepEqual(books.config, {});
  saveBooks(dir, books);
  assert.equal(readFileSync(dir.paths.books, 'utf8'), JSON.stringify({ schema: 1, ...JSON.parse(bare) }, null, 2));

  books.journalEntries.push({ id: 'n', transactionRef: 'x', date: '2026-08-01', accountDebit: '6500', accountCredit: '1021', amount: 1 });
  saveBooks(dir, books);
  assert.equal(JSON.parse(readFileSync(dir.paths.books, 'utf8')).journalEntries.length, 1, 'a filled default that got content is saved');
});

test('loadBooks throws when there are no books', () => {
  assert.throws(() => loadBooks(tempWorkspace('books-store-')), /npm run extract/);
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
  const before = readFileSync(dir.paths.books, 'utf8');
  assert.throws(() => update(books, PERSON, (b) => {
    b.mappings.push({ transactionRef: 'C1', receiptId: 'ro' });
    saveBooks(dir, b);
  }), ClosedPeriodError);
  assert.equal(readFileSync(dir.paths.books, 'utf8'), before);
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
