/**
 * Seals of the filed quarters (src/books/seal.ts, npm run seal). Runs against temp copies of
 * tests/fixtures/period-lock-index.json: closed through 2026-06-30, its closed records all in
 * 2026-Q2 (C1/jc, M2026-001, CI), the open ones in Q3 (O1/jo, M2026-002).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClosedPeriodError, SealBrokenError, loadBooks, saveBooks, sealsOf } from '../src/books/store.js';
import { checkSeals, writeSeal } from '../src/books/seal.js';
import { yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/period-lock-index.json');

function sealed(): Workspace {
  const ws = tempWorkspace('seal-');
  writeIndex(ws, JSON.parse(readFileSync(FIXTURE, 'utf8')));
  writeSeal(ws, loadBooks(ws), '2026-Q2', '2026-07-11');
  return ws;
}

/** Edits the books' files the way a hand or an ad-hoc script would: past saveBooks and its checks. */
function handEdit(ws: Workspace, edit: (books: Record<string, any>) => void): void {
  const raw = JSON.parse(JSON.stringify(loadBooks(ws)));
  edit(raw);
  writeIndex(ws, raw);
}

const statuses = (ws: Workspace) => checkSeals(ws, loadBooks(ws)).checks.map((c) => `${c.quarter} ${c.status}`);

test('a sealed quarter verifies, and sealing it again changes nothing', () => {
  const ws = sealed();
  const file = join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json');
  const seal = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(seal.records, { entries: 1, transactions: 3, mappings: 1 });
  assert.deepEqual(statuses(ws), ['2026-Q2 intact']);
  assert.equal(writeSeal(ws, loadBooks(ws), '2026-Q2', '2026-10-09').status, 'intact');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sealedAt, '2026-07-11', 'the seal file is not rewritten');
});

test('a closed quarter without a seal is listed; an open one cannot be sealed', () => {
  const ws = tempWorkspace('seal-');
  writeIndex(ws, JSON.parse(readFileSync(FIXTURE, 'utf8')));
  assert.deepEqual(checkSeals(ws, loadBooks(ws)).unsealed, ['2026-Q2'], 'Q1 holds no records, so it needs no seal');
  assert.throws(() => writeSeal(ws, loadBooks(ws), '2026-Q3', '2026-10-09'), /2026-Q3 is not closed/);
});

test('changing a closed entry by hand breaks the seal: the books read, but never save', () => {
  const ws = sealed();
  handEdit(ws, (b) => { b.journalEntries.find((e: { id: string }) => e.id === 'jc').amount += 1; });
  const books = loadBooks(ws);
  const [check] = sealsOf(books).checks;
  assert.equal(check.status, 'broken');
  assert.match(check.status === 'broken' ? check.problem : '', /on or before 2026-06-30 changed since it was sealed on 2026-07-11/);
  books.journalEntries.find((e) => e.id === 'jo')!.amount += 1;
  assert.throws(() => saveBooks(ws, books), (e: Error) => e instanceof SealBrokenError && e instanceof ClosedPeriodError, 'the API answers it with 403');
  assert.throws(() => writeSeal(ws, books, '2026-Q2', '2026-10-09'), /never rewritten/);
});

test('a removed closed mapping, an added closed transaction, a moved-back closedThrough each break it', () => {
  const edits: Array<(b: Record<string, any>) => void> = [
    (b) => { b.mappings = b.mappings.filter((m: { transactionRef: string }) => m.transactionRef !== 'C1'); },
    (b) => { b.transactions.push({ ...b.transactions[0], ref: 'C9' }); },
    (b) => { b.config.closedThrough = '2026-03-31'; },
  ];
  for (const edit of edits) {
    const ws = sealed();
    handEdit(ws, edit);
    assert.deepEqual(statuses(ws), ['2026-Q2 broken'], edit.toString());
  }
});

test('open-period changes and a reorder of records or keys leave the seal intact', () => {
  const ws = sealed();
  handEdit(ws, (b) => {
    b.journalEntries.find((e: { id: string }) => e.id === 'jo').amount += 1;
    b.transactions.reverse();
    b.journalEntries = b.journalEntries.map((e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).reverse()));
  });
  assert.deepEqual(statuses(ws), ['2026-Q2 intact']);
});

const seal = (ws: Workspace, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/seal.ts', ...args], { env: { ...process.env, VANILLA_WORKSPACE: ws.paths.root }, encoding: 'utf8', stdio: 'pipe' });

test('npm run seal -- <quarter> --close moves closedThrough one quarter and seals it; a rerun only confirms', () => {
  const ws = sealed();
  assert.throws(() => seal(ws, '2026-Q4', '--close'), /next quarter to close is 2026-Q3/);
  assert.match(seal(ws, '2026-Q3', '--close'), /closedThrough 2026-06-30 → 2026-09-30[\s\S]*Sealed 2026-Q3/);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-09-30');
  assert.ok(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q3.json')));
  assert.match(seal(ws, '2026-Q3', '--close'), /sealed already, and the seal holds/);
  assert.deepEqual(statuses(ws), ['2026-Q2 intact', '2026-Q3 intact']);
});

test('npm run seal -- <Q4> --close refuses: the fourth quarter closes with the year, after the year-end entries; --force closes it', () => {
  const ws = sealed();
  seal(ws, '2026-Q3', '--close');
  assert.throws(() => seal(ws, '2026-Q4', '--close'), /closes with the year: npm run year:close -- 2026/);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-09-30');
  assert.match(seal(ws, '2026-Q4', '--close', '--force'), /closedThrough 2026-09-30 → 2026-12-31/);
});
