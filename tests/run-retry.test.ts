/**
 * Issue #132: a run's save that meets books another process saved since its load (StaleBooksError,
 * #123) runs its change once more on books loaded afresh, so the item is booked on the retry; a
 * second stale save stops the step with the reason. The retried change sees the other process's
 * edits: it books nothing twice and leaves a person's booking alone. A receipt's file leaves
 * beleg-import/ only with a save that wrote its record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveReceipt } from '../src/books/archive.js';
import { loadBooks, moduleActor, PERSON, receiptFile, saveBooks, StaleBooksError, update, type Books } from '../src/books/store.js';
import { runIntake, storePort, type StepRun } from '../src/intake/pipeline.js';
import type { JournalEntry } from '../src/types/index.js';
import type { Workspace } from '../src/workspace/workspace.js';
import { booksOnDisk, tempWorkspace, writeIndex } from './support/workspace.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');
const RUN = moduleActor('intake');

function workspace(): Workspace {
  const ws = tempWorkspace('run-retry-');
  writeIndex(ws, JSON.parse(readFileSync(FIXTURE, 'utf8')));
  return ws;
}

const booking = (id: string, origin?: 'manual'): JournalEntry => ({ id, transactionRef: 'OI', date: '2026-08-20', accountDebit: '1021', accountCredit: '3200', amount: 10, ...(origin ? { origin } : {}) });
/** Another process's booking in the same year's file as the run's. */
const other = (id: string): JournalEntry => ({ id, transactionRef: 'M2026-002', date: '2026-08-15', accountDebit: '6500', accountCredit: '1021', amount: 5, origin: 'manual' });
const ids = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => e.id);

/** Another process saves `change` to the books while the step's change runs, on its first `times` calls. */
function meanwhile(ws: Workspace, change: (books: Books) => void, times = 1): () => void {
  let left = times;
  return () => {
    if (left-- <= 0) return;
    const other = loadBooks(ws);
    update(other, PERSON, change);
    saveBooks(ws, other);
  };
}

/** A step that books payment OI unless it is booked, like a run of the booking workflow. */
const bookOI = (interfere: () => void): StepRun => async ({ books }) => {
  books.update((index) => {
    interfere();
    if (!index.journalEntries.some((e) => e.transactionRef === 'OI')) index.journalEntries.push(booking('run'));
  });
  return { notes: [] };
};

test('a run whose save meets a concurrent save books its item on the retry, and the other edit survives', async () => {
  const ws = workspace();
  const interfere = meanwhile(ws, (b) => { b.journalEntries.push(other('other')); });
  const job = await runIntake({ ws, books: storePort(ws, RUN), steps: [['classify', bookOI(interfere)]] });
  assert.equal(job.steps[0].state, 'done', JSON.stringify(job.steps[0].notes));
  const books = loadBooks(ws);
  assert.deepEqual(ids(books, 'OI'), ['run'], 'booked once');
  assert.deepEqual(ids(books, 'M2026-002'), ['other']);
});

test('the retry sees a person\'s booking made meanwhile: nothing is booked twice and the person\'s booking stays', async () => {
  const ws = workspace();
  const interfere = meanwhile(ws, (b) => { b.journalEntries.push(booking('person', 'manual')); });
  const job = await runIntake({ ws, books: storePort(ws, RUN), steps: [['classify', bookOI(interfere)]] });
  assert.equal(job.steps[0].state, 'done', JSON.stringify(job.steps[0].notes));
  assert.deepEqual(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'OI').map((e) => [e.id, e.origin]), [['person', 'manual']]);
});

test('a second stale save stops the step with the reason, writes nothing of it and keeps the other edits', async () => {
  const ws = workspace();
  let n = 0;
  const interfere = meanwhile(ws, (b) => { b.journalEntries.push(other(`other ${++n}`)); }, 2);
  const job = await runIntake({ ws, books: storePort(ws, RUN), steps: [['classify', bookOI(interfere)], ['vat', async () => ({ notes: [] })]] });
  assert.equal(job.steps[0].state, 'stopped');
  assert.match(String((job.steps[0].notes[0] as { detail?: string }).detail), /von einem anderen Prozess geändert/);
  assert.equal(job.steps[1].state, 'waiting', 'the later steps do not run');
  const books = loadBooks(ws);
  assert.deepEqual(ids(books, 'OI'), []);
  assert.deepEqual(ids(books, 'M2026-002'), ['other 1', 'other 2']);
});

/** A staged receipt in beleg-import/, in the books. */
function staged(ws: Workspace): void {
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'scan.pdf'), '%PDF staged');
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.receipts.push({ id: 'rs', filename: 'scan.pdf', location: 'staged', date: '2026-08-20' } as Books['receipts'][number]); });
  saveBooks(ws, books);
}

test('a refused save leaves the receipt\'s file in beleg-import/, where its record says it is', () => {
  const ws = workspace();
  staged(ws);
  const books = loadBooks(ws);
  update(books, RUN, (b) => { archiveReceipt(ws, b, b.receipts.find((r) => r.id === 'rs')!, 'archived.pdf'); });
  meanwhile(ws, (b) => { b.receipts.find((r) => r.id === 'ro')!.remarks = 'other'; })();
  assert.throws(() => saveBooks(ws, books), StaleBooksError);
  assert.equal(loadBooks(ws).receipts.find((r) => r.id === 'rs')!.location, 'staged');
  assert.ok(existsSync(join(ws.paths.inbox, 'scan.pdf')), 'the file is where the books say');
});

test('an archive retried after a stale save moves the file once, under the name it was given', () => {
  const ws = workspace();
  staged(ws);
  const interfere = meanwhile(ws, (b) => { b.receipts.find((r) => r.id === 'ro')!.remarks = 'other'; });
  const target = storePort(ws, RUN).update((b) => {
    interfere();
    return archiveReceipt(ws, b, b.receipts.find((r) => r.id === 'rs')!, 'archived.pdf');
  });
  assert.equal(target, 'archived.pdf');
  const books = loadBooks(ws);
  const r = books.receipts.find((x) => x.id === 'rs')!;
  assert.deepEqual([r.location, r.filename], ['archived', 'archived.pdf']);
  assert.equal(readFileSync(receiptFile(ws, books, r), 'utf8'), '%PDF staged');
  assert.equal(existsSync(join(ws.paths.inbox, 'scan.pdf')), false);
  assert.equal(books.receipts.find((x) => x.id === 'ro')!.remarks, 'other');
});

test('a receipt\'s file that cannot be moved leaves the books unwritten', () => {
  const ws = workspace();
  staged(ws);
  const books = loadBooks(ws);
  update(books, RUN, (b) => { archiveReceipt(ws, b, b.receipts.find((r) => r.id === 'rs')!, 'archived.pdf'); });
  rmSync(join(ws.paths.inbox, 'scan.pdf'));
  const was = booksOnDisk(ws);
  assert.throws(() => saveBooks(ws, books), /ENOENT/);
  assert.deepEqual(booksOnDisk(ws), was);
});
