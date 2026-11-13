/**
 * #428: the owner's repayments («Spesen Juli 2026») before and after her outlays are booked. Each
 * outlay comes as «Privat bezahlt» makes it: a private payment linked to its receipt, which the
 * same inbox run books. A repayment waits for those outlays, says so, and is booked by the run
 * that books its last outlay, in whatever order the outlays come; a click that books nothing says why.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { awaitsOutlays } from '../src/booking/receipt-wait.js';
import { classifyStep } from '../src/intake/classify.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { runResult, type RunDetail, type WorkflowDecl } from '../src/workflows/model.js';
import { countIssues, periodIssues, receiptWaits, unbookedOpen } from '../src/app/areas/automation/period-issues.js';
import { handStart } from '../src/saving/hand-rule.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks, type Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const OWNER = 'Lukas Beispiel';
const pay = (ref: string, date: string, amount: number, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty: OWNER, description, ...over });
// The six receipts he paid privately: two a month, each repayment their sum.
const OUTLAYS: Array<[string, string, number]> = [
  ['M2026-001', '2026-07-08', 72.4], ['M2026-002', '2026-07-15', 146.5],
  ['M2026-003', '2026-08-19', 58], ['M2026-004', '2026-08-12', 54],
  ['M2026-005', '2026-09-09', 53.6], ['M2026-006', '2026-09-16', 18],
];
const REPAY = [pay('S7', '2026-07-31', 218.9, 'Spesen Juli 2026'), pay('S8', '2026-08-31', 112, 'Spesen August 2026'), pay('S9', '2026-09-30', 71.6, 'Spesen September 2026')];

function firm(): Workspace {
  const made = tempWorkspace('owner-428-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: [phone]\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, { transactions: [...REPAY], journalEntries: [], config: { closedThrough: '2026-06-30' } });
  return ws;
}

/** A model that books what it is told: a repayment on her account when the prompt says it repays her outlays, else an expense; an outlay on an expense. */
const ask: ClassifyDeps['ask'] = async (prompt) => {
  const out: Record<string, unknown> = {};
  for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
    const ref = part.split(/\s/)[0];
    const amount = Number(/Amount: ([\d.]+)/.exec(part)![1]);
    const told = /Owner's outlays paid back: .* Book this payment on 2451/.test(part.split('\n\n')[0]);
    out[ref] = { entries: [{ accountDebit: ref.startsWith('M') ? '6640' : told ? '2451' : '5820', accountCredit: '', amount, vat: 'none', description: ref }] };
  }
  return JSON.stringify(out);
};

const intake = async (ws: Workspace, books: Books) => {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} });
};

/** «Als Auslage von … buchen» on receipt `i`: its private payment, linked; the next inbox run books it. */
function privately(books: Books, i: number): void {
  const [ref, date, amount] = OUTLAYS[i];
  books.transactions.push(pay(ref, date, amount, `Beleg ${ref}`, { bank: 'manual', source: 'manual', counterparty: undefined }));
  books.receipts.push({ id: `r-${ref}`, filename: `${ref}.pdf`, originalFilename: `${ref}.pdf`, extractedText: `Billett Total CHF ${amount}`, extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', date, amount });
  books.mappings.push({ transactionRef: ref, receiptId: `r-${ref}` });
}

const onHers = (books: Books) => REPAY.map((t) => books.journalEntries.filter((e) => e.transactionRef === t.ref).map((e) => `${e.accountDebit}/${e.accountCredit}`).join(','));

for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 3, 4, 5, 0, 1], [1, 2, 3, 4, 5, 0], [2, 0, 3, 4, 5, 1]]) {
  test(`three repayments against their outlays booked in the order ${order.join('')}: each booked by the run that books its last outlay, none left for a second click`, async () => {
    const ws = firm();
    const books = loadBooks(ws);
    await intake(ws, books);
    assert.deepEqual(onHers(books), ['', '', ''], 'no outlay booked yet: none is booked');
    for (const i of order) { privately(books, i); await intake(ws, books); }
    assert.deepEqual(onHers(books), ['2451/1020', '2451/1020', '2451/1020']);
  });
}

test('a repayment whose outlays are not booked waits for them, and every place says so, never «wartet auf ihren Beleg»', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  await intake(ws, books);
  const context = loadClassifyContext(ws);
  assert.ok(books.transactions.every((t) => t.waitsForReceipt), 'held, as before');
  assert.ok(REPAY.every((t) => awaitsOutlays(t, context)));
  const issues = periodIssues(books, [], '2026-07-01', '2026-09-30', ws.bankAccounts, undefined, '2026-10-05', undefined, undefined, OWNER);
  assert.deepEqual(issues.map((i) => i.kind === 'unbooked' && [i.tx.ref, !!i.waitsForReceipt, !!i.waitsForOutlays]), [['S7', false, true], ['S8', false, true], ['S9', false, true]]);
  const c = countIssues(issues);
  assert.deepEqual([c.unbooked, c.waitingReceipt, c.waitingOutlays], [3, 0, 3]);
  assert.deepEqual([...receiptWaits(books, ws.bankAccounts, '2026-10-05', OWNER)], [], 'no receipt of theirs is missing');
  assert.deepEqual(unbookedOpen(books, ws.bankAccounts, '2026-10-05', OWNER), { unbooked: 3, waitingReceipt: 0, waitingOutlays: 3, first: books.transactions[0] });
  // A supplier's payment without its receipt still waits for its receipt.
  const supplier = { ...pay('SUP', '2026-08-03', 80, 'Rechnung 17'), counterparty: 'Papeterie AG', waitsForReceipt: { since: '2026-08-04' } };
  const withSupplier = { ...books, transactions: [...books.transactions, supplier] };
  assert.deepEqual([...receiptWaits(withSupplier, ws.bankAccounts, '2026-10-05', OWNER)], ['SUP']);
});

test('«Automatisch buchen» on a repayment that books nothing says why: it waits for the outlays it pays back', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  await intake(ws, books);
  const t = books.transactions.find((x) => x.ref === 'S7')!;
  const out = await ACTIONS['accounting.expenses.classification'].run!({ transaction: t, books }, {}, { ws, ask, now: () => '2026-11-13T08:00:00Z' } as never);
  assert.deepEqual(out, { outcome: 'held', output: { why: 'waitsForOutlays' } });
  const run = { status: 'done', steps: [{ step: 'classify', output: { why: 'waitsForOutlays' } }], digest: { entries: 0 } } as unknown as RunDetail;
  assert.deepEqual(runResult({} as WorkflowDecl, run), { kind: 'done', entries: 0, left: 'waitsForOutlays' });
  assert.deepEqual(runResult({} as WorkflowDecl, { ...run, digest: { entries: 1 } } as RunDetail), { kind: 'done', entries: 1 }, 'a booking needs no reason');
});

test('the hand form of a repayment its outlays do not cover yet says what ends the wait', () => {
  const ws = firm();
  const books = loadBooks(ws);
  const start = handStart(ws, 'S7')!;
  assert.deepEqual(start.nature, { kind: 'ownerWaits', account: '2451', open: 0, owner: OWNER });
  const draft = bookingDraft(books, 'S7', ws.bankAccounts, [], { nature: start.nature! })!;
  assert.deepEqual(draft.notes.map((n) => n.kind), ['ownerWaits'], 'one note, and not «kein Vorschlag»');
});
