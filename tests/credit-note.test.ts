/**
 * A supplier's credit note (persona round 3, corner-34/35): its amount is money back, negative,
 * and the refund on the bank is linked to it by code, by amount, direction and its number in the
 * payment's text, in the inbox run that brings the statement, without the model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { creditSigned, linkByCode, matchStep } from '../src/intake/match.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { Workspace } from '../src/workspace/workspace.js';

const GS: Receipt = {
  id: 'gs', filename: '20261006_Farbmix_Gutschrift.pdf', location: 'archived', date: '2026-10-06', amount: -408.6, currency: 'CHF',
  extractedText: 'Farbmix AG Gutschrift GS-1207 zu Rechnung FM-78230 Netto -378.00 MWST 8.1% -30.60 Total CHF -408.60',
  vatSummary: [{ ratePercent: 8.1, net: -378, vat: -30.6, gross: -408.6 }],
} as Receipt;
const refund: BankTransaction = { ref: 'RB-30', bank: 'Raiffeisen', date: '2026-10-08', amount: 408.6, currency: 'CHF', direction: 'CRDT', description: 'Gutschrift Farbmix AG Gutschrift GS-1207 zu FM-78230' };
const books = (over: Partial<Books> = {}): Books => ({
  receipts: [structuredClone(GS)], transactions: [structuredClone(refund)], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' }, ...over,
});

test('a credit note read with a positive total is stored negative; an invoice keeps its sign', () => {
  assert.equal(creditSigned({ amount: 408.6, vatSummary: GS.vatSummary }), -408.6);
  assert.equal(creditSigned({ amount: -408.6, vatSummary: GS.vatSummary }), -408.6);
  assert.equal(creditSigned({ amount: 408.6, vatSummary: [{ ratePercent: 8.1, net: 378, vat: 30.6, gross: 408.6 }] }), 408.6);
  assert.equal(creditSigned({ amount: 50, vatSummary: [] }), 50, 'no VAT facts: nothing to say');
});

test('the refund is linked to the credit note by amount, direction and number', () => {
  const b = books();
  assert.deepEqual(linkByCode(b), [{ receipt: 'gs', payment: 'RB-30' }]);
  assert.deepEqual(b.mappings, [{ transactionRef: 'RB-30', receiptId: 'gs' }]);
  assert.deepEqual(linkByCode(b), [], 'linked once');
});

test('no link without the number, against the direction, at another amount, twice the same, or in a filed quarter', () => {
  const none = (over: Partial<Books>) => assert.deepEqual(linkByCode(books(over)), []);
  none({ transactions: [{ ...refund, description: 'Gutschrift Farbmix AG' }] });
  none({ transactions: [{ ...refund, direction: 'DBIT' }] });
  none({ transactions: [{ ...refund, amount: 408.5 }] });
  none({ transactions: [refund, { ...refund, ref: 'RB-31' }] });
  none({ transactions: [{ ...refund, date: '2026-09-28' }] });
  none({ receipts: [{ ...GS, location: 'staged' }] });
});

test('the inbox run links it without the model, before anything else', async () => {
  const b = books();
  const port = { read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) };
  await matchStep({ ws: { paths: { inbox: '/nowhere' } } as Workspace, books: port, progress: () => {}, log: () => {} });
  assert.deepEqual(b.mappings, [{ transactionRef: 'RB-30', receiptId: 'gs' }]);
});
