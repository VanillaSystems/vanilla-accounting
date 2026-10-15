/**
 * A payment booked before its receipt arrived is booked again once the receipt is linked
 * (src/accounting/classify-force.ts entriesWithoutTheirReceipts): the usability test of
 * 2026-10-15 lost every receipt's VAT because the statement was booked first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesWithoutTheirReceipts } from '../src/accounting/classify-force.js';
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
