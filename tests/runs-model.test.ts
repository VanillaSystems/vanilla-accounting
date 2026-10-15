/**
 * The runs table (src/app/areas/automation/runs-model.ts): each file that came in becomes a line
 * with its result read from the books, a statement's closing balance checked against the ledger;
 * where a run stands for the person checking it follows from its status, the mark and the lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { linesOf, standOf } from '../src/app/areas/automation/runs-model.js';
import type { Arrival, RunSummary } from '../src/workflows/model.js';
import type { Index } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

const books = loadBooks(workspaceAt(DEMO_ROOT)) as unknown as Index;
const bal = books.statementBalances!.find((b) => b.account === '1021' && b.date === '2026-09-30')!;
const run = (o: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' }, mode: 'live', startedAt: '2026-10-15T11:00:00Z', status: 'done', path: [],
  startedBy: { kind: 'outside', file: 'x' }, digest: { files: [], receipts: 0, links: 0, entries: 0 }, ...o,
});
const statement = (amount: number): Arrival => ({ kind: 'statement', file: 'Raiffeisen/s.pdf', account: '1021', added: 3, bank: 'Raiffeisen', currency: 'CHF', from: '2026-09-01', to: '2026-09-30', closing: { date: '2026-09-30', amount } });
const linked = books.mappings[0];

test('a statement whose closing balance is the ledger\'s matches; 4.10 more at the bank is a line to check, unless the run is marked', () => {
  const ok = run({ arrived: [statement(bal.amount)] });
  const [line] = linesOf(ok, books);
  assert.deepEqual(line.kind === 'statement' && line.balance, { kind: 'matches', date: '2026-09-30' });
  assert.equal(standOf(ok, linesOf(ok, books)), 'ok');

  const off = run({ arrived: [statement(bal.amount + 4.1)] });
  const [l2] = linesOf(off, books);
  assert.deepEqual(l2.kind === 'statement' && l2.balance, { kind: 'differs', date: '2026-09-30', diff: -4.1 }, 'the books hold 4.10 too little');
  assert.equal(standOf(off, linesOf(off, books)), 'check');
  const marked = { ...off, reviewed: '2026-10-15T12:00:00Z' };
  assert.equal(standOf(marked, linesOf(marked, books)), 'reviewed', 'a person who checked it decides');
});

test('a receipt is read when the books hold it, with the payments it is linked to; one the finished run did not read is to check; a refused file too', () => {
  const r = run({ arrived: [{ kind: 'receipt', file: 'a.pdf', id: linked.receiptId }] });
  const [line] = linesOf(r, books);
  assert.ok(line.kind === 'receipt' && line.receipt && line.payments.some((p) => p.ref === linked.transactionRef));
  assert.equal(standOf(r, linesOf(r, books)), 'ok');
  const unread = run({ arrived: [{ kind: 'receipt', file: 'b.pdf', id: 'ffffffffffffffff' }] });
  assert.equal(standOf(unread, linesOf(unread, books)), 'check');
  const refused = run({ arrived: [{ kind: 'refused', file: 'c.docx', reason: 'Word' }] });
  assert.equal(standOf(refused, linesOf(refused, books)), 'check');
});

test('where a run stands: running, stuck, waiting before anything else; a run that took and made nothing has nothing to do', () => {
  const lines = linesOf(run({ arrived: [statement(bal.amount + 1)] }), books);
  assert.equal(standOf(run({ status: 'running' }), lines), 'running');
  assert.equal(standOf(run({ status: 'stuck', error: 'x' }), lines), 'error');
  assert.equal(standOf(run({ status: 'waiting' }), lines), 'you');
  assert.equal(standOf(run(), []), 'idle');
  assert.equal(standOf(run({ digest: { files: ['a.pdf'], receipts: 1, links: 0, entries: 0 } }), linesOf(run({ digest: { files: ['a.pdf'], receipts: 1, links: 0, entries: 0 } }), books)), 'ok');
});
