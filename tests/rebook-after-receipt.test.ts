/**
 * A payment booked before its receipt arrived is booked again once the receipt is linked
 * (src/accounting/classify-force.ts entriesWithoutTheirReceipts): the usability test of
 * 2026-10-15 lost every receipt's VAT because the statement was booked first. So is a payment whose
 * receipt's VAT facts a person corrected (unbookPayments, 'facts').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesWithoutTheirReceipts, unbookPayments } from '../src/accounting/classify-force.js';
import type { JournalEntry } from '../src/types/index.js';

const je = (ref: string, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `${ref}-1`, transactionRef: ref, date: '2026-07-03', accountDebit: '4400', accountCredit: '1020', amount: 100, vatCode: 'M0', origin: 'classify', receipts: [], ...x });

test('only the classifier\'s open bookings whose linked receipts changed are booked again', () => {
  const entries = [
    je('late'),                                      // booked without a receipt, one linked since
    je('same', { receipts: ['r-same'] }),            // booked with the receipt it still has
    je('old', { receipts: undefined }),              // booked before the field existed: left alone
    je('hand', { origin: 'manual' }),                // a person's booking: left alone
    je('filed', { date: '2026-03-10' }),             // a filed quarter: left alone
    je('gone', { receipts: ['r-gone'] }),            // its receipt was unlinked since
  ];
  const mappings = ['late', 'same', 'old', 'hand', 'filed'].map((ref) => ({ transactionRef: ref, receiptId: `r-${ref}` }));
  const refs = new Set(entries.map((e) => e.transactionRef));
  assert.deepEqual(entriesWithoutTheirReceipts(entries, mappings, refs, '2026-06-30').map((e) => e.transactionRef).sort(), ['gone', 'late']);
});

test('new VAT facts take away only the classifier\'s open bookings of the receipt\'s payments, as --force would', () => {
  const entries = [
    je('auto', { receipts: ['r'] }),                 // the classifier's, open: booked again
    je('hand', { origin: 'manual' }),                // a person's booking: left alone
    je('mixed'), je('mixed', { id: 'mixed-2', origin: 'manual' }), // one of them a person's: the payment stays as it is
    je('legacy', { origin: undefined }),             // booked before origin existed: the classifier's, as for --force
    je('filed', { date: '2026-03-10' }),             // a filed quarter: left alone
    je('other'),                                     // a payment of another receipt
  ];
  const books = {
    mappings: ['auto', 'hand', 'mixed', 'legacy', 'filed'].map((ref) => ({ transactionRef: ref, receiptId: 'r' })).concat({ transactionRef: 'other', receiptId: 'x' }),
    journalEntries: entries,
    transactions: entries.map((e) => ({ ref: e.transactionRef })),
    config: { closedThrough: '2026-06-30' },
  };
  assert.deepEqual(unbookPayments(books, books.mappings.filter((m) => m.receiptId === 'r').map((m) => m.transactionRef), 'facts'), ['auto', 'legacy']);
  assert.deepEqual(books.journalEntries.map((e) => e.id), entries.filter((e) => !['auto', 'legacy'].includes(e.transactionRef)).map((e) => e.id));
});
