/**
 * validateJournalEntries: the account-class warnings for a VAT code. An I-code belongs on an
 * operating expense or a capitalised investment (Anlagevermögen, 1500–1799), so a laptop booked
 * to 1520 with I81 is sound, and the same code on a bank or a revenue account is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJournalEntries } from '../src/accounting/validate.js';
import type { JournalEntry } from '../src/types/index.js';

const entry = (accountDebit: string, vatCode: string): JournalEntry => ({
  id: `e-${accountDebit}`, transactionRef: 'T1', date: '2026-08-01', accountDebit, accountCredit: '1020', amount: 2349, vatCode,
});
const accounts = new Set(['1020', '1140', '1520', '1700', '1800', '3400', '6570']);
const warnings = (e: JournalEntry) => validateJournalEntries([e], accounts, null, [{ transactionRef: 'T1', receiptId: 'r' }])
  .filter((i) => i.severity === 'warning').map((i) => i.message);

test('an I-code on an expense or an investment account is valid; elsewhere it warns', () => {
  assert.deepEqual(warnings(entry('6570', 'I81')), []);
  assert.deepEqual(warnings(entry('1520', 'I81')), [], 'a laptop capitalised on 1520');
  assert.deepEqual(warnings(entry('1700', 'I81')), [], 'an intangible asset');
  for (const account of ['1140', '1800', '3400']) {
    assert.deepEqual(warnings(entry(account, 'I81')), ['I-Code ohne Aufwand- oder Anlagekonto (5xxx/6xxx, 1500–1799)'], account);
  }
});
