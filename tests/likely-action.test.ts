/**
 * The Aktionen menu's primary button (#216, src/app/selection/likely.ts): code proposes the most
 * likely action from what the object says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { likelyEntry, likelyPayment, likelyReceipt, likelySelection, type ReceiptFacts } from '../src/app/selection/likely.js';

const receipt = (f: Partial<ReceiptFacts> = {}): ReceiptFacts => ({ none: false, linked: false, locked: false, suggestion: false, paidPrivately: false, dated: true, ...f });

test('a receipt without a payment: the fitting payment, else paid privately when its text says so, else the link dialog', () => {
  assert.equal(likelyReceipt(receipt({ suggestion: true, paidPrivately: true })), 'accept', 'a payment that fits beats the words');
  assert.equal(likelyReceipt(receipt({ paidPrivately: true })), 'private');
  assert.equal(likelyReceipt(receipt()), 'link');
  assert.equal(likelyReceipt(receipt({ dated: false })), 'edit', 'no payment fits a receipt without its day');
});

test('a receipt set aside, linked or filed', () => {
  assert.equal(likelyReceipt(receipt({ none: true })), 'mark');
  assert.equal(likelyReceipt(receipt({ linked: true, paidPrivately: true })), 'openPayment');
  assert.equal(likelyReceipt(receipt({ locked: true })), undefined);
});

test('a payment: its receipt first while it waits for one, else booking it, else its entry', () => {
  assert.equal(likelyPayment({ unbooked: true, needsReceipt: true, locked: false, booked: false }), 'findReceipt');
  assert.equal(likelyPayment({ unbooked: true, needsReceipt: false, locked: false, booked: false }), 'book');
  assert.equal(likelyPayment({ unbooked: false, needsReceipt: false, locked: false, booked: true }), 'openEntry');
  assert.equal(likelyPayment({ unbooked: true, needsReceipt: true, locked: true, booked: false }), undefined, 'a filed payment is not booked by hand');
});

test('an entry: change it, or correct a filed one in the open period; the year-end revaluation is not changed by hand', () => {
  assert.equal(likelyEntry({ locked: false, yearClose: false }), 'edit');
  assert.equal(likelyEntry({ locked: true, yearClose: false }), 'correct');
  assert.equal(likelyEntry({ locked: false, yearClose: true }), undefined);
});

test('a selection: what most of its rows want', () => {
  assert.equal(likelySelection('receipt', { n: 4, open: 3, unbooked: 0, noReceipt: 0 }), 'findPayment');
  assert.equal(likelySelection('receipt', { n: 4, open: 1, unbooked: 0, noReceipt: 0 }), undefined);
  assert.equal(likelySelection('payment', { n: 4, open: 0, unbooked: 2, noReceipt: 4 }), 'book');
  assert.equal(likelySelection('payment', { n: 4, open: 0, unbooked: 0, noReceipt: 3 }), 'noReceiptNeeded');
  assert.equal(likelySelection('entry', { n: 2, open: 0, unbooked: 0, noReceipt: 0 }), 'account');
});
