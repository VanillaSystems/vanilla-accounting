/**
 * An entry against the receipts of its payment (src/accounting/evidence-check.ts): an input-tax zero
 * code while a receipt shows Swiss VAT, or a rate code while no receipt shows it. The entry is never
 * rebooked by itself; the check names the code a click would set. Filed quarters, corrections and
 * sales codes are never flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';

const entry = (over: Partial<JournalEntry>): JournalEntry =>
  ({ id: 'e1', transactionRef: 'T1', date: '2026-09-09', accountDebit: '4400', accountCredit: '1021', amount: 158.6, vatCode: 'M0', origin: 'manual', ...over });

const receipt = (over: Partial<Receipt>): Receipt => ({ id: 'r1', filename: 'baucenter.pdf', ...over } as Receipt);

const withVat = receipt({ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 11.89, gross: 158.6 }], vatId: 'CHE-123.456.789 MWST' });
const noVat = receipt({ id: 'r2', hasSwissVat: false, vatSummary: [] });
const unread = receipt({ id: 'r3' });

const CLOSED = '2026-06-30';

test('a zero code while the linked receipt shows 8.1 %: the rate code of the same family, with the receipts seen', () => {
  assert.deepEqual(evidenceCheck(entry({ vatCode: 'M0' }), [withVat], CLOSED), { kind: 'receiptShowsVat', rate: 8.1, code: 'M81', receipts: ['r1'] });
  assert.deepEqual(evidenceCheck(entry({ vatCode: 'I0', accountDebit: '6500' }), [withVat, noVat], CLOSED), { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['r1', 'r2'] });
});

test('a refund keeps its minus', () => {
  assert.deepEqual(evidenceCheck(entry({ vatCode: '-M0', accountDebit: '1021', accountCredit: '4400' }), [withVat], CLOSED), { kind: 'receiptShowsVat', rate: 8.1, code: '-M81', receipts: ['r1'] });
  assert.deepEqual(evidenceCheck(entry({ vatCode: '-M81', accountDebit: '1021', accountCredit: '4400' }), [], CLOSED), { kind: 'vatWithoutReceipt', code: '-M0' });
});

test('a rate code without a receipt that shows Swiss VAT: the zero code of the same family', () => {
  assert.deepEqual(evidenceCheck(entry({ vatCode: 'M81' }), [], CLOSED), { kind: 'vatWithoutReceipt', code: 'M0' });
  assert.deepEqual(evidenceCheck(entry({ vatCode: 'I81', accountDebit: '6500' }), [noVat], CLOSED), { kind: 'vatWithoutReceipt', code: 'I0' });
});

test('only a purchase document is evidence: the company\'s own sales record (Kassenbericht, payout report) shows output tax, never input tax', () => {
  const sales = receipt({ id: 'r4', kind: 'sales-record', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 773.69, gross: 10325.4 }] });
  assert.equal(evidenceCheck(entry({ vatCode: 'I0', accountDebit: '6840', amount: 152.21 }), [sales], CLOSED), undefined);
  assert.equal(evidenceCheck(entry({ vatCode: 'I81', accountDebit: '6840', amount: 152.21 }), [sales], CLOSED), undefined, 'a sales record says nothing about the fee either way');
  assert.equal(evidenceCheck(entry({ vatCode: 'M0' }), [receipt({ id: 'r5', kind: 'supporting', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 1, gross: 10 }] })], CLOSED), undefined);
});

test('a booking that fits its receipt is not flagged', () => {
  assert.equal(evidenceCheck(entry({ vatCode: 'M81' }), [withVat], CLOSED), undefined);
  assert.equal(evidenceCheck(entry({ vatCode: 'M0' }), [noVat], CLOSED), undefined);
  assert.equal(evidenceCheck(entry({ vatCode: 'M0' }), [], CLOSED), undefined);
});

test('a receipt not read yet is no evidence either way', () => {
  assert.equal(evidenceCheck(entry({ vatCode: 'M81' }), [unread], CLOSED), undefined);
  assert.equal(evidenceCheck(entry({ vatCode: 'M0' }), [unread], CLOSED), undefined);
});

test('a filed quarter, a correction, a sale, a VAT-amount code and no code are never flagged', () => {
  assert.equal(evidenceCheck(entry({ vatCode: 'M0', date: '2026-05-10' }), [withVat], CLOSED), undefined, 'filed quarter');
  assert.equal(evidenceCheck(entry({ vatCode: 'M0', corrects: '2026-Q2' }), [withVat], CLOSED), undefined, 'correction');
  assert.equal(evidenceCheck(entry({ vatCode: 'V0', accountDebit: '1021', accountCredit: '3200' }), [withVat], CLOSED), undefined, 'a sale');
  assert.equal(evidenceCheck(entry({ vatCode: 'V81', accountDebit: '1021', accountCredit: '3200' }), [], CLOSED), undefined, 'a sale');
  assert.equal(evidenceCheck(entry({ vatCode: 'M81-2', accountDebit: '' }), [], CLOSED), undefined, 'a VAT-amount correction');
  assert.equal(evidenceCheck(entry({ vatCode: undefined }), [withVat], CLOSED), undefined, 'no code');
  assert.equal(evidenceCheck(entry({ vatCode: 'B81-1' }), [], CLOSED), undefined, 'Bezugsteuer');
});

test('without a closed period every entry is checked', () => {
  assert.deepEqual(evidenceCheck(entry({ vatCode: 'M0', date: '2026-05-10' }), [withVat], undefined), { kind: 'receiptShowsVat', rate: 8.1, code: 'M81', receipts: ['r1'] });
});
