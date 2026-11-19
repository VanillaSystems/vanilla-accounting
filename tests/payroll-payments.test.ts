/**
 * Lohnzahlungen (src/payroll/payments.ts, docs/specs/payroll.md §6.3, §15.1 checkpoint 5): the bank's line
 * of a wage is matched by code (amount = the payout, and the person's IBAN or name), one line for the
 * whole month pays each payslip, a line of a closed period or far from the payday pays none, and the
 * intake books it D 1091 / C bank with the payslip's PDF linked, so 1091 is 0 after the payment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, JournalEntry, Mapping } from '../src/types/index.js';
import { bookWagePayments, paymentRows, wageMatches, type MatchOptions } from '../src/payroll/payments.js';
import { computePayslip } from '../src/payroll/compute.js';
import { closePayslip, reopenPayslip, type BooksWriter } from '../src/payroll/service.js';
import { historyOf } from '../src/payroll/history.js';
import { allPayslipEvents, savePayroll } from '../src/payroll/store.js';
import { loadBooks, moduleActor, PERSON, saveBooks, updateSaved, type Books } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { classifyStep } from '../src/intake/classify.js';
import { closeOf, ctxOf, dated, firm, owner } from './support/payroll.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import type { PayslipClose } from '../src/payroll/model.js';

const IBAN = ['CH93', '00762011623852957'].join('');
const tx = (ref: string, date: string, amount: number, extra: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: 'Zahlung', ...extra });
const open = { isClosed: (d: string) => d <= '2026-06-30' };
const OPTS: MatchOptions = { currency: 'CHF' };
const closes = (store = firm()): PayslipClose[] => ['2026-08', '2026-09'].map((m) => ({ ...closeOf(computePayslip(ctxOf(store), 'e1', m)!), receiptId: `r-${m}` }));
const books = (transactions: BankTransaction[]) => ({ transactions, journalEntries: [], mappings: [] });

test('a payment of the payout to the person\'s IBAN, or naming her, pays the payslip nearest its payday', () => {
  const [aug, sep] = closes();
  const byIban = wageMatches(books([tx('T1', '2026-09-25', -8910, { counterpartyIban: IBAN })]), [aug, sep], open, OPTS);
  assert.deepEqual(byIban.map((m) => [m.tx.ref, m.payslips.map((p) => p.id)]), [['T1', ['2026-09-e1']]]);
  const byName = wageMatches(books([tx('T2', '2026-08-26', -8910, { counterparty: 'BEISPIEL MILA' })]), [aug, sep], open, OPTS);
  assert.deepEqual(byName.map((m) => m.payslips[0].id), ['2026-08-e1']);
  assert.deepEqual(wageMatches(books([tx('T3', '2026-09-25', -8910)]), [aug, sep], open, OPTS), [], 'neither IBAN nor name: no match');
  assert.deepEqual(wageMatches(books([tx('T4', '2026-09-25', -8900, { counterpartyIban: IBAN })]), [aug, sep], open, OPTS), [], 'another amount');
  assert.deepEqual(wageMatches(books([tx('T5', '2026-12-20', -8910, { counterpartyIban: IBAN })]), [aug, sep], open, OPTS), [], 'far from any payday');
  assert.deepEqual(wageMatches(books([tx('T6', '2026-06-25', -8910, { counterpartyIban: IBAN })]), [{ ...sep, payday: "2026-06-25" }], open, OPTS), [], 'a line of a closed period');
});

test('one line for the whole month pays each payslip of it; a paid payslip is not paid again', () => {
  const two = firm([owner(), owner({ id: 'e2', name: [dated('2026-01-01', { first: 'Nora', last: 'Muster' })] })]);
  const sep = ['e1', 'e2'].map((e) => ({ ...closeOf(computePayslip(ctxOf(two), e, '2026-09')!), receiptId: `r-${e}` }));
  const b: { transactions: BankTransaction[]; journalEntries: JournalEntry[]; mappings: Mapping[] } = { transactions: [tx('T1', '2026-09-25', -17820, { description: 'Sammelauftrag Löhne' }), tx('T2', '2026-09-26', -8910, { counterpartyIban: IBAN })], journalEntries: [], mappings: [] };
  const refs = bookWagePayments(b, sep, open, () => '1020', '1091', (() => { let i = 0; return () => `j${++i}`; })(), OPTS);
  assert.deepEqual(refs, ['T1']);
  assert.deepEqual(b.journalEntries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit, e.amount]), [['T1', '1091', '1020', 8910], ['T1', '1091', '1020', 8910]]);
  assert.deepEqual(b.mappings.map((m) => m.receiptId), ['r-e1', 'r-e2']);
  assert.deepEqual(paymentRows(b, sep, '2026-09').map((r) => [r.name, r.purpose, r.paid?.ref]), [['Mila Beispiel', 'Lohn 09/2026', 'T1'], ['Nora Muster', 'Lohn 09/2026', 'T1']]);
  assert.deepEqual(bookWagePayments(b, sep, open, () => '1020', '1091', () => 'x', OPTS), [], 'T2 pays nothing: both are paid');
});

test('through the intake: the bank line of a closed payslip is booked D 1091 / C bank, and 1091 is 0', async () => {
  const ws = tempWorkspace('payroll-pay-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, firm());
  const write: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, fn);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const b = loadBooks(ws);
  b.transactions.push(tx('BANK-1', '2026-09-25', -8910, { counterpartyIban: IBAN, bank: ws.bankAccounts[0]?.bank ?? 'Bank' }));
  saveBooks(ws, b);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
  const after = loadBooks(ws);
  const paid = after.journalEntries.filter((e) => e.transactionRef === 'BANK-1');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].accountDebit, '1091');
  assert.equal(paid[0].amount, 8910);
  assert.deepEqual(paid[0].by, { kind: 'code', check: 'payroll' });
  const on1091 = after.journalEntries.reduce((s, e) => s + (e.accountCredit === '1091' ? e.amount : 0) - (e.accountDebit === '1091' ? e.amount : 0), 0);
  assert.equal(Math.round(on1091 * 100) / 100, 0);
});

test('a line in another currency, to the firm\'s own account, or one a company rule decides, is no wage payment', () => {
  const [, sep] = closes();
  const m = (t: BankTransaction, opts = OPTS) => wageMatches(books([t]), [sep], open, opts).length;
  assert.equal(m(tx('E1', '2026-09-25', -8910, { counterpartyIban: IBAN, currency: 'EUR' })), 0);
  assert.equal(m(tx('E2', '2026-09-25', -8910, { counterpartyIban: IBAN }), { ...OPTS, ruled: () => true }), 0);
  assert.equal(m(tx('E3', '2026-09-25', -8910, { counterpartyIban: IBAN }), { ...OPTS, own: new Set([IBAN]) }), 0);
});

test('classify --force keeps a wage payroll\'s code booked, so it is never handed to the model', async () => {
  const { entriesForceMayRemove } = await import('../src/accounting/classify-force.js');
  const e = { id: 'w', transactionRef: 'T1', date: '2026-09-25', accountDebit: '1091', accountCredit: '1020', amount: 8910, by: { kind: 'code' as const, check: 'payroll' as const } };
  assert.deepEqual(entriesForceMayRemove([e], new Set(['T1']), undefined), []);
});

test('a payslip paid, reopened and closed again with another payout names the difference left on 1091', async () => {
  const ws = tempWorkspace('payroll-pay-diff-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, firm());
  const write: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, fn);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const b = loadBooks(ws);
  b.transactions.push(tx('BANK-2', '2026-09-25', -8910, { counterpartyIban: IBAN, bank: ws.bankAccounts[0]?.bank ?? 'Bank' }));
  saveBooks(ws, b);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
  reopenPayslip(ws, write, '2026-09-e1');
  const store = firm();
  store.monthLines = [{ id: 'l1', employee: 'e1', month: '2026-09', wageType: 'pauschalspesen', amount: 100, enteredAt: '2026-10-02T00:00:00Z' }];
  savePayroll(ws, store);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const closes = [...historyOf(allPayslipEvents(ws)).closed.values()];
  const [row] = paymentRows(loadBooks(ws), closes, '2026-09');
  assert.deepEqual([row.payout, row.paid?.forThis, row.difference], [9010, 8910, 100]);
});

test('what was paid for a payslip: signed off the clearing account, over every linked line, and only where it can be told', () => {
  const c = (id: string, payout: number, receiptId: string) => ({ ...closeOf(computePayslip(ctxOf(firm()), 'e1', '2026-09')!), id, payout, receiptId });
  const e = (id: string, ref: string, debit: string, credit: string, amount: number, receipts?: string[]): JournalEntry => ({ id, transactionRef: ref, date: '2026-09-25', accountDebit: debit, accountCredit: credit, amount, ...(receipts ? { receipts } : {}) });
  const t = (ref: string, amount: number) => tx(ref, '2026-09-25', amount);
  // A repayment in of a negative payout: no false difference.
  const neg = c('2026-09-e1', -500, 'rn');
  assert.equal(paymentRows({ transactions: [{ ...t('IN', 500), direction: 'CRDT' }], journalEntries: [e('j', 'IN', '1020', '1091', 500)], mappings: [{ transactionRef: 'IN', receiptId: 'rn' }] }, [neg], '2026-09')[0].difference, undefined);
  // A line booked by hand for two payslips, naming none, that pays exactly both: no difference; with a fee on the line: still none (only the clearing account counts).
  const a = c('2026-09-a', 1000, 'ra'); const b = c('2026-09-b', 2000, 'rb');
  const both = { transactions: [t('T', -3005)], journalEntries: [e('j1', 'T', '1091', '1020', 3000), e('j2', 'T', '6940', '1020', 5)], mappings: [{ transactionRef: 'T', receiptId: 'ra' }, { transactionRef: 'T', receiptId: 'rb' }] };
  assert.deepEqual(paymentRows(both, [a, b], '2026-09').map((r) => [r.id, r.difference, r.paid?.together]), [['2026-09-a', undefined, true], ['2026-09-b', undefined, true]]);
  // The same line paying another amount: what it paid for each cannot be told, so nothing is said.
  const off = { ...both, journalEntries: [e('j1', 'T', '1091', '1020', 2900)] };
  assert.deepEqual(paymentRows(off, [a, b], '2026-09').map((r) => r.difference), [undefined, undefined]);
  // A second line that pays the difference settles it.
  const one = c('2026-09-e1', 9010, 'r1');
  const twice = { transactions: [t('P1', -8910), t('P2', -100)], journalEntries: [e('p1', 'P1', '1091', '1020', 8910, ['r1']), e('p2', 'P2', '1091', '1020', 100)], mappings: [{ transactionRef: 'P1', receiptId: 'r1' }, { transactionRef: 'P2', receiptId: 'r1' }] };
  assert.equal(paymentRows(twice, [one], '2026-09')[0].difference, undefined);
  // A payout closed again at 0 after it was paid: the whole payment is named.
  const zero = c('2026-09-e1', 0, 'r1');
  const paid = { transactions: [t('P1', -8910)], journalEntries: [e('p1', 'P1', '1091', '1020', 8910, ['r1'])], mappings: [{ transactionRef: 'P1', receiptId: 'r1' }] };
  assert.deepEqual(paymentRows(paid, [zero], '2026-09').map((r) => [r.difference, r.account]), [[-8910, '1091']]);
});
