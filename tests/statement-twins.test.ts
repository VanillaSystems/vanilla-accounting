/**
 * Which bank movement a movement read from a statement PDF is (#254), with invented data:
 * - equal amounts on one day follow the payee, never the file order; a tie is asked;
 * - a read movement the bank's file holds otherwise (a few cents off, its parts summing to one bank
 *   line, one charge split in two) is a question, and until it is answered the bank's movement is held
 *   from the run, so nothing is counted twice;
 * - the app's entries follow a movement the bank dated otherwise, a foreign one at that day's rate; a
 *   person's never;
 * - closing a period closes the statement questions of its days.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStatementXml } from '../src/providers/statement-read/camt-writer.js';
import { readCamt } from '../src/providers/camt053/camt053.js';
import { alignReads, followBankDays, transactionsOfFiles } from '../src/books/bank-import.js';
import { heldByTwins, twinQuestions } from '../src/books/twins.js';
import { closeThrough, type Books } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { ACTIONS } from '../src/workflows/actions.js';
import type { StatementFile } from '../src/workspace/bank-statements.js';
import type { ReadMovement, ReadStatement } from '../src/types/statement-read.js';
import type { BankTransaction, JournalEntry, StatementAsk } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

const account = { account: '1021', bank: 'Musterbank', currency: 'CHF', label: 'Musterbank', statements: 'camt053' as const, role: 'bank' as const };
const fileOf = (file: string, xml: string): Extract<StatementFile, { status: 'read' }> => ({ status: 'read', file, statement: readCamt(xml).statements[0], account, by: 'iban' });
const statement = (movements: ReadMovement[]): ReadStatement => ({
  iban: 'CH6580808000000000001', currency: 'CHF', period: { from: '2026-04-01', to: '2026-04-30' },
  opening: { date: '2026-04-01', amount: 1000 }, closing: { date: '2026-04-30', amount: Math.round((1000 + movements.reduce((n, m) => n + m.amount, 0)) * 100) / 100 }, movements,
});
const readFile = (movements: ReadMovement[]) => fileOf('Musterbank/r.xml', toStatementXml(statement(movements), { id: 'read-r', source: 'r.pdf', by: 'model' }));
const bankFile = (movements: ReadMovement[]) => fileOf('Musterbank/bank.xml', toStatementXml(statement(movements), { id: 'BANK', source: 'b', by: 'model' }).replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>\n/, ''));

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

test('a tie is asked, never guessed: a read line that names no payee, between two bank movements that differ, leaves the read file as a question', () => {
  const read = readFile([{ date: '2026-04-08', amount: -50, text: 'Zahlung' }, { date: '2026-04-20', amount: -70, counterparty: 'Gamma AG' }]);
  const bank = bankFile([
    { date: '2026-04-06', amount: -50, counterparty: 'Alpha AG' },
    { date: '2026-04-10', amount: -50, counterparty: 'Beta GmbH' },
    { date: '2026-04-21', amount: -70, counterparty: 'Delta AG' },
    { date: '2026-04-22', amount: -70, counterparty: 'Gamma AG' },
  ]);
  const { unmatched, realigned } = alignReads([read, bank], 'Musterbank/bank.xml', () => false, () => toStatementXml(statement([]), { id: 'x', source: 'x', by: 'model' }));
  assert.deepEqual(unmatched.map((u) => [u.date, u.amount]), [['2026-04-08', 50]], 'two days either way, two payees: asked');
  assert.deepEqual(realigned.map((r) => [r.date, r.to]), [['2026-04-20', '2026-04-22']], 'the payee decides before the closer day');
});

test('a read movement the bank holds otherwise is a question, and the bank\'s movement waits for it: a few cents off, its parts summing to one line, one charge split in two', () => {
  const tx = (ref: string, date: string, amount: number, o: Partial<BankTransaction> = {}): BankTransaction => ({ ref, bank: 'Musterbank', currency: 'CHF', date, direction: amount < 0 ? 'DBIT' : 'CRDT', amount: Math.abs(amount), description: ref, ...o } as BankTransaction);
  const pdf = { source: 'manual' as const, unmatched: { since: '2026-10-28', by: 'Musterbank/bank.xml' } };
  const transactions = [
    tx('P-fee', '2026-10-10', -49.80, pdf), tx('B-fee', '2026-10-10', -49.85),
    tx('P-in', '2026-10-11', 1200, pdf), tx('B-in', '2026-10-13', 1199.5),
    tx('P-a', '2026-10-20', -30, pdf), tx('P-b', '2026-10-20', -20, pdf), tx('B-sum', '2026-10-20', -50),
    tx('P-wise', '2026-10-15', -100, pdf), tx('B-60', '2026-10-15', -60), tx('B-40', '2026-10-15', -40),
    tx('B-far', '2026-10-25', -49.80), tx('B-booked', '2026-10-10', -49.80),
  ];
  const questions = twinQuestions(transactions, new Set(['B-booked']), () => false);
  assert.deepEqual(questions.get('P-fee'), [{ pdf: ['P-fee'], bank: ['B-fee'] }], 'five Rappen off on the same day; neither a booked one nor one too far off');
  assert.deepEqual(questions.get('P-in'), [{ pdf: ['P-in'], bank: ['B-in'] }], 'money in, two days and fifty Rappen off');
  assert.deepEqual(questions.get('P-a')?.find((o) => o.pdf.length === 2), { pdf: ['P-a', 'P-b'], bank: ['B-sum'] }, 'a Sammelzahlung the PDF lists in parts');
  assert.ok(questions.get('P-wise')?.some((o) => o.bank.join() === 'B-60,B-40'), 'one charge the bank split in two');
  const held = heldByTwins({ transactions, journalEntries: [{ transactionRef: 'B-booked' }] }, () => false);
  for (const ref of ['B-fee', 'B-in', 'B-sum', 'B-60', 'B-40']) assert.ok(held.has(ref), `${ref} waits for the answer`);
  assert.equal(held.has('B-far'), false);
  assert.equal(twinQuestions(transactions, new Set(), (d) => d <= '2026-10-31').size, 0, 'nothing is asked in a filed period');
});

test('the run books no bank movement that waits for «Ist das dieselbe Zahlung?»', async () => {
  const ws = workspaceAt(DEMO_ROOT);
  const camt = { ref: 'B-in', bank: 'Raiffeisen', currency: 'CHF', date: '2026-10-13', direction: 'CRDT', amount: 1199.5, description: 'Gutschrift Beispiel AG' } as BankTransaction;
  const read = { ...camt, ref: 'P-in', date: '2026-10-11', amount: 1200, source: 'manual', unmatched: { since: '2026-10-28', by: 'Raiffeisen/bank.xml' } } as BankTransaction;
  const books = { config: {}, transactions: [read, camt], journalEntries: [], mappings: [], receipts: [], bankStatements: [] } as unknown as Books;
  const out = await ACTIONS['accounting.expenses.classification'].run!({ transaction: camt, books }, {}, { ws } as never);
  assert.deepEqual([out.outcome, (out as { output?: { why?: string } }).output?.why], ['held', 'twin']);
});

test('the app\'s entries follow a payment the bank dated otherwise, a foreign one at that day\'s rate; a person\'s entry and one with a day of its own stay', () => {
  const entry = (id: string, o: Partial<JournalEntry>): JournalEntry => ({ id, transactionRef: 'R1', date: '2026-09-12', accountDebit: '6000', accountCredit: '1021', amount: 10, description: id, ...o } as JournalEntry);
  const books = {
    config: {}, mappings: [], receipts: [], bankStatements: [],
    transactions: [{ ref: 'R1', bank: 'Musterbank', currency: 'EUR', date: '2026-09-14', direction: 'DBIT', amount: 10, description: 'x', type: 'x' }],
    journalEntries: [
      entry('app', { origin: 'classify', exchangeCurrency: 'EUR', exchangeRate: 0.95 }),
      entry('hers', { origin: 'manual', exchangeCurrency: 'EUR', exchangeRate: 0.95 }),
      entry('own-day', { origin: 'classify', date: '2026-09-01' }),
    ],
  } as unknown as Books;
  followBankDays(books, new Map([['R1', { from: '2026-09-12', to: '2026-09-14' }]]), (e, days) => (days.get(e.transactionRef) === '2026-09-14' ? 0.93 : 0.95));
  const by = (id: string) => books.journalEntries.find((e) => e.id === id)!;
  assert.deepEqual([by('app').date, by('app').exchangeRate], ['2026-09-14', 0.93], 'the bank\'s day and its ESTV rate');
  assert.deepEqual([by('hers').date, by('hers').exchangeRate], ['2026-09-12', 0.95], 'a person\'s entry is never moved by the app');
  assert.equal(by('own-day').date, '2026-09-01');
});

test('closing a period closes the statement questions of its days: a filed day can never be read in', () => {
  const ask = (file: string, date: string) => ({ file, account: '1021', date, since: '2026-10-01', read: {} } as StatementAsk);
  const books = { config: {}, statementAsks: [ask('a.pdf', '2026-09-30'), ask('b.pdf', '2026-10-31')] } as unknown as Books;
  closeThrough(books, '2026-09-30');
  assert.deepEqual([books.config.closedThrough, books.statementAsks?.map((a) => a.file)], ['2026-09-30', ['b.pdf']]);
  closeThrough(books, '2026-12-31');
  assert.equal(books.statementAsks, undefined);
});
