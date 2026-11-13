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
import { awaitsOutlays, outlayWaitsOf } from '../src/booking/receipt-wait.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
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

/** July's first outlay (72.40) booked over his account, as «Privat bezahlt» and the run book it: outlays are open, none of the repayments covered. */
function oneOutlay(books: Books): Books {
  books.transactions.push(pay('M2026-001', '2026-07-08', 72.4, 'Beleg M2026-001', { bank: 'manual', source: 'manual', counterparty: undefined }));
  books.journalEntries.push({ id: 'e-M1', transactionRef: 'M2026-001', date: '2026-07-08', accountDebit: '6640', accountCredit: '2451', amount: 72.4, vatCode: 'I81', origin: 'classify' } as never);
  return books;
}

test('a repayment waits for outlays only while outlays are open and no rule or wage decides it; then every place says so, never «wartet auf ihren Beleg»', async () => {
  const ws = firm();
  mkdirSync(join(ws.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: miete-inhaber\n        when: { payer: "Lukas Beispiel", text: "Miete" }\n        then: { account: "6000", vat: 81 }\n        source: wish 2026-11-13\n');
  const books = loadBooks(ws);
  books.transactions.push(pay('RENT', '2026-08-01', 1200, 'Miete Büro August'));
  await intake(ws, books);
  assert.ok(books.transactions.filter((t) => t.ref.startsWith('S') || t.ref === 'RENT').every((t) => t.waitsForReceipt), 'held, as before');
  assert.deepEqual(outlayWaitsOf(ws, books), [], 'no outlay booked yet: they wait for a receipt as any payment');
  oneOutlay(books);
  const outlays = new Set(outlayWaitsOf(ws, books));
  assert.deepEqual([...outlays], ['S7', 'S8', 'S9'], 'the rent a rule decides waits for its contract, not for outlays');
  const context = loadClassifyContext(ws);
  assert.equal(awaitsOutlays(books, books.transactions.find((t) => t.ref === 'RENT')!, context, [], loadFxResolver()), false);
  const issues = periodIssues(books, [], '2026-07-01', '2026-09-30', ws.bankAccounts, undefined, '2026-10-05', undefined, undefined, outlays);
  const unbooked = issues.flatMap((i) => (i.kind === 'unbooked' ? [[i.tx.ref, !!i.waitsForReceipt, !!i.waitsForOutlays]] : []));
  assert.deepEqual(unbooked, [['S7', false, true], ['RENT', true, false], ['S8', false, true], ['S9', false, true]]);
  const c = countIssues(issues);
  assert.deepEqual([c.unbooked, c.waitingReceipt, c.waitingOutlays], [4, 1, 3]);
  assert.deepEqual([...receiptWaits(books, ws.bankAccounts, '2026-10-05', outlays)], ['RENT'], 'only the rent misses a receipt');
  assert.deepEqual(unbookedOpen(books, ws.bankAccounts, '2026-10-05', outlays).waitingOutlays, 3);
});

test('«Automatisch buchen» on a repayment that books nothing says why: it waits for the outlays it pays back', async () => {
  const ws = firm();
  const books = loadBooks(ws);
  await intake(ws, books);
  const t = books.transactions.find((x) => x.ref === 'S7')!;
  const run = async () => ACTIONS['accounting.expenses.classification'].run!({ transaction: t, books }, {}, { ws, ask, now: () => '2026-11-13T08:00:00Z' } as never);
  assert.deepEqual(await run(), { outcome: 'held', output: { why: 'waitsForReceipt' } }, 'no outlay open: its receipt');
  oneOutlay(books);
  assert.deepEqual(await run(), { outcome: 'held', output: { why: 'waitsForOutlays' } });
  const done = { status: 'done', steps: [{ step: 'classify', output: { why: 'waitsForOutlays' } }], digest: { entries: 0 } } as unknown as RunDetail;
  assert.deepEqual(runResult({} as WorkflowDecl, done), { kind: 'done', entries: 0, left: 'waitsForOutlays' });
  assert.deepEqual(runResult({} as WorkflowDecl, { ...done, digest: { entries: 1 } } as RunDetail), { kind: 'done', entries: 1 }, 'a booking needs no reason');
});

test('the hand form of a repayment its outlays do not cover yet says what ends the wait', () => {
  const ws = firm();
  assert.equal(handStart(ws, 'S7')!.nature, undefined, 'no outlay open: a payment like any other');
  const books = oneOutlay(loadBooks(ws));
  writeIndex(ws, books);
  const start = handStart(ws, 'S7')!;
  assert.deepEqual(start.nature, { kind: 'ownerWaits', account: '2451', open: 72.4, owner: OWNER });
  const draft = bookingDraft(books, 'S7', ws.bankAccounts, [], { nature: start.nature! })!;
  assert.deepEqual(draft.notes.map((n) => n.kind), ['ownerWaits'], 'one note, and not «kein Vorschlag»');
});
