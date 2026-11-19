/**
 * The Sozialversicherungen through the year (src/payroll/insurers.ts, docs/specs/payroll.md §6.4, §15.1
 * checkpoint 6): a payment to the fund books against its liability account only, never on the expense
 * again; each account holds what the payslips accrued less what was paid; a final statement's difference
 * is booked on the employer's account against the liability, once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { bookInsurerPayments, insurerRows, settlementEntry } from '../src/payroll/insurers.js';
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
  const e = settlementEntry(books, ch.payroll!, store, 'ak', '2026', 3950, '2027-01-20', id)!;
  assert.deepEqual([e.accountDebit, e.accountCredit, e.amount, e.transactionRef], ['5700', '2271', 14.6, 'LS-2026-ak']);
  books.journalEntries.push(e);
  assert.equal(settlementEntry(books, ch.payroll!, store, 'ak', '2026', 3950, '2027-01-20', id), undefined, 'once: it agrees now');
  const lower = settlementEntry(books, ch.payroll!, store, 'ak', '2026', 3900, '2027-01-25', id)!;
  assert.deepEqual([lower.accountDebit, lower.accountCredit, lower.amount], ['2271', '5700', 50], 'a lower total books back');
});

test('only payments out, and only after the payslips accrued: a January payment of last year\'s is booked, one before payroll ran here is not, a refund in is left alone', () => {
  const { store, books } = quarter();
  const pay = (ref: string, date: string, direction: 'DBIT' | 'CRDT' = 'DBIT') => ({ ref, bank: 'Bank', date, amount: direction === 'DBIT' ? -100 : 100, currency: 'CHF', direction, description: 'AHV', counterparty: 'Ausgleichskasse Beispiel' });
  books.transactions.push(pay('JAN', '2027-01-15'), pay('EARLY', '2026-07-10'), pay('IN', '2026-11-02', 'CRDT'), { ...pay('EUR', '2026-11-03'), currency: 'EUR' });
  assert.deepEqual(bookInsurerPayments(books, ch.payroll!, store, open, () => undefined, () => '1020', id, { currency: 'CHF' }), ['JAN']);
});

test('a final statement of an unknown insurance, with a negative total or for a year without payslips is refused with its reason', () => {
  const { store, books } = quarter();
  assert.throws(() => settlementEntry(books, ch.payroll!, store, 'nope', '2026', 1, '2027-01-20', id), /Keine Sozialversicherung/);
  assert.throws(() => settlementEntry(books, ch.payroll!, store, 'ak', '2026', -1, '2027-01-20', id), (e: Error & { code?: string }) => e.code === 'badInput');
  assert.throws(() => settlementEntry(books, ch.payroll!, store, 'ak', '2025', 100, '2026-01-20', id), (e: Error & { code?: string }) => e.code === 'nothingAccrued');
});
