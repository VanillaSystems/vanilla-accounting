/**
 * The Sozialversicherungen through the year (src/payroll/insurers.ts, docs/specs/payroll.md §6.4, §15.1
 * checkpoint 6): a payment to the fund books against its liability account only, never on the expense
 * again; each account holds what the payslips accrued less what was paid; a final statement's difference
 * is booked on the employer's account against the liability, once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { bookInsurerPayments, insurerRows, payrollSince, settlementOf } from '../src/payroll/insurers.js';
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

test('from the first month payroll runs here a fund payment is the liability\'s, before that month\'s payslip is closed; before it, level A keeps it', () => {
  const { store, books } = quarter();
  // Closes of July to September exist; October is not closed yet. Payroll runs here from July (the opening holds January to June).
  store.employees[0].opening = { 2026: { through: '2026-06', bases: { ahv: 60000 } } };
  assert.equal(payrollSince(store, '2026'), '2026-07-01');
  const pay = (ref: string, date: string) => ({ ref, bank: 'Bank', date, amount: -100, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' });
  // Only September's payslip is in the books: an August payment falls before every accrual, but after payroll's start.
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef.startsWith('LR-2026-09'));
  books.transactions.push(pay('AUG', '2026-08-05'), pay('JUN', '2026-06-20'));
  assert.deepEqual(bookInsurerPayments(structuredClone(books), ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), [], 'without the start only the months of an accrual count');
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF', since: (y) => payrollSince(store, y) }), ['AUG']);
});

test('the final statement compares with the year\'s contributions in the books: the payslips\' and the payments booked for the opening\'s months; a large difference is said, never silent', () => {
  const { store, books } = quarter();
  store.employees[0].opening = { 2026: { through: '2026-06', bases: { ahv: 60000 } } };
  // January to June were paid by hand: two Akonto payments booked on 2270 / 5700 (level A).
  for (const [ref, date] of [['AK-Q1', '2026-04-10'], ['AK-Q2', '2026-07-08']] as const) {
    books.transactions.push({ ref, bank: 'Bank', date, amount: -3935.4, currency: 'CHF', direction: 'DBIT', description: 'Akonto', counterparty: 'Ausgleichskasse Beispiel' });
    books.journalEntries.push({ id: id(), transactionRef: ref, date, accountDebit: '5700', accountCredit: '1020', amount: 3935.4, description: 'Akonto' });
  }
  const year = 3 * 3935.4 + 3935.4;
  const fair = settlementOf(books, ch.payroll!, store, 'ak', '2026', 11821.2, '2027-01-20', id);
  assert.equal(fair.compare.before, 7870.8, 'the level-A payments of the year count');
  assert.equal(fair.compare.books, 11806.2);
  assert.equal(fair.compare.difference, 15);
  assert.equal(fair.compare.large, false);
  assert.equal(fair.compare.openingThrough, '2026-06');
  assert.ok(year > 0);
  // A total for the whole year against the payslips' quarter alone would have booked 7,870.80 more: now it is said first.
  const wrong = settlementOf({ ...books, transactions: [] }, ch.payroll!, store, 'ak', '2026', 11821.2, '2027-01-20', id);
  assert.equal(wrong.compare.before, 0);
  assert.equal(wrong.compare.difference, 7885.8);
  assert.equal(wrong.compare.large, true, 'more than 5 % of the year: the page asks first');
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
