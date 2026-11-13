/**
 * #470: a payment a run tried to book and left unbooked says so on itself. The step that left it
 * hands it to the run log with its refusal (src/workflows/runlog.ts `refused`), the payment's
 * «Verlauf» names that run, and the open payments a run left unbooked are one list with why
 * (src/server/refusals.ts) for the payment's page, the lists, the drop and the AI's facts. The hand
 * form of a contribution payment proposes what the books say: what 2270 holds on it, the rest on the
 * employer's account. The painter persona's July (.claude/skills/verify/persona-files/huber.mjs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClassifyDeps } from '../src/booking/classify.js';
import { classifyStep } from '../src/intake/classify.js';
import { handStart } from '../src/saving/hand-rule.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { appendLine, lineFor, type RunLogLine } from '../src/workflows/runlog.js';
import { historyOf, refusalsOf } from '../src/workflows/history.js';
import { paymentRefusals } from '../src/server/refusals.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks, type Books } from '../src/books/store.js';
import type { Run } from '../src/workflows/model.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number): JournalEntry =>
  ({ id: `e-${ref}-${debit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', by: { kind: 'model', model: 'test' } }) as JournalEntry;

const WAGES = [pay('LR', '2026-07-25', 5200, 'Marco Rossi', 'Lohn Juli 2026'), pay('LH', '2026-07-25', 4800, 'Sandra Huber', 'Lohn Juli 2026')];
const NET = [entry('LR', '2026-07-25', '5000', '1020', 5200), entry('LH', '2026-07-25', '5000', '1020', 4800)];
const SVA = pay('SVA', '2026-07-30', 1890.35, 'SVA St. Gallen', 'AHV Beiträge Q2');

/** The painter's books; `without`: accounts left out of her chart. */
function painter(entries: JournalEntry[] = NET, without: string[] = []): Workspace {
  const made = tempWorkspace('refused-470-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.filter((a) => !without.includes(a.number)).map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, { transactions: [...WAGES, SVA], journalEntries: entries, receipts: [], mappings: [], config: { closedThrough: '2026-06-30' } as never });
  return ws;
}

/** The walk's answer: 945.18 on 2270, the rest on `rest`. */
const halfOn2270 = (rest: string): ClassifyDeps['ask'] => async (prompt) => {
  const out: Record<string, unknown> = {};
  for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
    const ref = part.split(/\s/)[0];
    out[ref] = { entries: [{ accountDebit: '2270', accountCredit: '', amount: 945.18, vat: 'none', description: 'AHV AN' }, { accountDebit: rest, accountCredit: '', amount: 945.17, vat: 'none', description: 'AHV AG' }] };
  }
  return JSON.stringify(out);
};

async function intake(ws: Workspace, ask: ClassifyDeps['ask']) {
  const books = loadBooks(ws);
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  const result = await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} });
  return { books, result };
}

const REFUSED: RunLogLine['refused'] = [{ ref: 'SVA', refusal: { code: 'classifyWithheldOver', params: { account: '2270', currency: 'CHF', taken: 945.18, open: 0 } } }];

test('the book step hands on what it left unbooked, with the refusal: the cap\'s, when no employer\'s contribution account is in the chart', async () => {
  const { result, books } = await intake(painter(NET, ['5700', '5710', '5720']), halfOn2270('6700'));
  assert.equal(books.journalEntries.filter((e) => e.transactionRef === 'SVA').length, 0);
  assert.deepEqual(result.refused, REFUSED);
  const booked = await intake(painter(), halfOn2270('5700'));
  assert.equal(booked.result.refused, undefined, 'booked whole on 5700: nothing left');
});

const run = (output: Record<string, unknown>): Run => ({
  id: 'run-drop', workflow: 'receipt-intake', version: 'v1', mode: 'live', item: { kind: 'drop', id: 'd1' },
  state: { status: 'done', finishedAt: '2026-11-13T10:00:00Z' }, steps: [{ step: 'book', effects: [], output }],
}) as unknown as Run;

test('the run log keeps the payments a run left unbooked, also from a run that wrote nothing', () => {
  const line = lineFor(run({ notes: [], refused: REFUSED }), 0);
  assert.deepEqual(line?.refused, REFUSED);
  assert.equal(lineFor(run({ notes: [] }), 0), undefined, 'a run that changed nothing and left nothing leaves no line');
});

const drop = (at: string): RunLogLine => ({ run: 'run-drop', workflow: 'receipt-intake', version: 'v1', item: { kind: 'drop' as never, id: 'd1' }, at, event: 'done', refused: REFUSED, host: 'local' });

test('the payment\'s «Verlauf» names the run that refused it, and the refusal is the one source of why it waits', () => {
  const log = [drop('2026-11-13T10:00:00Z')];
  const h = historyOf(log, { kind: 'payment', id: 'SVA', entries: [], receipts: [] }, () => true);
  assert.deepEqual(h.runs.map((r) => [r.run, r.refused?.refusal?.code]), [['run-drop', 'classifyWithheldOver']]);
  assert.deepEqual(refusalsOf(log, new Set(['SVA'])).map((r) => [r.ref, r.run, r.refusal?.code]), [['SVA', 'run-drop', 'classifyWithheldOver']]);
  assert.deepEqual(refusalsOf(log, new Set()), [], 'booked since: no reason left');
  // A later run on the payment itself that did not refuse it (it waits for a person now) takes the word.
  const later: RunLogLine = { run: 'run-own', workflow: 'payment-booking', version: 'v1', item: { kind: 'transaction', id: 'SVA' }, at: '2026-11-13T11:00:00Z', event: 'waiting', step: 'ask', host: 'local' };
  assert.deepEqual(refusalsOf([...log, later], new Set(['SVA'])), []);
});

test('the server reads the refusals of the open payments from the workspace\'s run log', () => {
  const ws = painter();
  appendLine(ws, drop('2026-11-13T10:00:00Z'), '2026-06-30');
  assert.deepEqual(paymentRefusals(ws, loadBooks(ws)).map((r) => r.ref), ['SVA']);
  assert.deepEqual(paymentRefusals(ws, { transactions: [SVA], journalEntries: [entry('SVA', '2026-07-30', '5700', '1020', 1890.35)] }), []);
});

test('the hand form of the SVA payment proposes the employer\'s contribution account for what 2270 does not hold', () => {
  const ws = painter();
  const start = handStart(ws, 'SVA')!;
  assert.deepEqual(start.nature, { kind: 'contributions', account: '5700', deductions: '2270', open: 0 });
  const books = loadBooks(ws);
  const draft = bookingDraft(books, 'SVA', ws.bankAccounts, [], { nature: start.nature! })!;
  assert.deepEqual(draft.lines.map((l) => [l.accountDebit, l.amount, l.vat]), [['5700', 1890.35, '']]);
  assert.deepEqual(draft.notes.map((n) => n.kind), ['contributions'], 'one note, and not «kein Vorschlag»');
  const held = painter([...NET, entry('LR', '2026-07-25', '5000', '2270', 300)]);
  const part = bookingDraft(loadBooks(held), 'SVA', held.bankAccounts, [], { nature: handStart(held, 'SVA')!.nature! })!;
  assert.deepEqual(part.lines.map((l) => [l.accountDebit, l.amount]), [['2270', 300], ['5700', 1590.35]]);
});
