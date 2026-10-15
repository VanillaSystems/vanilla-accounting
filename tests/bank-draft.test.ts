/** Firma › Bankkonten filled in from a statement of an unknown account (src/app/areas/company/bank-draft.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftForm } from '../src/app/areas/company/bank-draft.js';

const RAIFFEISEN = { bank: 'Raiffeisen', currency: 'CHF', account: '1020' };
const IBAN = 'CH4431999123000889012';

test('the bank by its short name, the first free bank account of the chart, its own name as label', () => {
  assert.deepEqual(draftForm({ iban: IBAN, currency: 'CHF', bankName: 'Raiffeisenbank Wil und Umgebung' }, [], ['1000', '1020', '1021', '1100']),
    { bank: 'Raiffeisen', account: '1020', label: 'Raiffeisenbank Wil und Umgebung' });
  assert.deepEqual(draftForm({ iban: IBAN, currency: 'EUR', bankName: 'Valiant Bank AG' }, [RAIFFEISEN], ['1020', '1021']),
    { bank: 'Valiant', account: '1021', label: 'Valiant Bank AG' });
});

test('a bank that has an account in that currency already gets a second name; with the chart full the next number', () => {
  assert.deepEqual(draftForm({ iban: IBAN, currency: 'CHF', bankName: 'Raiffeisenbank Wil' }, [RAIFFEISEN, { bank: 'Wise', currency: 'EUR', account: '1023' }], ['1020', '1023']),
    { bank: 'Raiffeisen 2', account: '1024', label: 'Raiffeisenbank Wil' });
});

test('a statement without a name of its bank leaves the bank to the owner, still with an account', () => {
  assert.deepEqual(draftForm({ iban: IBAN, currency: 'CHF' }, [RAIFFEISEN], ['1020']), { bank: '', account: '1021', label: '' });
});
