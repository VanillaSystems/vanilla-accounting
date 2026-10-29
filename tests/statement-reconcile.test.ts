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
import { confirm, lostWithFile, ReconcileRefused, releaseTwins, type Decision } from '../src/server/reconcile.js';
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
const open = (books: Books, s: StatementSides, differenceTo?: string) => openReconciliations(books, s, () => '1021', '2026-10-28', periodLock(books).isClosed, differenceTo);
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

test('probe: the weekly cleaner, 150 filed on 29.09 and 150 at the bank on 06.10: proposed, not decided; left apart, the bank\'s is booked, the filed side stays and is not asked again; until then Q4 does not close', () => {
  const filed = move('P-0929', '2026-09-29', -150, { counterparty: 'Reinigung Muster' });
  const next = move('B-1006', '2026-10-06', -150, { counterparty: 'Reinigung Muster' });
  const books = booksOf('2026-09-30', [filed, next], [entry('q3', 'P-0929', '2026-09-29', 150)]);
  open(books, sides(['P-0929'], ['B-1006'], { from: '2026-10-01', to: '2026-10-31' }));
  const r = pending(books)[0];
  assert.deepEqual([r.from, r.to, r.pairs], ['2026-09-29', '2026-10-06', [{ read: 'P-0929', bank: 'B-1006' }]], 'the filed line before the export\'s days takes part');
  assert.throws(() => closeThrough(books, '2026-12-31'), (e: unknown) => e instanceof Refused && e.why.code === 'reconcilePending' && e.why.params.payment === 'B-1006', 'the close names where it is answered');
  const before = structuredClone(filed);
  assert.throws(() => answer(books, { pairs: [], own: ['P-0929'] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileNotCovered', 'no day of the export: never «Eigene Zahlung»');
  answer(books, { pairs: [], own: [] });
  assert.deepEqual(books.transactions.find((t) => t.ref === 'P-0929'), before, 'the filed movement never changes');
  open(books, sides(['P-0929'], ['B-1006'], { from: '2026-10-01', to: '2026-10-31' }));
  assert.deepEqual(pending(books), [], 'set against the bank\'s once: not asked again');
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
  const merged = mergeIndex(books, { receipts: [], bankTransactions: [move('P', '2026-10-03', -60), move('B', '2026-10-04', -60), move('P-own', '2026-10-09', -5)], reads: [], bankStatements: [], camtBalances: [] });
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
  const books = { ...booksOf('2026-03-31', [{ ...move('P-in', '2026-10-11', 1200), bank: 'Raiffeisen' }, bank]), reconciliations: [{ account: '1021', from: '2026-10-11', to: '2026-10-13', since: '2026-10-28', covered: [{ from: '2026-10-01', to: '2026-10-31' }], read: ['P-in'], bank: ['B-in'], pairs: [] } satisfies Reconciliation] } as Books;
  const out = await ACTIONS['accounting.expenses.classification'].run!({ transaction: bank, books }, {}, { ws } as never);
  assert.deepEqual([out.outcome, (out as { output?: { why?: string } }).output?.why], ['held', 'reconcile']);
});

test('closing a period closes the statement questions of its days, and waits for a reconciliation whose first day it holds', () => {
  const ask = (file: string, date: string) => ({ file, account: '1021', date, since: '2026-10-01', read: {} } as StatementAsk);
  const books = { config: {}, transactions: [], journalEntries: [], statementAsks: [ask('a.pdf', '2026-09-30'), ask('b.pdf', '2026-10-31')] } as unknown as Books;
  closeThrough(books, '2026-09-30');
  assert.deepEqual([books.config.closedThrough, books.statementAsks?.map((a) => a.file)], ['2026-09-30', ['b.pdf']]);
  books.reconciliations = [{ account: '1021', from: '2026-12-28', to: '2027-01-04', since: '2027-01-05', covered: [{ from: '2027-01-01', to: '2027-01-31' }], read: ['P'], bank: ['B'], pairs: [] }];
  assert.equal(reconcilePendingThrough(books, '2026-12-27'), undefined, 'a period before its first day closes');
  assert.throws(() => closeThrough(books, '2026-12-31'), (e: unknown) => e instanceof Refused && e.why.code === 'reconcilePending' && e.why.params.through === '2026-12-31');
  assert.equal(books.config.closedThrough, '2026-09-30', 'nothing closed');
});

/** The statement files' word on the books with several bank files: `spans` the days each covers. */
const sidesOf = (read: string[], bank: string[], ...spans: { from: string; to: string }[]): StatementSides =>
  ({ pdf: new Set(read), structured: new Set(bank), both: new Set(), spans: spans.map((s) => ({ account: '1021', ...s })) });

test('review: a read movement past the bank file\'s last day is only a candidate: never «Eigene Zahlung»; left apart, the export of its day decides it, and pairs it with that export\'s movement', () => {
  const books = booksOf('2026-09-30', [move('P-1003', '2026-10-03', -12), move('P-1103', '2026-11-03', -80, { counterparty: 'Beta GmbH' }), move('B-1003', '2026-10-03', -12), move('B-1031', '2026-10-31', -80, { counterparty: 'Alpha AG' })]);
  const october = { from: '2026-10-01', to: '2026-10-31' };
  open(books, sidesOf(['P-1003', 'P-1103'], ['B-1003', 'B-1031'], october));
  const r = pending(books)[0];
  assert.deepEqual([r.covered, r.read, r.pairs], [[october], ['P-1003', 'P-1103'], [{ read: 'P-1003', bank: 'B-1003' }]], 'the covered days are recorded; 03.11 takes part only as a candidate');
  assert.throws(() => answer(books, { pairs: [{ read: 'P-1003', bank: 'B-1003' }], own: ['P-1103'] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileNotCovered');
  answer(books, { pairs: [{ read: 'P-1003', bank: 'B-1003' }], own: [] });
  assert.deepEqual(books.reconciliations?.[0].own, undefined, 'nothing named a payment of its own');
  // The November export comes, holding the payment of 03.11.
  books.transactions.push(move('B-1103', '2026-11-03', -80, { counterparty: 'Beta GmbH' }));
  open(books, sidesOf(['P-1103'], ['B-1031', 'B-1103'], october, { from: '2026-11-01', to: '2026-11-30' }));
  const next = pending(books)[0];
  assert.ok(next, 'a new reconciliation for the days the new file covers');
  assert.deepEqual([next.read, next.pairs], [['P-1103'], [{ read: 'P-1103', bank: 'B-1103' }]], 'the read movement is decided by the export of its day: one payment');
  answer(books, { pairs: [{ read: 'P-1103', bank: 'B-1103' }], own: [] });
  assert.deepEqual(books.transactions.map((t) => t.ref).sort(), ['B-1003', 'B-1031', 'B-1103'], 'each payment once');
});

test('review: a bank movement left unpaired stays free: a movement read later for its day is set against it', () => {
  const books = booksOf('2026-09-30', [move('P-1025', '2026-10-25', -7), move('B-1030', '2026-10-30', -45, { counterparty: 'Alpha AG' })]);
  const october = { from: '2026-10-01', to: '2026-10-31' };
  open(books, sidesOf(['P-1025'], ['B-1030'], october));
  answer(books, { pairs: [], own: ['P-1025'] });
  // Another PDF of October read later brings the payment of 29.10.
  books.transactions.push(move('P-1029', '2026-10-29', -45, { counterparty: 'Alpha AG' }));
  open(books, sidesOf(['P-1025', 'P-1029'], ['B-1030'], october));
  const r = pending(books)[0];
  assert.deepEqual([r?.read, r?.bank, r?.pairs], [['P-1029'], ['B-1030'], [{ read: 'P-1029', bank: 'B-1030' }]], 'the unpaired bank movement takes part again; the decided read one does not');
});

test('review: a year\'s export and PDFs read for February and November: only the bank movements near the read ones are held, not the months between', () => {
  const year = { from: '2026-01-01', to: '2026-12-31' };
  const books = booksOf('2025-12-31', [move('P-0210', '2026-02-10', -30), move('P-1110', '2026-11-10', -40), move('B-0211', '2026-02-11', -30), move('B-0615', '2026-06-15', -99), move('B-1110', '2026-11-10', -40)]);
  open(books, sidesOf(['P-0210', 'P-1110'], ['B-0211', 'B-0615', 'B-1110'], year));
  const r = pending(books)[0];
  assert.deepEqual([r.bank, [...heldByReconciliation(books)].includes('B-0615')], [['B-0211', 'B-1110'], false], 'June is booked as any');
});

test('review: a pair of another direction or currency is refused', () => {
  const october = { from: '2026-10-01', to: '2026-10-31' };
  const books = booksOf('2026-09-30', [move('P', '2026-10-05', -100), move('Q', '2026-10-05', 100), move('B', '2026-10-05', 100)]);
  open(books, sidesOf(['P', 'Q'], ['B'], october));
  assert.deepEqual(pending(books)[0].pairs, [{ read: 'Q', bank: 'B' }], 'only the same direction proposed');
  assert.throws(() => answer(books, { pairs: [{ read: 'P', bank: 'B' }], own: ['Q'] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileMismatch', '−100 read is not +100 at the bank');
  const usd = booksOf('2026-09-30', [move('P', '2026-10-05', -100), move('Q', '2026-10-05', -100, { currency: 'USD' }), move('B', '2026-10-05', -100, { currency: 'USD' })]);
  open(usd, sidesOf(['P', 'Q'], ['B'], october));
  assert.throws(() => answer(usd, { pairs: [{ read: 'P', bank: 'B' }], own: ['Q'] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileMismatch', 'CHF read is not USD at the bank');
  assert.equal(usd.transactions.length, 3, 'nothing changed');
});

test('review: the run names the payments a reconciliation holds, never «0 gebucht» alone; its result carries them', async () => {
  const { unbooked } = await import('../src/workflows/actions.js');
  const { runResult } = await import('../src/workflows/model.js');
  const waiting: Reconciliation = { account: '1021', from: '2026-10-11', to: '2026-10-13', since: '2026-10-28', covered: [{ from: '2026-10-01', to: '2026-10-31' }], read: ['P-in'], bank: ['B-in'], pairs: [] };
  const books = { ...booksOf('2026-09-30', [move('P-in', '2026-10-11', -30), move('B-in', '2026-10-13', -30), move('X', '2026-10-20', -5)]), reconciliations: [waiting] } as Books;
  const took = unbooked(books);
  assert.deepEqual(took, [{ kind: 'transactions', n: 1 }, { kind: 'held', account: '1021', n: 2, payment: 'P-in', date: '2026-10-11' }]);
  const res = runResult({ id: 'inbox' } as never, { status: 'done', digest: { entries: 0 }, steps: [{ output: { took } }] } as never);
  assert.deepEqual(res, { kind: 'done', entries: 0, held: [took[1]] });
});

test('a filed bank movement not booked there and an open read one of its amount: never proposed, refused paired; left apart, the read payment keeps its booking and receipt', () => {
  const filed = move('B-0928', '2026-09-28', -80, { counterparty: 'Alpha AG' });
  const read = move('P-1002', '2026-10-02', -80, { counterparty: 'Alpha AG' });
  const books = booksOf('2026-09-30', [filed, read], [entry('app', 'P-1002', '2026-10-02', 80)]);
  books.mappings.push({ receiptId: 'r-alpha', transactionRef: 'P-1002' } as never);
  open(books, sides(['P-1002'], ['B-0928'], { from: '2026-09-01', to: '2026-09-30' }));
  const r = pending(books)[0];
  assert.deepEqual([r.read, r.bank, r.pairs], [['P-1002'], ['B-0928'], []], 'the same amount within seven days, yet not proposed: confirmed, the payment would be lost');
  assert.throws(() => answer(books, { pairs: [{ read: 'P-1002', bank: 'B-0928' }], own: [] }), (e: unknown) => e instanceof ReconcileRefused && e.code === 'reconcileFiledUnbooked' && e.params.bank === 'B-0928' && e.params.date === '2026-09-28');
  assert.deepEqual([books.transactions.length, bookings(books, 'P-1002').length, books.mappings.length], [2, 1, 1], 'refused: nothing changed');
  answer(books, { pairs: [], own: [] });
  assert.deepEqual([books.transactions.map((t) => t.ref), bookings(books, 'P-1002').map((e) => e.id), books.mappings.map((m) => m.transactionRef)], [['B-0928', 'P-1002'], ['app'], ['P-1002']], 'left apart: a payment of its own, booked, its receipt linked');
});

test('a filed booked bank movement and an open read one: still paired, the read one goes, as booked there', () => {
  const books = booksOf('2026-09-30', [move('B-0928', '2026-09-28', -80, { counterparty: 'Alpha AG' }), move('P-1002', '2026-10-02', -80, { counterparty: 'Alpha AG' })], [entry('q3', 'B-0928', '2026-09-28', 80), entry('app', 'P-1002', '2026-10-02', 80)]);
  open(books, sides(['P-1002'], ['B-0928'], { from: '2026-09-01', to: '2026-09-30' }));
  assert.deepEqual(pending(books)[0].pairs, [{ read: 'P-1002', bank: 'B-0928' }]);
  answer(books, { pairs: [{ read: 'P-1002', bank: 'B-0928' }], own: [] });
  assert.deepEqual([books.transactions.map((t) => t.ref), books.journalEntries.map((e) => e.id)], [['B-0928'], ['q3']]);
});

test('books from before unique legs: a filed bank leg booked on its base counts as booked, as the year close counts it', () => {
  const books = booksOf('2026-09-30', [move('B~1', '2026-09-28', -80, { counterparty: 'Alpha AG' }), move('P-1002', '2026-10-02', -80, { counterparty: 'Alpha AG' })], [entry('q3', 'B', '2026-09-28', 80), entry('app', 'P-1002', '2026-10-02', 80)]);
  open(books, sides(['P-1002'], ['B~1'], { from: '2026-09-01', to: '2026-09-30' }));
  assert.deepEqual(pending(books)[0].pairs, [{ read: 'P-1002', bank: 'B~1' }], 'proposed: the filed leg is booked on its base');
  answer(books, { pairs: [{ read: 'P-1002', bank: 'B~1' }], own: [] });
  assert.deepEqual([books.transactions.map((t) => t.ref), books.journalEntries.map((e) => e.id)], [['B~1'], ['q3']], 'confirmed: the read movement goes, booked once on the filed leg\'s base');
});

test('books from before unique legs: a filed read leg booked on its base marks its bank twin booked there, and that twin may leave with its file', () => {
  const books = booksOf('2026-09-30', [move('P~1', '2026-09-29', -150, { counterparty: 'Reinigung Muster' }), move('B', '2026-10-01', -150, { counterparty: 'Reinigung Muster' })], [entry('q3', 'P', '2026-09-29', 150)]);
  open(books, sides(['P~1'], ['B'], { from: '2026-10-01', to: '2026-10-31' }));
  answer(books, { pairs: [{ read: 'P~1', bank: 'B' }], own: [] });
  assert.ok(bookedInFiled(books.transactions.find((t) => t.ref === 'B')!), 'booked there: no run books it again');
  assert.deepEqual(lostWithFile(books, new Set(['B'])), [], 'the filed read leg stays booked on its base: nothing lost');
});

test('a bank file taken back: a filed read movement\'s twin that books nothing goes and its pair with it; a twin with a difference line, or one that took an open read movement\'s place, keeps the file', () => {
  const books = booksOf('2026-09-30', [
    move('P', '2026-09-29', -150, { counterparty: 'Reinigung Muster' }), move('B', '2026-10-01', -150, { counterparty: 'Reinigung Muster' }),
    move('P2', '2026-09-30', -120, { counterparty: 'Alpha AG' }), move('B2', '2026-10-02', -120.05, { counterparty: 'Alpha AG' }),
    move('P3', '2026-10-05', -40, { counterparty: 'Beta GmbH' }), move('B3', '2026-10-05', -40, { counterparty: 'Beta GmbH' }),
  ], [entry('q3', 'P', '2026-09-29', 150), entry('q3b', 'P2', '2026-09-30', 120), entry('app', 'P3', '2026-10-05', 40)]);
  open(books, sides(['P', 'P2', 'P3'], ['B', 'B2', 'B3'], { from: '2026-10-01', to: '2026-10-31' }));
  answer(books, { pairs: [{ read: 'P', bank: 'B' }, { read: 'P2', bank: 'B2', account: '6940' }, { read: 'P3', bank: 'B3' }], own: [] });
  assert.ok(bookedInFiled(books.transactions.find((t) => t.ref === 'B')!));
  assert.deepEqual(lostWithFile(books, new Set(['B', 'B2', 'B3'])), ['B2', 'B3'], 'the difference line and the open read movement\'s place would be lost');
  assert.deepEqual(lostWithFile(books, new Set(['B'])), [], 'the filed read movement stays booked: nothing lost');
  books.transactions = books.transactions.filter((t) => t.ref !== 'B');
  releaseTwins(books, new Set(['B']));
  assert.deepEqual([books.reconciliations?.[0].pairs.map((p) => p.read), books.reconciliations?.[0].read, books.reconciliations?.[0].bank], [['P2', 'P3'], ['P2', 'P3'], ['B2', 'B3']], 'its pair leaves the reconciliation');
  books.transactions.push(move('B', '2026-10-01', -150, { counterparty: 'Reinigung Muster' }));
  open(books, sides(['P', 'P2'], ['B', 'B2', 'B3'], { from: '2026-10-01', to: '2026-10-31' }));
  assert.deepEqual(pending(books).map((r) => r.pairs), [[{ read: 'P', bank: 'B' }]], 'the bank file read again: reconciled afresh, never booked twice');
  const lone = booksOf('2026-09-30', [move('P', '2026-09-29', -150), move('B', '2026-10-01', -150)], [entry('q3', 'P', '2026-09-29', 150)]);
  open(lone, sides(['P'], ['B'], { from: '2026-10-01', to: '2026-10-31' }));
  answer(lone, { pairs: [{ read: 'P', bank: 'B' }], own: [] });
  releaseTwins(lone, new Set(['B']));
  assert.equal(lone.reconciliations, undefined, 'a reconciliation left without a read movement goes');
});
