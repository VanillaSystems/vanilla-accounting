/**
 * The Sozialversicherungen through the year (src/payroll/insurers.ts, docs/specs/payroll.md §6.4, §15.1
 * checkpoint 6): a payment to the fund books against its liability account only, never on the expense
 * again; each account holds what the payslips accrued less what was paid; a final statement's difference
 * is booked on the employer's account against the liability, once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { bookInsurerPayments, insurerPaymentOf, insurerRows, payrollSince, settlementOf } from '../src/payroll/insurers.js';
import { dated, owner } from './support/payroll.js';
import { computePayslip } from '../src/payroll/compute.js';
import { bookingOf } from '../src/payroll/booking.js';
import { entriesOf } from '../src/payroll/close.js';
import { ch, closedThrough, ctxOf, firm } from './support/payroll.js';

const open = { isClosed: (d: string) => d <= '2026-03-31' };
let n = 0;
const id = () => `x${++n}`;

/** The books of a quarter's three closed payslips (July to September). */
function quarter() {
  const store = firm();
  const events = closedThrough(store, '2026-07');
  const entries: JournalEntry[] = [];
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    const d = computePayslip(ctxOf(store, events), 'e1', m)!;
    entries.push(...entriesOf({ booking: bookingOf(d, ch.payroll!, store) }, id));
  }
  return { store, books: { transactions: [] as BankTransaction[], journalEntries: entries } };
}

test('the quarter\'s Akonto to the compensation fund clears 2271 only; 2271 then holds nothing for the quarter', () => {
  const { store, books } = quarter();
  books.transactions.push({ ref: 'AK-Q3', bank: 'Bank', date: '2026-10-10', amount: -3935.4, currency: 'CHF', direction: 'DBIT', description: 'Akonto Q3', counterparty: 'Ausgleichskasse Beispiel' });
  const refs = bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' });
  assert.deepEqual(refs, ['AK-Q3']);
  const paid = books.journalEntries.find((e) => e.transactionRef === 'AK-Q3')!;
  assert.deepEqual([paid.accountDebit, paid.accountCredit, paid.amount], ['2271', '1020', 3935.4]);
  const ahv = insurerRows(books, ch.payroll!, store, '2026').find((r) => r.kind === 'ahv')!;
  assert.deepEqual([ahv.accrued, ahv.paid, ahv.open], [3935.4, 3935.4, 0], '3 × 1,311.80 accrued, paid, nothing open');
});

test('a payment to an insurer whose account no payslip accrued stays to the other booking paths (level A)', () => {
  const store = firm();
  const books = { transactions: [{ ref: 'AK', bank: 'Bank', date: '2026-10-10', amount: -500, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' }], journalEntries: [] as JournalEntry[] };
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), []);
});

test('the final statement\'s difference: on the employer\'s account against the liability, once', () => {
  const { store, books } = quarter();
  const e = settlementOf(books, ch.payroll!, store, 'ak', '2026', 3950, '2027-01-20', id).entry!;
  assert.deepEqual([e.accountDebit, e.accountCredit, e.amount, e.transactionRef], ['5700', '2271', 14.6, 'LS-2026-ak']);
  books.journalEntries.push(e);
  assert.equal(settlementOf(books, ch.payroll!, store, 'ak', '2026', 3950, '2027-01-20', id).entry, undefined, 'once: it agrees now');
  const lower = settlementOf(books, ch.payroll!, store, 'ak', '2026', 3900, '2027-01-25', id).entry!;
  assert.deepEqual([lower.accountDebit, lower.accountCredit, lower.amount], ['2271', '5700', 50], 'a lower total books back');
});

test('only payments out, and only from the month the payslips accrue: a January payment of last year\'s is booked, one of a month before is not, a refund in is left alone', () => {
  const { store, books } = quarter();
  const pay = (ref: string, date: string, direction: 'DBIT' | 'CRDT' = 'DBIT') => ({ ref, bank: 'Bank', date, amount: direction === 'DBIT' ? -100 : 100, currency: 'CHF', direction, description: 'AHV', counterparty: 'Ausgleichskasse Beispiel' });
  books.transactions.push(pay('JAN', '2027-01-15'), pay('EARLY', '2026-06-10'), pay('IN', '2026-11-02', 'CRDT'), { ...pay('EUR', '2026-11-03'), currency: 'EUR' });
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), ['JAN']);
});

test('a fund payment dated before the month\'s posting date is the liability\'s: July\'s payslip posts on 31.07, the payment of 15.07 clears 2275, never the expense', () => {
  const { store, books } = quarter();
  books.transactions.push({ ref: 'BVG-07', bank: 'Bank', date: '2026-07-15', amount: -600, currency: 'CHF', direction: 'DBIT', description: 'BVG Juli', counterparty: 'Pensionskasse Beispiel' });
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), ['BVG-07']);
  const paid = books.journalEntries.find((e) => e.transactionRef === 'BVG-07')!;
  assert.deepEqual([paid.accountDebit, paid.accountCredit], ['2275', '1020']);
});

test('one decision for every path: from payroll\'s first month a fund payment is the insurer\'s; code books it only where the liability covers it, else it waits for the person', () => {
  const { store, books } = quarter();
  store.employees[0].opening = { 2026: { through: '2026-06', bases: { ahv: 60000 } } };
  assert.equal(payrollSince(store, '2026'), '2026-07-01');
  const pay = (ref: string, date: string, amount = 100) => ({ ref, bank: 'Bank', date, amount: -amount, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' });
  // Only September's payslip is in the books: an August payment falls after payroll's start but before every accrual.
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef.startsWith('LR-2026-09'));
  books.transactions.push(pay('AUG', '2026-08-05'), pay('JUN', '2026-06-20'), pay('SEP', '2026-09-20'));
  const of = (ref: string) => insurerPaymentOf(books.transactions.find((t) => t.ref === ref)!, books.journalEntries, ch.payroll!, store, () => undefined, 'CHF');
  assert.equal(of('JUN'), undefined, 'the opening\'s months stay level A\'s');
  assert.deepEqual([of('AUG')?.account, of('AUG')?.covered], ['2271', false], 'the insurer\'s, but nothing accrued covers it: the person decides');
  assert.equal(of('SEP')?.covered, true, 'September\'s payslip covers a payment of its month, dated before its posting');
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), ['SEP']);
});

test('a quarter paid in arrears for the opening\'s months is not booked against the liability: October\'s accrual does not cover it', () => {
  const store = firm([owner({ opening: { 2026: { through: '2026-09', bases: { ahv: 90000 } } } })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  const books = { transactions: [{ ref: 'AK-Q3', bank: 'B', date: '2026-10-10', amount: -3935.4, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto Q3', counterparty: 'Ausgleichskasse Beispiel' }] as BankTransaction[], journalEntries: entriesOf({ booking: bookingOf(d, ch.payroll!, store) }, id) };
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), []);
  assert.equal(insurerPaymentOf(books.transactions[0], books.journalEntries, ch.payroll!, store, () => undefined, 'CHF')?.covered, false);
});

test('a firm with persons but no payroll here (no opening, nothing accrued) keeps level A\'s way', () => {
  const store = firm();
  const tx = { ref: 'AK', bank: 'B', date: '2026-10-10', amount: -500, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' };
  assert.equal(insurerPaymentOf(tx, [], ch.payroll!, store, () => undefined, 'CHF'), undefined);
});

test('the final statement compares with the year\'s contributions in the books: the payslips\' and the payments booked for the opening\'s months; a large difference is said, never silent', () => {
  const { store, books } = quarter();
  store.employees[0].opening = { 2026: { through: '2026-06', bases: { ahv: 60000 } } };
  // January to June were paid by hand: two Akonto payments booked on 5700 (level A), dated from 1 February to payroll's start.
  const levelA = (ref: string, date: string, amount: number, direction: 'DBIT' | 'CRDT' = 'DBIT', currency = 'CHF') => {
    books.transactions.push({ ref, bank: 'Bank', date, amount: direction === 'DBIT' ? -amount : amount, currency, direction, description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' });
    books.journalEntries.push({ id: id(), transactionRef: ref, date, accountDebit: direction === 'DBIT' ? '5700' : '1020', accountCredit: direction === 'DBIT' ? '1020' : '5000', amount, description: 'Akonto' });
  };
  levelA('AK-Q1', '2026-04-10', 3935.4);
  levelA('AK-Q2', '2026-06-28', 3935.4);
  levelA('AK-JAN', '2026-01-12', 500, 'DBIT');
  levelA('EO', '2026-05-10', 2000, 'CRDT');
  levelA('EUR', '2026-05-11', 100, 'DBIT', 'EUR');
  const fair = settlementOf(books, ch.payroll!, store, 'ak', '2026', 11821.2, '2027-01-20', id, () => undefined, 'CHF');
  assert.equal(fair.compare.before, 7870.8, 'payments out in the books\' currency, 1 February to the day before payroll\'s start: not January\'s (last year\'s), not a benefit paid in, not euros');
  assert.equal(fair.compare.beforeUntil, '2026-06-30');
  assert.equal(fair.compare.books, 11806.2);
  assert.equal(fair.compare.difference, 15);
  assert.equal(fair.compare.large, false);
  assert.equal(fair.compare.openingThrough, '2026-06');
  // A total for the whole year against the payslips' quarter alone would have booked 7,870.80 more: now it is said first.
  const wrong = settlementOf({ ...books, transactions: [] }, ch.payroll!, store, 'ak', '2026', 11821.2, '2027-01-20', id);
  assert.equal(wrong.compare.before, 0);
  assert.equal(wrong.compare.difference, 7885.8);
  assert.equal(wrong.compare.large, true, 'more than 5 % of the year: the page asks first');
  // The fund also takes the family allowances: its payments cover two insurances and are not split, so none counts, and it is said.
  const both = structuredClone(store);
  for (const i of both.insurances.filter((x) => x.id === 'ak' || x.id === 'fak')) i.business = 'fund';
  const shared = settlementOf(books, ch.payroll!, both, 'ak', '2026', 11821.2, '2027-01-20', id, () => 'fund', 'CHF');
  assert.deepEqual([shared.compare.before, shared.compare.sharedPayees], [0, ['Ausgleichskasse Beispiel']]);
});

test('payroll runs here from a person\'s first month after her opening; without an opening from her entry', () => {
  const store = firm([owner(), owner({ id: 'e2', employment: [dated('2026-03-16', { kind: 'monthly' as const, amount: 5000 })] })]);
  assert.equal(payrollSince(store, '2026'), '2026-01-01');
  store.employees[0].opening = { 2026: { through: '2026-09' } };
  assert.equal(payrollSince(store, '2026'), '2026-03-16');
  store.employees[1].opening = { 2026: { months: 7 } };
  assert.equal(payrollSince(store, '2026'), '2026-08-01', 'her opening holds January to July');
});

test('a final statement of an unknown insurance, with a negative total or for a year without payslips is refused with its reason', () => {
  const { store, books } = quarter();
  assert.throws(() => settlementOf(books, ch.payroll!, store, 'nope', '2026', 1, '2027-01-20', id), /Keine Sozialversicherung/);
  assert.throws(() => settlementOf(books, ch.payroll!, store, 'ak', '2026', -1, '2027-01-20', id), (e: Error & { code?: string }) => e.code === 'badInput');
  assert.throws(() => settlementOf(books, ch.payroll!, store, 'ak', '2025', 100, '2026-01-20', id), (e: Error & { code?: string }) => e.code === 'nothingAccrued');
});

test('an insurer\'s row carries last year\'s balance: the opening where written (with a final statement of last year dated in this one), else the entries before', () => {
  const { store, books } = quarter();
  const lastYear = insurerRows(books, ch.payroll!, store, '2026').find((r) => r.id === 'ak')!;
  const next = insurerRows(books, ch.payroll!, store, '2027').find((r) => r.id === 'ak')!;
  assert.deepEqual([next.carried, next.accrued, next.paid, next.open], [lastYear.open, 0, 0, lastYear.open], 'not opened yet: what 2026 left');
  const ls = { id: 'ls', transactionRef: 'LS-2026-ak', date: '2027-01-20', accountDebit: '5700', accountCredit: '2271', amount: 14.6, by: { kind: 'code' as const, check: 'payroll' as const } };
  const opened = { journalEntries: [...books.journalEntries, ls], config: { openingBalances: { '2027': { '2271': lastYear.open } } } };
  const row = insurerRows(opened, ch.payroll!, store, '2027').find((r) => r.id === 'ak')!;
  assert.deepEqual([row.carried, row.open], [Math.round((lastYear.open + 14.6) * 100) / 100, Math.round((lastYear.open + 14.6) * 100) / 100]);
  assert.equal(insurerRows(opened, ch.payroll!, store, '2026').find((r) => r.id === 'ak')!.accrued, Math.round((lastYear.accrued + 14.6) * 100) / 100, 'and 2026 counts it as its own');
});
