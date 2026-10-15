import test from 'node:test';
import assert from 'node:assert/strict';
import { accountForStatement } from '../src/accounting/bank-accounts.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';

const KNOWN = ['CH56', '0483', '5012', '3456', '7800', '9'].join('');
const OTHER = ['CH93', '0076', '2011', '6238', '5295', '7'].join('');
const raiffeisen = { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', iban: KNOWN, statements: 'camt053' } as unknown as LedgerBankAccount;

test('a statement of an account the books lack names its IBAN and currency, for the UI to offer adding it', () => {
  const none = accountForStatement([raiffeisen], { iban: OTHER, currency: 'EUR', folder: '' });
  assert.ok('problem' in none);
  assert.deepEqual(none.unknown, { iban: OTHER, currency: 'EUR' });
});

test('the same bank folder with another IBAN is the same refusal, with the IBAN to add', () => {
  const other = accountForStatement([raiffeisen], { iban: OTHER, currency: 'CHF', folder: 'Raiffeisen' });
  assert.ok('problem' in other);
  assert.deepEqual(other.unknown, { iban: OTHER, currency: 'CHF' });
});

test('a statement of a known account is matched, not refused', () => {
  const ok = accountForStatement([raiffeisen], { iban: KNOWN, currency: 'CHF', folder: '' });
  assert.ok('account' in ok);
});
