/**
 * An account's movements read from statement PDFs set against its bank export or CSV, once and as a
 * whole (#254), with invented data. The probes of the review of the per-line «Ist das dieselbe
 * Zahlung?» each counted a payment twice; here each is a case of one reconciliation:
 * - code proposes only pairs beyond doubt, never two payees that differ; the person names every other
 *   read movement, and until she confirms no run books any movement of it and no period of its days closes;
 * - a confirmed pair leaves one movement with one booking; a payment of its own is booked once;
 * - a filed read movement never changes; its bank twin books nothing but a difference, to an account
 *   of the chart the person names when the chart lacks the exchange-difference account;
 * - every movement takes part once: the next import asks nothing again.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStatementXml } from '../src/providers/statement-read/camt-writer.js';
import { readCamt } from '../src/providers/camt053/camt053.js';
import { mergeIndex, transactionsOfFiles } from '../src/books/bank-import.js';
import { heldByReconciliation, openReconciliations, pending, propose, reconcilePendingThrough, type StatementSides } from '../src/books/reconcile.js';
import { bookedInFiled } from '../src/books/twins.js';
import { differenceAccountOf } from '../src/books/year-close.js';
import { isUnbooked, unbookedPayments } from '../src/app/areas/bank/model.js';
import { unbookedPayments as paymentsToAttach } from '../src/app/areas/journal/model.js';
import { bookedAgain, deleteEntry } from '../src/server/edits.js';
import { confirm, ReconcileRefused, type Decision } from '../src/server/reconcile.js';
import { closeThrough, periodLock, type Books } from '../src/books/store.js';
import { Refused } from '../src/types/refusal.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { ACTIONS } from '../src/workflows/actions.js';
import type { StatementFile } from '../src/workspace/bank-statements.js';
import type { ReadMovement, ReadStatement } from '../src/types/statement-read.js';
import type { BankTransaction, JournalEntry, Reconciliation, StatementAsk } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

const account = { account: '1021', bank: 'Musterbank', currency: 'CHF', label: 'Musterbank', statements: 'camt053' as const, role: 'bank' as const };
const fileOf = (file: string, xml: string): Extract<StatementFile, { status: 'read' }> => ({ status: 'read', file, statement: readCamt(xml).statements[0], account, by: 'iban' });
const statement = (movements: ReadMovement[]): ReadStatement => ({
  iban: 'CH6580808000000000001', currency: 'CHF', period: { from: '2026-04-01', to: '2026-04-30' },
  opening: { date: '2026-04-01', amount: 1000 }, closing: { date: '2026-04-30', amount: Math.round((1000 + movements.reduce((n, m) => n + m.amount, 0)) * 100) / 100 }, movements,
});
const readFile = (movements: ReadMovement[]) => fileOf('Musterbank/r.xml', toStatementXml(statement(movements), { id: 'read-r', source: 'r.pdf', by: 'model' }));
const bankFile = (movements: ReadMovement[]) => fileOf('Musterbank/bank.xml', toStatementXml(statement(movements), { id: 'BANK', source: 'b', by: 'model' }).replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>\n/, ''));

const move = (ref: string, date: string, amount: number, o: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Musterbank', currency: 'CHF', date, direction: amount < 0 ? 'DBIT' : 'CRDT', amount: Math.abs(amount), description: 'Zahlung', ...o } as BankTransaction);
const entry = (id: string, transactionRef: string, date: string, amount: number, o: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef, date, accountDebit: '6000', accountCredit: '1021', amount, description: id, origin: 'classify', ...o } as JournalEntry);
const booksOf = (closedThrough: string, transactions: BankTransaction[], journalEntries: JournalEntry[] = []) =>
  ({ config: { closedThrough }, receipts: [], bankStatements: [], mappings: [], transactions, journalEntries } as unknown as Books);
/** The statement files' word on the books: `read` only PDFs bring, `bank` only the bank's file, which covers `span`. */
const sides = (read: string[], bank: string[], span: { from: string; to: string }): StatementSides =>
  ({ pdf: new Set(read), structured: new Set(bank), both: new Set(), spans: [{ account: '1021', ...span }] });
const open = (books: Books, s: StatementSides, differenceTo?: string) => openReconciliations(books, s, () => '1021', '2026-10-28', differenceTo);
const ctx = (books: Books, chart = ['1021', '6000', '6940', '6960']) => ({ rateOf: () => undefined, isClosed: periodLock(books).isClosed, chart: new Set(chart), bankOf: () => '1021', today: '2026-10-28' });
const answer = (books: Books, d: Decision, chart?: string[]) => confirm(books, pending(books)[0], d, ctx(books, chart));
const bookings = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref);

test('equal amounts on one day: each read line goes to the bank movement of its payee, whatever the files\' order', () => {
  const read = readFile([
    { date: '2026-04-10', amount: -50, counterparty: 'Beta GmbH', text: 'Rechnung Beta' },
    { date: '2026-04-10', amount: -50, counterparty: 'Alpha AG', text: 'Rechnung Alpha' },
  ]);
  const bank = bankFile([
    { date: '2026-04-10', amount: -50, counterparty: 'Alpha AG', text: 'Alpha AG Zahlung' },
    { date: '2026-04-10', amount: -50, counterparty: 'Beta GmbH', text: 'Beta GmbH Zahlung' },
  ]);
  const both = transactionsOfFiles([bank, read]);
  assert.equal(both.length, 2, 'nothing doubled');
  assert.deepEqual(both.map((t) => [t.counterparty, t.ref]), [['Alpha AG', 'read-r#2'], ['Beta GmbH', 'read-r#1']], 'the read\'s ref, and with it its bookings, follows the payee');
});

test('a tie stays apart in the files and in the proposal: a read line that names no payee, between two bank movements of that day that differ, is the person\'s to name', () => {
  const read = readFile([{ date: '2026-04-10', amount: -50, text: 'Zahlung' }]);
  const bank = bankFile([{ date: '2026-04-10', amount: -50, counterparty: 'Alpha AG' }, { date: '2026-04-10', amount: -50, counterparty: 'Beta GmbH' }]);
  const all = transactionsOfFiles([bank, read]);
  assert.equal(all.length, 3, 'no file order decides');
  const [b1, b2, r] = all;
  assert.deepEqual(propose([r], [b1, b2]), [], 'nothing proposed');
});

test('probe: Amazon read from the PDF, AMZN at the bank two days later and Galaxus closer on the same day: nothing booked until confirmed, then each once', () => {
  const amazon = move('P-amazon', '2026-10-03', -20, { counterparty: 'Amazon' });
  const amzn = move('B-amzn', '2026-10-05', -20, { counterparty: 'AMZN Mktp DE' });
  const galaxus = move('B-galaxus', '2026-10-03', -20, { counterparty: 'Galaxus' });
  const books = booksOf('2026-09-30', [amazon, amzn, galaxus], [entry('app-amazon', 'P-amazon', '2026-10-03', 20)]);
  open(books, sides(['P-amazon'], ['B-amzn', 'B-galaxus'], { from: '2026-10-01', to: '2026-10-31' }));
  const r = pending(books)[0];
  assert.deepEqual([r.read, r.bank, r.pairs], [['P-amazon'], ['B-amzn', 'B-galaxus'], []], 'two payees that differ are never proposed, however close');
  assert.deepEqual([...heldByReconciliation(books)].sort(), ['B-amzn', 'B-galaxus', 'P-amazon'], 'neither bank movement is booked by a run meanwhile');
  assert.throws(() => answer(books, { pairs: [], own: [] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileUndecided', 'no default for the read movement');
  answer(books, { pairs: [{ read: 'P-amazon', bank: 'B-amzn' }], own: [] });
  assert.deepEqual(books.transactions.map((t) => t.ref), ['B-amzn', 'B-galaxus'], 'the read movement is the bank\'s');
  assert.deepEqual(bookings(books, 'B-amzn').map((e) => [e.id, e.date]), [['app-amazon', '2026-10-05']], 'its booking moved to the bank\'s movement and day');
  assert.equal(heldByReconciliation(books).size, 0, 'Galaxus is free: a payment of its own, booked once by the run');
});

test('probe: 20.00 read, 21.50 at the bank: no proposal; paired, the bank\'s amount is booked once; a person\'s booking of the read amount refuses until changed', () => {
  const read = move('P', '2026-10-06', -20, { counterparty: 'Muster Kiosk' });
  const bank = move('B', '2026-10-06', -21.5, { counterparty: 'Muster Kiosk' });
  const books = booksOf('2026-09-30', [read, bank], [entry('hers', 'P', '2026-10-06', 20, { origin: 'manual' })]);
  open(books, sides(['P'], ['B'], { from: '2026-10-01', to: '2026-10-31' }));
  assert.deepEqual(pending(books)[0].pairs, [], 'too far off for a proposal: the person names it');
  assert.throws(() => answer(books, { pairs: [{ read: 'P', bank: 'B' }], own: [] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'twinBookedByHand');
  assert.ok(books.transactions.some((t) => t.ref === 'P') && pending(books).length === 1, 'refused: nothing changed');
  books.journalEntries = [entry('app', 'P', '2026-10-06', 20)];
  answer(books, { pairs: [{ read: 'P', bank: 'B' }], own: [] });
  assert.deepEqual([books.transactions.map((t) => t.ref), books.journalEntries], [['B'], []], 'the read amount\'s booking goes; the run books the bank\'s 21.50 once');
});

test('probe: the weekly cleaner, 150 filed on 29.09 and 150 at the bank on 06.10: proposed, not decided; «Eigene Zahlung» books the bank\'s, the filed side stays; until then Q4 does not close', () => {
  const filed = move('P-0929', '2026-09-29', -150, { counterparty: 'Reinigung Muster' });
  const next = move('B-1006', '2026-10-06', -150, { counterparty: 'Reinigung Muster' });
  const books = booksOf('2026-09-30', [filed, next], [entry('q3', 'P-0929', '2026-09-29', 150)]);
  open(books, sides(['P-0929'], ['B-1006'], { from: '2026-10-01', to: '2026-10-31' }));
  const r = pending(books)[0];
  assert.deepEqual([r.from, r.to, r.pairs], ['2026-09-29', '2026-10-06', [{ read: 'P-0929', bank: 'B-1006' }]], 'the filed line before the export\'s days takes part');
  assert.throws(() => closeThrough(books, '2026-12-31'), (e: unknown) => e instanceof Refused && e.why.code === 'reconcilePending' && e.why.params.payment === 'B-1006', 'the close names where it is answered');
  const before = structuredClone(filed);
  answer(books, { pairs: [], own: ['P-0929'] });
  assert.deepEqual(books.transactions.find((t) => t.ref === 'P-0929'), before, 'the filed movement never changes');
  assert.deepEqual([heldByReconciliation(books).size, bookedInFiled(next), bookings(books, 'B-1006')], [0, false, []], 'the bank\'s is a payment of its own, booked by the run');
  closeThrough(books, '2026-12-31');
  assert.equal(books.config.closedThrough, '2026-12-31');
});

test('probe: a filed read line of 29.09 and the camt.053 from 01.10 holding it on 01.10 for 5 Rappen more: paired, marked as booked in the filed quarter, only the difference booked, to an account of the chart', () => {
  const filed = move('P', '2026-09-29', -120, { counterparty: 'Alpha AG' });
  const bank = move('B', '2026-10-01', -120.05, { counterparty: 'Alpha AG' });
  const books = booksOf('2026-09-30', [filed, bank], [entry('q3', 'P', '2026-09-29', 120)]);
  const ws = workspaceAt(DEMO_ROOT);
  const proposed = differenceAccountOf(ws);
  assert.equal(proposed, undefined, 'the demo\'s chart has 6940, not 6960: nothing proposed that the chart lacks');
  open(books, sides(['P'], ['B'], { from: '2026-10-01', to: '2026-10-31' }), proposed);
  assert.deepEqual(pending(books)[0].pairs, [{ read: 'P', bank: 'B' }]);
  const demoChart = ['1021', '6000', '6940'];
  assert.throws(() => answer(books, { pairs: [{ read: 'P', bank: 'B' }], own: [] }, demoChart), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileDifference', 'no account: refused');
  assert.throws(() => answer(books, { pairs: [{ read: 'P', bank: 'B', account: '6960' }], own: [] }, demoChart), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileDifference', 'one the chart lacks: refused');
  const before = structuredClone(books.transactions[0]);
  answer(books, { pairs: [{ read: 'P', bank: 'B', account: '6940' }], own: [] }, demoChart);
  assert.deepEqual(books.transactions[0], before, 'the filed read movement stays as filed');
  assert.deepEqual(bank.waitsForPerson && { ...bank.waitsForPerson, since: '' }, { since: '', why: 'filedTwin', read: 'P' }, 'the bank\'s names the filed movement it is');
  assert.deepEqual(bookings(books, 'B').map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [['2026-10-01', '6940', '1021', 0.05, undefined]], 'only the 5 Rappen, without VAT');
  assert.deepEqual(books.reconciliations?.[0].pairs, [{ read: 'P', bank: 'B', account: '6940' }]);
});

test('a bank movement booked in a filed quarter as a read one is booked everywhere: not unbooked in Bank, Aufgaben or a new entry\'s payments; no booking takes its mark, nor a deleted difference line', () => {
  const t = move('B', '2026-10-01', -120.3, { counterparty: 'Alpha AG', waitsForPerson: { since: '2026-10-28T10:00:00Z', why: 'filedTwin', read: 'P' } });
  const books = booksOf('2026-09-30', [move('P', '2026-09-29', -120, { counterparty: 'Alpha AG' }), t], [entry('diff', 'B', '2026-10-01', 0.3, { accountDebit: '6940', origin: 'manual' })]);
  const accounts = [account];
  assert.equal(isUnbooked(books, accounts)(t), false, 'Bank: booked');
  assert.deepEqual(unbookedPayments(books, accounts).map((x) => x.ref), [], 'Aufgaben: nothing to book');
  assert.deepEqual(paymentsToAttach(books, '', undefined, accounts).map((x) => x.ref), [], 'Buchungen › N: not offered');
  bookedAgain(books, 'B');
  assert.ok(bookedInFiled(t), 'a booking path keeps the mark');
  deleteEntry(books, 'diff');
  assert.ok(bookedInFiled(t), 'its difference line deleted, it is still booked there');
});

test('who takes part: a read movement on the bank file\'s days or within seven days of a bank movement, and every bank movement within seven days of those; a far one waits for its own file', () => {
  const books = booksOf('2026-09-30', [
    move('P-in', '2026-10-12', -10), move('P-edge', '2026-09-27', -30), move('P-far', '2026-11-20', -40),
    move('B-1', '2026-10-01', -30), move('B-2', '2026-10-12', -10), move('B-3', '2026-10-25', -99),
  ]);
  open(books, sides(['P-in', 'P-edge', 'P-far'], ['B-1', 'B-2', 'B-3'], { from: '2026-10-01', to: '2026-10-31' }));
  const r = pending(books)[0];
  assert.deepEqual([r.read, r.bank, r.from, r.to], [['P-in', 'P-edge'], ['B-1', 'B-2'], '2026-09-27', '2026-10-12']);
  assert.deepEqual(r.pairs, [{ read: 'P-in', bank: 'B-2' }, { read: 'P-edge', bank: 'B-1' }], 'the same day first, then the same amount within seven days');
  open(books, sides(['P-in', 'P-edge', 'P-far'], ['B-1', 'B-2', 'B-3'], { from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(pending(books)[0].since, '2026-10-28', 'opened again with the same movements: kept as it was');
});

test('every movement takes part once: confirmed, the next import opens nothing for it, and its read row brings nothing back', () => {
  const books = booksOf('2026-09-30', [move('P', '2026-10-03', -60, { counterparty: 'Beta GmbH' }), move('B', '2026-10-04', -60, { counterparty: 'Beta GmbH' }), move('P-own', '2026-10-09', -5)]);
  const s = sides(['P', 'P-own'], ['B'], { from: '2026-10-01', to: '2026-10-31' });
  open(books, s);
  answer(books, { pairs: [{ read: 'P', bank: 'B' }], own: ['P-own'] });
  open(books, s);
  assert.deepEqual([pending(books), heldByReconciliation(books).size], [[], 0], 'nothing asked again');
  const merged = mergeIndex(books, { receipts: [], bankTransactions: [move('P', '2026-10-03', -60), move('B', '2026-10-04', -60), move('P-own', '2026-10-09', -5)], wiseRefs: new Map(), bankStatements: [], camtBalances: [] });
  assert.deepEqual(merged.index.transactions.map((t) => t.ref).sort(), ['B', 'P-own'], 'the paired read row is the bank\'s movement; a payment of its own stays');
});

test('a waiting reconciliation goes when its read movements go (the bank\'s file taken back)', () => {
  const books = booksOf('2026-09-30', [move('P', '2026-10-03', -60), move('B', '2026-10-03', -60.2)]);
  open(books, sides(['P'], ['B'], { from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(pending(books).length, 1);
  open(books, { pdf: new Set(['P']), structured: new Set(), both: new Set(), spans: [] });
  assert.equal(books.reconciliations, undefined);
});

test('the run books no movement of a waiting reconciliation', async () => {
  const ws = workspaceAt(DEMO_ROOT);
  const bank = { ...move('B-in', '2026-10-13', 1199.5), bank: 'Raiffeisen' } as BankTransaction;
  const books = { ...booksOf('2026-03-31', [{ ...move('P-in', '2026-10-11', 1200), bank: 'Raiffeisen' }, bank]), reconciliations: [{ account: '1021', from: '2026-10-11', to: '2026-10-13', since: '2026-10-28', read: ['P-in'], bank: ['B-in'], pairs: [] } satisfies Reconciliation] } as Books;
  const out = await ACTIONS['accounting.expenses.classification'].run!({ transaction: bank, books }, {}, { ws } as never);
  assert.deepEqual([out.outcome, (out as { output?: { why?: string } }).output?.why], ['held', 'reconcile']);
});

test('closing a period closes the statement questions of its days, and waits for a reconciliation whose first day it holds', () => {
  const ask = (file: string, date: string) => ({ file, account: '1021', date, since: '2026-10-01', read: {} } as StatementAsk);
  const books = { config: {}, transactions: [], journalEntries: [], statementAsks: [ask('a.pdf', '2026-09-30'), ask('b.pdf', '2026-10-31')] } as unknown as Books;
  closeThrough(books, '2026-09-30');
  assert.deepEqual([books.config.closedThrough, books.statementAsks?.map((a) => a.file)], ['2026-09-30', ['b.pdf']]);
  books.reconciliations = [{ account: '1021', from: '2026-12-28', to: '2027-01-04', since: '2027-01-05', read: ['P'], bank: ['B'], pairs: [] }];
  assert.equal(reconcilePendingThrough(books, '2026-12-27'), undefined, 'a period before its first day closes');
  assert.throws(() => closeThrough(books, '2026-12-31'), (e: unknown) => e instanceof Refused && e.why.code === 'reconcilePending' && e.why.params.through === '2026-12-31');
  assert.equal(books.config.closedThrough, '2026-09-30', 'nothing closed');
});
