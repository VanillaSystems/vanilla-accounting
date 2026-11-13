/**
 * #470: the painter books wages net (no payslips), so the deductions account (2270) holds nothing
 * when the SVA's contributions of Q2 are paid on 30.07. (1'890.35). The model is told that the whole
 * contribution is the employer's (#368's decision); an answer that still puts half on 2270 is booked
 * with what 2270 holds there and the rest on the contribution account it names, and the booking's
 * reason says so. Facts from the painter persona (.claude/skills/verify/persona-files/huber.mjs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { withinWithheld } from '../src/booking/withheld.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number): JournalEntry =>
  ({ id: `e-${ref}-${debit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', by: { kind: 'model', model: 'test' } }) as JournalEntry;

// The painter's July: two wages paid net and booked so on 5000, then the SVA's Q2 contributions.
const WAGES = [pay('LR', '2026-07-25', 5200, 'Marco Rossi', 'Lohn Juli 2026'), pay('LH', '2026-07-25', 4800, 'Sandra Huber', 'Lohn Juli 2026')];
const NET = [entry('LR', '2026-07-25', '5000', '1020', 5200), entry('LH', '2026-07-25', '5000', '1020', 4800)];
const SVA = pay('SVA', '2026-07-30', 1890.35, 'SVA St. Gallen', 'AHV Beiträge Q2');

function painter(entries: JournalEntry[], extra: BankTransaction[] = []): Workspace {
  const made = tempWorkspace('withheld-470-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, { transactions: [...WAGES, SVA, ...extra], journalEntries: entries, receipts: [], mappings: [], config: { closedThrough: '2026-06-30' } as never });
  return ws;
}

/** The walk's answer (round 5, rc.361): half of the SVA payment, 945.18, on 2270 and the rest on 5700. */
function halfOn2270(rest = '5700') {
  const said: Record<string, string> = {};
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const out: Record<string, unknown> = {};
    for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
      const ref = part.split(/\s/)[0];
      said[ref] = part.split('\n\n')[0];
      out[ref] = { reason: 'AHV-Beiträge Q2: Arbeitnehmer- und Arbeitgeberanteil', entries: [{ accountDebit: '2270', accountCredit: '', amount: 945.18, vat: 'none', description: 'AHV AN' }, { accountDebit: rest, accountCredit: '', amount: 945.17, vat: 'none', description: 'AHV AG' }] };
    }
    return JSON.stringify(out);
  };
  return { ask, said };
}

async function run(ws: Workspace, ref = 'SVA', rest = '5700') {
  const books = loadBooks(ws);
  const m = halfOn2270(rest);
  const outcome = await classifyTransactions(books, books.transactions.filter((t) => t.ref === ref), { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  return { books, outcome, said: m.said, lines: books.journalEntries.filter((e) => e.transactionRef === ref) };
}
const on = (lines: JournalEntry[], account: string) => Math.round(lines.filter((e) => e.accountDebit === account).reduce((s, e) => s + e.amount, 0) * 100) / 100;

test('wages booked net: the SVA payment is told that 2270 holds nothing and the whole contribution is the employer\'s', async () => {
  const { said } = await run(painter(NET));
  assert.match(said.SVA, /Withheld from wages: account 2270 holds nothing/);
  assert.match(said.SVA, /employer's expense as a whole/);
  assert.match(said.SVA, /nothing on 2270/);
});

test('an answer that puts half on an empty 2270 is booked in the same run: the whole payment on 5700, and the reason says what code moved', async () => {
  const { outcome, lines } = await run(painter(NET));
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(outcome.classified, ['SVA']);
  assert.equal(on(lines, '2270'), 0);
  assert.equal(on(lines, '5700'), 1890.35);
  assert.ok(lines.every((e) => !e.vatCode), 'contributions carry no VAT code');
  assert.match(lines[0].reason ?? '', /2270 der Lohnabzüge hielt an diesem Tag nur CHF 0\.00: die CHF 945\.18, .* auf 5700 gebucht/);
});

test('what 2270 holds stays there, only the rest moves: 300.00 withheld on a payslip booked gross', async () => {
  const { lines, outcome } = await run(painter([...NET, entry('LR', '2026-07-25', '5000', '2270', 300)]));
  assert.deepEqual(outcome.failed, []);
  assert.equal(on(lines, '2270'), 300);
  assert.equal(on(lines, '5700'), 1590.35);
});

test('without an employer\'s contribution account to move it to, code refuses the answer as before', () => {
  const lines = [entry('SVA', '2026-07-30', '2270', '1020', 945.18), entry('SVA', '2026-07-30', '5700', '1020', 945.17)];
  assert.equal(withinWithheld(lines, '2270', undefined, { named: new Set(), shared: new Set() }, () => 'x'), undefined);
  const named = withinWithheld(lines, '2270', undefined, { named: new Set(['5700']), shared: new Set(['5700']) }, () => 'x')!;
  assert.deepEqual(named.entries.map((e) => [e.accountDebit, e.amount]), [['5700', 945.18], ['5700', 945.17]]);
});

test('a firm without wages paying the owner\'s own AHV to the compensation fund is told nothing of 2270: no employer\'s contribution (#470 review)', async () => {
  const { said } = await run(painter([]));
  assert.doesNotMatch(said.SVA, /Withheld from wages/);
});

test('an answer that names no contribution account books the rest where the payee\'s earlier contributions went: the pension fund\'s 5720, not 5700', async () => {
  const PK1 = pay('PK1', '2026-07-01', 800, 'Pensionskasse Malergewerbe', 'BVG Beiträge Juli');
  const PK2 = pay('PK2', '2026-07-30', 1890.35, 'Pensionskasse Malergewerbe', 'BVG Beiträge August');
  const { lines, outcome } = await run(painter([...NET, entry('PK1', '2026-07-01', '5720', '1020', 800)], [PK1, PK2]), 'PK2', '6700');
  assert.deepEqual(outcome.failed, []);
  assert.equal(on(lines, '2270'), 0);
  assert.equal(on(lines, '5720'), 945.18);
  assert.equal(on(lines, '5700'), 0);
});
