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

const plain = { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', statements: 'camt053' } as unknown as LedgerBankAccount;
const wise = { bank: 'Wise', currency: 'EUR', account: '1021', label: 'Wise', statements: 'wise' } as unknown as LedgerBankAccount;

test('a firm with one account in the statement\'s currency and no IBAN in the books takes the camt wherever it is dropped (r8k-3)', () => {
  const m = accountForStatement([plain, wise], { iban: OTHER, currency: 'CHF', folder: '' });
  assert.ok('account' in m && m.by === 'currency' && m.account.account === '1020');
  const eur = accountForStatement([plain, wise], { iban: 'BE68539007547034', currency: 'EUR', folder: '' });
  assert.ok('account' in eur && eur.account.account === '1021');
  const none = accountForStatement([plain, wise], { iban: OTHER, currency: 'USD', folder: '' });
  assert.ok('problem' in none);
  assert.deepEqual(none.refusal, { kind: 'noAccount', currency: 'USD', iban: OTHER });
});

test('two accounts in the currency without IBAN: no guess, the refusal is typed and offers the IBAN', () => {
  const second = { ...plain, bank: 'ZKB', account: '1022' } as unknown as LedgerBankAccount;
  const m = accountForStatement([plain, second], { iban: OTHER, currency: 'CHF', folder: '' });
  assert.ok('problem' in m);
  assert.deepEqual([m.refusal.kind, m.unknown], ['noAccount', { iban: OTHER, currency: 'CHF' }]);
});

test('an IBAN the books know is never asked for: a statement of another IBAN names the known account', () => {
  const m = accountForStatement([raiffeisen], { iban: OTHER, currency: 'CHF', folder: 'Raiffeisen' });
  assert.ok('problem' in m);
  assert.deepEqual(m.refusal, { kind: 'otherIban', currency: 'CHF', iban: OTHER, account: { bank: 'Raiffeisen', iban: KNOWN } });
  assert.deepEqual(m.unknown, { iban: OTHER, currency: 'CHF' });
});
