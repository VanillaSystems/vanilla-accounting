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
import { outlaysOpen, ownerFactsOf, readingsMade } from '../src/booking/owner-outlays.js';
import { judgedRepayments } from '../src/booking/owner-judged.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { classifyStep } from '../src/intake/classify.js';
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
  ({ id: `e-${ref}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, ...(vatCode && { vatCode }), description: ref, origin: 'classify', by: { kind: 'model', model: 'test' }, ...over }) as JournalEntry;

// The six receipts he paid privately, booked over his account as «Privat bezahlt» books them.
const OUTLAYS: Array<[string, string, string, number, string]> = [
  ['M2026-001', '2026-07-08', '6640', 72.4, 'I81'], ['M2026-002', '2026-07-15', '6641', 146.5, 'I81'],
  ['M2026-003', '2026-08-19', '6640', 58, 'I81'], ['M2026-004', '2026-08-12', '6500', 54, 'I26'],
  ['M2026-005', '2026-09-09', '6640', 53.6, 'I81'], ['M2026-006', '2026-09-16', '6200', 18, 'I81'],
];
const outlayTxs = OUTLAYS.map(([ref, date, , amount]) => pay(ref, date, amount, `Beleg ${ref}`, { bank: 'manual', source: 'manual', counterparty: undefined }));
const outlayEntries = OUTLAYS.map(([ref, date, account, amount, code]) => entry(ref, date, account, '2451', amount, code));
const SALARIES = [pay('L7', '2026-07-27', 8602, 'Lohn Juli 2026'), pay('L8', '2026-08-25', 8602, 'Lohn August 2026')];
const salaryEntries = SALARIES.map((t) => entry(t.ref, t.date, '5000', '1020', 8602, undefined, { origin: 'manual', by: { kind: 'person', at: '2026-11-13T10:00:00Z' } }));
const REPAY = [pay('S7', '2026-07-31', 218.9, 'Spesen Juli 2026'), pay('S8', '2026-08-31', 112, 'Spesen August 2026'), pay('S9', '2026-09-30', 71.6, 'Spesen September 2026')];

/** A one-person GmbH whose owner is employed and pays business costs privately (the consultancy persona). */
function firm(withOutlays = true, extra: { transactions?: BankTransaction[]; journalEntries?: JournalEntry[]; closedThrough?: string; rules?: string } = {}): Workspace {
  const made = tempWorkspace('owner-402-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: [phone]\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, {
    transactions: [...SALARIES, ...REPAY, ...(withOutlays ? outlayTxs : []), ...(extra.transactions ?? [])],
    journalEntries: [...salaryEntries, ...(withOutlays ? outlayEntries : []), ...(extra.journalEntries ?? [])],
    config: { closedThrough: extra.closedThrough ?? '2026-06-30' },
  });
  if (extra.rules) { mkdirSync(join(ws.paths.root, 'knowledge', 'rules'), { recursive: true }); writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), extra.rules); }
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
    // What is open for each, after the earlier ones (on disk none is booked yet): each month's outlays.
    assert.deepEqual(start.nature, { kind: 'ownerOutlays', account: '2451', open: t.amount }, t.ref);
    assert.deepEqual(draft.lines.map(side), [['2451', '1020', '']], t.ref);
    assert.deepEqual(draft.lines[0].source, { account: { from: 'ownerOutlays' } }, t.ref);
    assert.equal(draft.precedent, undefined, `${t.ref}: no salary «wie bei derselben Firma»`);
    // Her click books the lines as they stand.
    books.journalEntries.push(...draft.lines.map((l, i) => entry(`${t.ref}-${i}`, t.date, l.accountDebit, l.accountCredit, l.amount, undefined, { transactionRef: t.ref, origin: 'manual', by: { kind: 'person', at: '2026-11-13T10:00:00Z' } })));
  }
  assert.equal(outlaysOpen(books, ownerFactsOf(context)!, '2026-12-31'), 0);
});

test('a salary\'s account is no precedent for a payment to the same person that is no wage', () => {
  const ws = firm(false);
  const books = loadBooks(ws);
  const { start, draft } = draftOf(ws, books, 'S7');
  assert.deepEqual(start.nature, { kind: 'ownerWaits', account: '2451', open: 0, owner: 'Lukas Beispiel' }, 'no outlays on his account: the form says what it waits for, and proposes as for any payment (#428)');
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
  assert.match(said.S8, /holds 112 CHF of outlays not paid back/, 'what is open after the July repayment');
  assert.equal(outlaysOpen(books, ownerFactsOf(context)!, '2026-12-31'), 0);
});

const disobedient: ClassifyDeps['ask'] = async (prompt) => {
  const out: Record<string, unknown> = {};
  for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
    out[part.split(/\s/)[0]] = { entries: [{ accountDebit: '5820', accountCredit: '', amount: Number(/Amount: ([\d.]+)/.exec(part)![1]), vat: 'none', description: 'Spesen' }] };
  }
  return JSON.stringify(out);
};
const intake = async (ws: Workspace, books: Books, ask: ClassifyDeps['ask']) => {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} });
};

test('the intake books a repayment only onto the owner\'s account: a model that puts it on an expense books nothing, and it does not wait for a receipt', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  await intake(ws, books, disobedient);
  for (const t of REPAY) {
    assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === t.ref), [], `${t.ref}: not booked on 5820`);
    assert.equal(books.transactions.find((x) => x.ref === t.ref)!.waitsForReceipt, undefined, `${t.ref}: no «wartet auf den Beleg»`);
  }
});

test('several repayments are covered in date order by what is still open after the earlier ones', () => {
  const out = (ref: string, date: string) => pay(ref, date, 100, 'Spesen');
  const ws = firm(false, {
    transactions: [pay('MX', '2026-07-05', 150, 'Beleg', { bank: 'manual', source: 'manual', counterparty: undefined }), out('R1', '2026-07-10'), out('R2', '2026-07-11'), out('R3', '2026-07-12')],
    journalEntries: [entry('MX', '2026-07-05', '6640', '2451', 150, 'I81')],
  });
  const books = loadBooks(ws);
  assert.deepEqual(['R1', 'R2', 'R3'].map((r) => wait(ws, books, r).wait), [false, true, true]);
});

test('a company rule for payments to the owner decides them as before: rent to the owner waits for its receipt', () => {
  const ws = firm(true, { rules: 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: miete-inhaber\n        when: { payer: "Lukas Beispiel", text: "Spesen" }\n        then: { account: "6000", vat: 81 }\n        source: wish 2026-11-13\n' });
  assert.deepEqual(wait(ws, loadBooks(ws), 'S7'), { wait: true });
});

test('outlays of December still open are paid back in January; the owner\'s split repayment counts by her account\'s line; a wage on her account is no outlay', () => {
  const ws = firm(false, {
    closedThrough: '2025-06-30',
    transactions: [
      pay('MD', '2025-12-15', 80, 'Beleg', { bank: 'manual', source: 'manual', counterparty: undefined }),
      pay('J1', '2026-01-10', 80, 'Spesen Dezember 2025'),
      pay('MK', '2026-02-03', 50, 'Beleg', { bank: 'manual', source: 'manual', counterparty: undefined }),
      pay('F1', '2026-02-20', 52, 'Spesen Februar 2026'),
      pay('F2', '2026-02-25', 40, 'Spesen Februar 2026'),
    ],
    journalEntries: [
      entry('MD', '2025-12-15', '6640', '2451', 80, 'I81'),
      entry('MK', '2026-02-03', '6640', '2451', 50, 'I81'),
      // A wage booked onto her account (expense / her account): no outlay.
      entry('LW', '2026-02-10', '5000', '2451', 500, undefined, { transactionRef: '' }),
      // February's repayment split by her: 50 onto her account, 2 bank fee.
      entry('F1', '2026-02-20', '2451', '1020', 50), { ...entry('F1', '2026-02-20', '6940', '1020', 2), id: 'e-F1-fee' },
    ],
  });
  const books = loadBooks(ws);
  assert.deepEqual(wait(ws, books, 'J1'), { wait: false, why: 'repaysOwner' }, 'December\'s outlay across the year');
  assert.equal(outlaysOpen(books, ownerFactsOf(loadClassifyContext(ws))!, '2026-02-28'), 80, 'December\'s 80 and February\'s 50, less the split repayment\'s 50; the wage counts nothing');
  assert.deepEqual(wait(ws, books, 'F2'), { wait: true }, 'nothing left open for a second one');
});

test('a repayment in a foreign currency proposes nothing, and the form says why', () => {
  const ws = firm(true, { transactions: [pay('EU', '2026-07-31', 100, 'Spesen', { currency: 'EUR', bank: 'Wise' })] });
  const { start, draft } = draftOf(ws, loadBooks(ws), 'EU');
  assert.deepEqual(start.nature, { kind: 'ownerForeign', currency: 'EUR' });
  assert.deepEqual(draft.lines.map(side), [['', '1021', '']]);
  assert.ok(draft.notes.some((n) => n.kind === 'ownerForeign'));
});

test('a pass over many payments reads the books for the owner\'s repayments once, and a payment not to her costs nothing', () => {
  const others = Array.from({ length: 2000 }, (_, i) => ({ ...pay(`X${i}`, '2026-08-01', 10 + i, 'Rechnung'), counterparty: `Lieferant ${i}` }));
  const ws = firm(true, { transactions: others });
  const books = loadBooks(ws);
  const context = loadClassifyContext(ws);
  const k = known(ws);
  const fx = loadFxResolver();
  const before = readingsMade();
  for (const t of books.transactions) receiptWaitOf(books, t, context, k, fx);
  assert.ok(readingsMade() - before <= 1, `${readingsMade() - before} readings for ${books.transactions.length} payments`);
});

test('every payment to her booked onto her account uses up what is open, covered or not: a repayment beyond it, a private draw', () => {
  const outlayAt = (ref: string, date: string, amount: number) => ({ tx: pay(ref, date, amount, 'Beleg', { bank: 'manual', source: 'manual', counterparty: undefined }), e: entry(ref, date, '6640', '2451', amount, 'I81') });
  const o1 = outlayAt('O1', '2026-07-02', 300);
  const o2 = outlayAt('O2', '2026-07-20', 200);
  const over = firm(false, {
    transactions: [o1.tx, o2.tx, pay('A', '2026-07-10', 400, 'Spesen'), pay('B', '2026-07-25', 200, 'Spesen')],
    journalEntries: [o1.e, o2.e, entry('A', '2026-07-10', '2451', '1020', 400)],
  });
  assert.deepEqual(wait(over, loadBooks(over), 'B'), { wait: true }, 'A took 400 of 300 open: 100 is left for B\'s 200');
  const draw = firm(false, {
    transactions: [o1.tx, pay('D', '2026-07-05', 5000, 'Privatbezug'), pay('C', '2026-07-30', 100, 'Spesen')],
    journalEntries: [o1.e, entry('D', '2026-07-05', '2451', '1020', 5000)],
  });
  assert.deepEqual(wait(draw, loadBooks(draw), 'C'), { wait: true }, 'her draw of 5000 used up the 300');
});

test('a repayment the model answered elsewhere is asked once; then it is hers, with a reason of its own on the form', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  let asked: string[] = [];
  const counting: ClassifyDeps['ask'] = async (prompt) => { asked.push(...[...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1])); return disobedient!(prompt, {} as never); };
  await intake(ws, books, counting);
  assert.deepEqual(asked.filter((r) => r.startsWith('S')).sort(), ['S7', 'S8', 'S9']);
  asked = [];
  await intake(ws, books, counting);
  assert.deepEqual(asked.filter((r) => r.startsWith('S')), [], 'not asked again');
  assert.deepEqual(judgedRepayments(ws).S7 !== undefined, true);
  writeIndex(ws, books);
  const { draft } = draftOf(ws, loadBooks(ws), 'S7');
  assert.ok(draft.notes.some((n) => n.kind === 'ownerOutlays' && n.judged), 'the form says the AI did not book it');
});

test('without a model, «Automatisch buchen» on a repayment says the AI is missing', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  const out = await ACTIONS['accounting.expenses.classification'].run!({ transaction: books.transactions.find((t) => t.ref === 'S7')!, books }, {}, { ws, now: () => '2026-11-13T08:00:00Z' } as never);
  assert.deepEqual(out, { outcome: 'undecided', output: { why: 'noModel' } });
});

test('a payment to the owner in a foreign currency without outlays open is a payment like any other', () => {
  const ws = firm(false, { transactions: [pay('EU0', '2026-07-31', 100, 'Spesen', { currency: 'EUR', bank: 'Wise' })] });
  assert.equal(draftOf(ws, loadBooks(ws), 'EU0').start.nature, undefined);
});
