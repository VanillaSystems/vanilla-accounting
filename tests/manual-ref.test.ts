/**
 * #124: a manual ref (M2026-NNN) is never minted again while anything names it: the books, the
 * questions, the run log, the invoices' payment allocations, the correction cases. A delete frees
 * no number something still points at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { nextManualRef } from '../src/books/next-ref.js';
import { dropPayment } from '../src/server/edits.js';
import { appendQuestionLine } from '../src/questions/store.js';
import { appendLine } from '../src/workflows/runlog.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const movement = (ref: string): BankTransaction => ({ ref, bank: 'manual', source: 'manual', date: '2026-08-04', amount: 11, currency: 'CHF', direction: 'DBIT', description: 'Briefmarken' });
const entry = (transactionRef: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${transactionRef}`, transactionRef, date: '2026-08-04', accountDebit: '6500', accountCredit: '2451', amount: 11, description: 'Briefmarken', origin: 'manual', ...over });

function workspace(index: object = {}) {
  const ws = tempWorkspace('manual-ref-');
  writeIndex(ws, { config: { closedThrough: '2026-06-30' }, transactions: [movement('M2026-001'), movement('M2026-002')], journalEntries: [], ...index });
  return ws;
}

/** Mints a movement, lets `name` point at it, deletes it through the app's own delete, and mints again. */
function mintDeleteMint(name: (ws: ReturnType<typeof workspace>, ref: string) => void, index?: object): { first: string; again: string } {
  const ws = workspace(index);
  const books = loadBooks(ws);
  const first = nextManualRef(books, '2026');
  books.transactions.push(movement(first));
  saveBooks(ws, books);
  name(ws, first);
  const after = loadBooks(ws);
  dropPayment(after, first);
  saveBooks(ws, after);
  return { first, again: nextManualRef(loadBooks(ws), '2026') };
}

test('a question about a deleted movement keeps its number taken', () => {
  const { first, again } = mintDeleteMint((ws, ref) => appendQuestionLine(ws, {
    v: 1, id: 'q1', at: '2026-08-05T10:00:00Z', by: 'Anna', event: 'asked', on: { kind: 'payment', id: ref }, text: 'Wofür?', choices: [], origin: 'person',
  } as never, '2026-06-30'));
  assert.equal(first, 'M2026-003');
  assert.equal(again, 'M2026-004', 'the question still names M2026-003: a new movement must not answer to it');
});

test('a run log line about a deleted movement keeps its number taken', () => {
  const { again } = mintDeleteMint((ws, ref) => appendLine(ws, {
    run: 'r1', workflow: 'booking', version: '1', item: { kind: 'payment', id: ref } as never, at: '2026-08-05T10:00:00Z', event: 'waiting', step: 'classify', host: 'local',
  }, '2026-06-30'));
  assert.equal(again, 'M2026-004');
});

test('an invoice payment allocation naming a deleted movement keeps its number taken', () => {
  const { again } = mintDeleteMint((ws, ref) => {
    mkdirSync(dirname(ws.paths.invoices), { recursive: true });
    writeFileSync(ws.paths.invoices, JSON.stringify({ schema: 1, customers: [], sent: [], invoices: [{ id: 'i1', payments: [{ transactionRef: ref, date: '2026-08-04', amount: 11, by: 'confirmed' }] }] }));
  });
  assert.equal(again, 'M2026-004');
});

test('a change of the AI sidebar naming a deleted movement keeps its number taken', () => {
  const { again } = mintDeleteMint((ws, ref) => {
    mkdirSync(join(ws.paths.data, 'assistant'), { recursive: true });
    writeFileSync(join(ws.paths.data, 'assistant', 'c.json'), JSON.stringify({ turns: [{ role: 'ai', changes: [{ id: 'm1', change: { kind: 'link', receipt: 'r1', payment: ref }, undo: { kind: 'unlink', receipt: 'r1', payment: ref } }] }] }));
  });
  assert.equal(again, 'M2026-004', 'its undo would unlink a receipt from the new movement');
});

test('a correction case naming a deleted movement keeps its number taken', () => {
  const { again } = mintDeleteMint((ws, ref) => {
    const books = loadBooks(ws);
    books.config.correctionCases = [{ id: 'c1', period: '2026-Q2', title: 'x', wrong: `${ref} fehlte`, fix: 'y', originalEntryIds: [], correctionEntryIds: [] }];
    saveBooks(ws, books);
  });
  assert.equal(again, 'M2026-004');
});

test('the books name a ref by more than the transaction: a booking without payment, a replaced booking, a statement, a description', () => {
  const books = (over: Partial<Books>): Books => ({ schema: 3, receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: {}, ...over } as Books);
  assert.equal(nextManualRef(books({ journalEntries: [entry('M2026-007')] }), '2026'), 'M2026-008', 'a booking without payment (#89)');
  assert.equal(nextManualRef(books({ transactions: [{ ...movement('M2026-001'), replaced: [entry('M2026-009')] }] }), '2026'), 'M2026-010', 'the booking a payment replaced');
  assert.equal(nextManualRef(books({ bankStatements: [{ bank: 'manual', filename: 's', fromDate: '2026-08-01', toDate: '2026-08-31', refs: ['M2026-011'] }] }), '2026'), 'M2026-012', 'a statement');
  assert.equal(nextManualRef(books({ journalEntries: [entry('X', { description: 'Storno von M2026-013' })] }), '2026'), 'M2026-014', 'a correction naming the original');
  assert.equal(nextManualRef(books({ journalEntries: [entry('M2025-050')] }), '2026'), 'M2026-001', 'another year counts apart');
  assert.equal(nextManualRef(books({ receipts: [{ id: 'r', filename: 'f', originalFilename: 'f', extractedText: 'Auftrag M2026-900', indexedAt: '' } as never] }), '2026'), 'M2026-001', 'a receipt\'s read text is the vendor\'s, not a name');
});

test('nothing changes for the refs there are: the next number follows the highest', () => {
  const ws = workspace({ transactions: [movement('M2026-001'), movement('M2026-005')], journalEntries: [entry('M2026-012')] });
  assert.equal(nextManualRef(loadBooks(ws), '2026'), 'M2026-013');
});

test('a ref of four digits keeps counting', () => {
  const ws = workspace({ transactions: [movement('M2026-1000')] });
  assert.equal(nextManualRef(loadBooks(ws), '2026'), 'M2026-1001');
});
