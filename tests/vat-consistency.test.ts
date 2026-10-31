/**
 * The VAT consistency audit (src/reconcile/vat-consistency.ts) names no business (issue #264): a 0-code
 * line beside a Swiss-VAT receipt is a bank fee, not a missed deduction, when it is on an account the
 * bank's own fee movements are booked on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditVat } from '../src/reconcile/vat-consistency.js';
import type { Index } from '../src/types/index.js';

const swissReceipt = (id: string) => ({ id, hasSwissVat: true, vatExtractedAt: '2026-07-01', vatSummary: [{ ratePercent: 8.1, vat: 8.1 }] });
const entry = (id: string, transactionRef: string, accountDebit: string, vatCode: string) =>
  ({ id, transactionRef, date: '2026-07-10', accountDebit, accountCredit: '1020', amount: 1, vatCode, description: `line ${id}` });

function books(withFeeMovement: boolean): Index {
  return {
    transactions: [
      { ref: 'CARD-1', date: '2026-07-10', amount: -100, currency: 'CHF' },
      { ref: 'TX-2', date: '2026-07-10', amount: -50, currency: 'CHF' },
      ...(withFeeMovement ? [{ ref: 'FEE-CARD-1', type: 'wise-fee', date: '2026-07-10', amount: -1, currency: 'CHF' }] : []),
    ],
    receipts: [swissReceipt('r1'), swissReceipt('r2')],
    mappings: [
      { transactionRef: 'CARD-1', receiptId: 'r1' },
      { transactionRef: 'TX-2', receiptId: 'r2' },
      ...(withFeeMovement ? [{ transactionRef: 'FEE-CARD-1', receiptId: 'r1' }] : []),
    ],
    journalEntries: [
      entry('expense', 'CARD-1', '6500', 'I81'),
      entry('fee-on-charge', 'CARD-1', '6940', 'I0'),
      entry('missed', 'TX-2', '6500', 'I0'),
      ...(withFeeMovement ? [entry('fee-movement', 'FEE-CARD-1', '6940', 'I0')] : []),
    ],
  } as unknown as Index;
}

const flagged = (index: Index) => auditVat(index).zeroCodeButSwissReceipt.map((l) => l.split('  ')[2]);

test('a 0-code line on the account the bank fee movements are booked on is no missed deduction', () => {
  assert.deepEqual(flagged(books(true)), ['line missed']);
});

test('without a fee movement of the bank no account is a fee account, and every such 0-code line is flagged', () => {
  assert.deepEqual(flagged(books(false)), ['line fee-on-charge', 'line missed']);
});
