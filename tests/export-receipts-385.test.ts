/**
 * The export bundle's receipts of a period stay what 0.4.2 gave (#385 review): a receipt by its own day
 * (its date, else the day it was read) and every receipt of a payment or entry of the period. Belege's
 * one-period placement (placeDay) is for its lists, never for the export. Invented figures.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { receiptsIn } from '../src/export/model.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-11-12T08:00:00Z', location: 'archived', currency: 'CHF', amount: 10, ...x,
});
const tx = (ref: string, date: string): BankTransaction => ({ ref, bank: 'Bank', date, amount: -10, currency: 'CHF', direction: 'DBIT', description: ref });

const books: Index = {
  receipts: [
    receipt('q1-unlinked', { date: '2026-02-10' }),
    receipt('q2-unlinked', { date: '2026-05-10' }),
    receipt('undated', { indexedAt: '2026-11-12T08:00:00Z' }),          // read in Q4, no date, no payment
    receipt('q3-paid-q4', { date: '2026-09-10' }),
    receipt('q3-paid-q2', { date: '2026-08-01' }),
  ],
  transactions: [tx('T-q4', '2026-10-05'), tx('T-q2', '2026-06-30')],
  mappings: [{ receiptId: 'q3-paid-q4', transactionRef: 'T-q4' }, { receiptId: 'q3-paid-q2', transactionRef: 'T-q2' }],
  journalEntries: [],
  bankStatements: [],
};
const ids = (b: Index, key: string) => receiptsIn(b, parsePeriod(key, '2026-11-13')!).map((v) => v.r.id).sort();

test('an export holds a receipt by its own day and by its payments, as in 0.4.2: never what Belege only places there', () => {
  assert.deepEqual(ids(books, '2026-Q1'), ['q1-unlinked']);
  assert.deepEqual(ids(books, '2026-Q2'), ['q2-unlinked', 'q3-paid-q2']);
  assert.deepEqual(ids(books, '2026-Q3'), ['q3-paid-q2', 'q3-paid-q4'], 'dated in Q3: in Q3, whenever paid');
  assert.deepEqual(ids(books, '2026-Q4'), ['q3-paid-q4', 'undated'], 'no earlier unlinked receipt drifts into a later export');
});

test('with a filed Q1, an export of Q1 does not take undated receipts', () => {
  const filed = { ...books, config: { closedThrough: '2026-03-31' } } as Index;
  assert.deepEqual(ids(filed, '2026-Q1'), ['q1-unlinked']);
  assert.deepEqual(ids(filed, '2026-Q4'), ['q3-paid-q4', 'undated']);
});
