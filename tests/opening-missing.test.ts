/**
 * A bank account without its opening balance (persona round 3, corner-25): books that start with
 * a Q3 statement show Raiffeisen below zero; the Bilanz says the opening is missing and how much
 * the statements imply, until one is entered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { missingOpenings } from '../src/accounting/opening-balance.js';
import type { BankTransaction, Index } from '../src/types/index.js';

const ACCOUNTS = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Privat' },
];
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
  assert.deepEqual(missingOpenings(books(), ACCOUNTS, '2026'), [{ account: '1020', label: 'Raiffeisen CHF', year: '2026', amount: 18420.15 }]);
});

test('nothing is missing once an opening is entered, without a statement balance, or in a year the one before opens', () => {
  assert.deepEqual(missingOpenings(books({ config: { openingBalances: { 2026: { 1020: 18420.15 } } } }), ACCOUNTS, '2026'), []);
  assert.deepEqual(missingOpenings(books({ statementBalances: [] }), ACCOUNTS, '2026'), []);
  assert.deepEqual(missingOpenings(books({ config: { openingBalances: { 2025: { 1020: 100 } } } }), ACCOUNTS, '2026'), []);
  const balanced = books({ statementBalances: [{ account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: -18016.30, source: 'camt', sourceFile: 'q3.xml' }] });
  assert.deepEqual(missingOpenings(balanced, ACCOUNTS, '2026'), [], 'the bank started at zero: nothing to open');
});
