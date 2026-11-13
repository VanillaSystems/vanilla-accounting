/**
 * A bank account without its opening balance (persona round 3, corner-25): books that start with
 * a Q3 statement show Raiffeisen below zero; the Bilanz says the opening is missing and how much
 * the statements imply, until one is entered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { bookDiffParts, missingOpenings, startGaps } from '../src/accounting/opening-balance.js';
import type { BankTransaction, Index } from '../src/types/index.js';

const ACCOUNTS = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Privat' },
];
const WISE = [{ bank: 'Wise', currency: 'EUR', account: '1021', label: 'Wise EUR' }];
const tx = (ref: string, date: string, amount: number): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: Math.abs(amount), currency: 'CHF', direction: amount < 0 ? 'DBIT' : 'CRDT', description: ref });
const books = (over: Partial<Index> = {}): Index => ({
  receipts: [], mappings: [], bankStatements: [], journalEntries: [],
  transactions: [tx('a', '2026-07-03', -15000), tx('b', '2026-08-20', 3275), tx('c', '2026-09-15', -6291.30)],
  statementBalances: [{ account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: 403.85, source: 'camt', sourceFile: 'q3.xml' }],
  config: {},
  ...over,
});

test('the first year without an opening: the statements imply what the account held before its first payment', () => {
  assert.deepEqual(missingOpenings(books(), ACCOUNTS, '2026'), [{ account: '1020', label: 'Raiffeisen CHF', year: '2026', currency: 'CHF', amount: 18420.15, from: '2026-07-03', canType: true }]);
});

test('after a quarter is filed the opening can still be entered, so the link leads to a form; a year closed through 31.12. names it without a link (r5h-30)', () => {
  assert.equal(missingOpenings(books({ config: { closedThrough: '2026-09-30' } }), ACCOUNTS, '2026')[0].canType, true);
  assert.equal(missingOpenings(books({ config: { closedThrough: '2026-12-31' } }), ACCOUNTS, '2026')[0].canType, false);
});

test('nothing is missing once an opening is entered, without a statement balance, or in a year the one before opens', () => {
  assert.deepEqual(missingOpenings(books({ config: { openingBalances: { 2026: { 1020: 18420.15 } } } }), ACCOUNTS, '2026'), []);
  assert.deepEqual(missingOpenings(books({ statementBalances: [] }), ACCOUNTS, '2026'), []);
  assert.deepEqual(missingOpenings(books({ config: { openingBalances: { 2025: { 1020: 100 } } } }), ACCOUNTS, '2026'), []);
  const balanced = books({ statementBalances: [{ account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: -18016.30, source: 'camt', sourceFile: 'q3.xml' }] });
  assert.deepEqual(missingOpenings(balanced, ACCOUNTS, '2026'), [], 'the bank started at zero: nothing to open');
});

test('Kontoauszüge splits the books\' gap to the bank into the missing opening balance and what a payment explains (r4c-33)', () => {
  const missing = { account: '1020', label: 'Raiffeisen CHF', year: '2026', currency: 'CHF', amount: 18420.15, from: '2026-07-03', canType: true };
  assert.deepEqual(bookDiffParts(-18331.15, missing), { opening: missing, rest: 89 });
  assert.deepEqual(bookDiffParts(-18420.15, missing), { opening: missing, rest: 0 }, 'all of it the opening: no payment is blamed');
  assert.deepEqual(bookDiffParts(-89, undefined), { rest: -89 });
});

test('a foreign-currency account without its opening: named in its currency, as the form now takes it (r2-28)', () => {
  const wise = books({
    transactions: [{ ref: 'w1', bank: 'Wise', date: '2026-07-03', amount: 640, currency: 'EUR', direction: 'DBIT', description: 'w1' }],
    statementBalances: [{ account: '1021', bank: 'Wise', currency: 'EUR', date: '2026-07-31', amount: 1200, source: 'camt', sourceFile: 'w.xml' }],
  });
  assert.deepEqual(missingOpenings(wise, WISE, '2026'), [{ account: '1021', label: 'Wise EUR', year: '2026', currency: 'EUR', amount: 1840, from: '2026-07-03', canType: true }]);
  assert.deepEqual(missingOpenings(books({ ...wise, config: { openingBalances: { 2026: { 1021: 1126.01 } }, openingBalancesNative: { 2026: { 1021: { amount: 1200, currency: 'EUR' } } } } }), WISE, '2026').length, 0, 'entered with its balance in EUR');
});

test('an opening entered while the books start later in the year: the gap before the first payment is named, not blamed on a payment (r2-28)', () => {
  // The balance sheet of 31.12.2025 opened 1020 at 29'118.40; the books start with the Q3 statement, the bank held 38'420.60 before it.
  const later = books({
    config: { openingBalances: { 2026: { 1020: 29118.40, 2970: 29118.40 } } },
    statementBalances: [{ account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: 38420.60 - 18016.30, source: 'camt', sourceFile: 'q3.xml' }],
  });
  assert.deepEqual(missingOpenings(later, ACCOUNTS, '2026'), []);
  const [gap] = startGaps(later, ACCOUNTS, '2026');
  assert.deepEqual(gap, { account: '1020', label: 'Raiffeisen CHF', year: '2026', currency: 'CHF', from: '2026-07-03', bank: 38420.60, books: 29118.40, diff: -9302.20, canType: true });
  assert.deepEqual(bookDiffParts(-9302.20, undefined, gap), { before: gap, rest: 0 }, 'all of it before the first payment: no payment is blamed');
  assert.deepEqual(bookDiffParts(-9391.20, undefined, gap), { before: gap, rest: -89 });
  const right = books({ config: { openingBalances: { 2026: { 1020: 38420.60, 2970: 38420.60 } } }, statementBalances: later.statementBalances });
  assert.deepEqual(startGaps(right, ACCOUNTS, '2026'), [], 'the opening and the bank agree');
});
