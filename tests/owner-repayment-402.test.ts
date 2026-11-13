/**
 * #402: the firm pays the owner back once a month the business costs he paid privately («Spesen Juli
 * 2026», to his own name, the same payee as his salary). Its outlays are booked over his account
 * already (expense / 2451 «Privat bezahlt»), so the payment waits for no receipt, the hand form
 * proposes bank / his account without a code (never the salary's 5000 «wie bei derselben Firma»),
 * and the model is told so; after the three repayments his account holds nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bookingDraft, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { answerSettles, receiptKnowledge, receiptWaitOf } from '../src/booking/receipt-wait.js';
import { outlaysOpen } from '../src/booking/owner-outlays.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { handStart } from '../src/saving/hand-rule.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks, type Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const OWNER = 'Lukas Beispiel';
const pay = (ref: string, date: string, amount: number, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty: OWNER, description, ...over });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number, vatCode?: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, ...(vatCode && { vatCode }), description: ref, origin: 'classify', by: { kind: 'model' }, ...over });

// The six receipts he paid privately, booked over his account as «Privat bezahlt» books them.
const OUTLAYS: Array<[string, string, string, number, string]> = [
  ['M2026-001', '2026-07-08', '6640', 72.4, 'I81'], ['M2026-002', '2026-07-15', '6641', 146.5, 'I81'],
  ['M2026-003', '2026-08-19', '6640', 58, 'I81'], ['M2026-004', '2026-08-12', '6500', 54, 'I26'],
  ['M2026-005', '2026-09-09', '6640', 53.6, 'I81'], ['M2026-006', '2026-09-16', '6200', 18, 'I81'],
];
const outlayTxs = OUTLAYS.map(([ref, date, , amount]) => pay(ref, date, amount, `Beleg ${ref}`, { bank: 'manual', source: 'manual', counterparty: undefined }));
const outlayEntries = OUTLAYS.map(([ref, date, account, amount, code]) => entry(ref, date, account, '2451', amount, code));
const SALARIES = [pay('L7', '2026-07-27', 8602, 'Lohn Juli 2026'), pay('L8', '2026-08-25', 8602, 'Lohn August 2026')];
const salaryEntries = SALARIES.map((t) => entry(t.ref, t.date, '5000', '1020', 8602, undefined, { origin: 'manual', by: { kind: 'person' } }));
const REPAY = [pay('S7', '2026-07-31', 218.9, 'Spesen Juli 2026'), pay('S8', '2026-08-31', 112, 'Spesen August 2026'), pay('S9', '2026-09-30', 71.6, 'Spesen September 2026')];

/** A one-person GmbH whose owner is employed and pays business costs privately (the consultancy persona). */
function firm(withOutlays = true): Workspace {
  const made = tempWorkspace('owner-402-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: [phone]\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, {
    transactions: [...SALARIES, ...REPAY, ...(withOutlays ? outlayTxs : [])],
    journalEntries: [...salaryEntries, ...(withOutlays ? outlayEntries : [])],
    config: { closedThrough: '2026-06-30' },
  });
  return ws;
}

const known = (ws: Workspace) => receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws);
const wait = (ws: Workspace, books: Books, ref: string) => receiptWaitOf(books, books.transactions.find((t) => t.ref === ref)!, loadClassifyContext(ws), known(ws), loadFxResolver());
const side = (l: { accountDebit: string; accountCredit: string; vat: string }) => [l.accountDebit, l.accountCredit, l.vat];

/** The form's draft as PaymentBooking builds it, from the server's start. */
function draftOf(ws: Workspace, books: Books, ref: string) {
  const start = handStart(ws, ref)!;
  const k: DraftKnowledge = { ...(start.nature && { nature: start.nature }), ...(start.wages && { wages: start.wages }) };
  return { start, draft: bookingDraft(books, ref, ws.bankAccounts, [], k)! };
}

test('a repayment of his outlays waits for no receipt; without the outlays booked it waits as any payment, and a salary is a wage', () => {
  const ws = firm();
  const books = loadBooks(ws);
  for (const ref of ['S7', 'S8', 'S9']) assert.deepEqual(wait(ws, books, ref), { wait: false, why: 'repaysOwner' }, ref);
  const bare = firm(false);
  assert.deepEqual(wait(bare, loadBooks(bare), 'S7'), { wait: true }, 'nothing on his account: no repayment to see');
  const salary = { ...books, journalEntries: books.journalEntries.filter((e) => e.transactionRef !== 'L8') };
  assert.deepEqual(receiptWaitOf(salary, salary.transactions.find((t) => t.ref === 'L8')!, loadClassifyContext(ws), known(ws), loadFxResolver()), { wait: false, why: 'wage' });
});

test('without an AI: the form proposes bank / his account without a code, never the salary\'s 5000; one click each and his account ends at zero', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  const context = loadClassifyContext(ws);
  // Code does not book it by itself (#359: code books bank fees only): it is left to the person.
  const { unasked, classified } = await classifyTransactions(structuredClone(books), REPAY, { fx: loadFxResolver(), context });
  assert.deepEqual([classified, unasked.sort()], [[], ['S7', 'S8', 'S9']]);
  for (const t of REPAY) {
    const { start, draft } = draftOf(ws, books, t.ref);
    // The server reads the books on disk: the outlays up to the payment's day, less the repayments saved there.
    assert.deepEqual(start.nature, { kind: 'ownerOutlays', account: '2451', open: outlaysOpen(loadBooks(ws), '2451', context.moneyAccounts!, t.date, t.ref) }, t.ref);
    assert.deepEqual(draft.lines.map(side), [['2451', '1020', '']], t.ref);
    assert.deepEqual(draft.lines[0].source, { account: { from: 'ownerOutlays' } }, t.ref);
    assert.equal(draft.precedent, undefined, `${t.ref}: no salary «wie bei derselben Firma»`);
    // Her click books the lines as they stand.
    books.journalEntries.push(...draft.lines.map((l, i) => entry(`${t.ref}-${i}`, t.date, l.accountDebit, l.accountCredit, l.amount, undefined, { transactionRef: t.ref, origin: 'manual', by: { kind: 'person' } })));
  }
  assert.equal(outlaysOpen(books, '2451', context.moneyAccounts!, '2026-12-31'), 0);
});

test('a salary\'s account is no precedent for a payment to the same person that is no wage', () => {
  const ws = firm(false);
  const books = loadBooks(ws);
  const { start, draft } = draftOf(ws, books, 'S7');
  assert.equal(start.nature, undefined, 'no outlays on his account: nothing known of the payment');
  assert.deepEqual(start.wages?.sort(), ['L7', 'L8']);
  assert.equal(draft.precedent, undefined);
  assert.notEqual(draft.lines[0].accountDebit, '5000');
  // A wage still follows the wage before it.
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== 'L8');
  assert.equal(draftOf(ws, books, 'L8').draft.precedent?.transactionRef, 'L7');
});

test('with an AI: the model is told the payment repays his outlays, books it on his account without a code, and his account ends at zero', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  const context = loadClassifyContext(ws);
  const said: Record<string, string> = {};
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const out: Record<string, unknown> = {};
    for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
      const ref = part.split(/\s/)[0];
      said[ref] = part.split('\n\n')[0];
      // A model that follows what it is told, and books an expense where it is told nothing (65-no-receipt.png).
      const told = /Owner's outlays paid back: .* Book this payment on 2451/.test(said[ref]);
      out[ref] = { entries: [{ accountDebit: told ? '2451' : '5820', accountCredit: '', amount: Number(/Amount: ([\d.]+)/.exec(part)![1]), vat: 'none', description: 'Lukas Beispiel, Spesen' }] };
    }
    return JSON.stringify(out);
  };
  const { classified, failed } = await classifyTransactions(books, REPAY, { ask, fx: loadFxResolver(), context });
  assert.deepEqual([classified.sort(), failed], [['S7', 'S8', 'S9'], []]);
  for (const t of REPAY) {
    const lines = books.journalEntries.filter((e) => e.transactionRef === t.ref);
    assert.deepEqual(lines.map((e) => [e.accountDebit, e.accountCredit, e.vatCode]), [['2451', '1020', undefined]], t.ref);
    assert.ok(answerSettles(t, lines, context), `${t.ref}: the intake keeps the answer`);
  }
  assert.match(said.S7, /holds 218\.9 CHF of outlays not paid back/);
  assert.equal(outlaysOpen(books, '2451', context.moneyAccounts!, '2026-12-31'), 0);
});
