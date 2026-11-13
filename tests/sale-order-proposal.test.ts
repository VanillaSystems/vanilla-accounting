/**
 * A customer's bank transfer that names an order of a provider's order export, one the provider did
 * not collect (paid by bank deposit, #406, webshop-ai-16): the sale question proposes from that
 * order's tax and says so; an order whose rate the question cannot book proposes as before.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderProposal, type PaidElsewhere } from '../src/accounting/sales-without-vat.js';
import { saleQuestionLine } from '../src/intake/sale-questions.js';
import { parseLine } from '../src/questions/model.js';
import type { BankTransaction } from '../src/types/index.js';

// The webshop persona's orders export: #1099 (teapot and whisk, 8.1 %) and #1220 paid by «Bank Deposit».
const ORDERS: PaidElsewhere[] = [
  { provider: 'Shopify', order: '#1099', gross: 165, currency: 'CHF', tax: 12.36, shipTo: 'CH' },
  { provider: 'Shopify', order: '#1220', gross: 84, currency: 'CHF', tax: 6.29, shipTo: 'CH' },
  { provider: 'Shopify', order: '#1300', gross: 60, currency: 'CHF', tax: 0, shipTo: 'DE' },
  { provider: 'Shopify', order: '#1301', gross: 33, currency: 'CHF', tax: 0.84, shipTo: 'CH' },
];
const tx = (description: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref: 'T1', bank: 'LUKB', date: '2026-07-20', amount, currency: 'CHF', direction: 'CRDT', description, counterparty: 'Julia Studer', ...over });

test('a transfer naming an order paid elsewhere proposes from the order: its rate, its provider, its name', () => {
  assert.deepEqual(orderProposal(tx('Bestellung #1099', 165), ORDERS), { choice: 'saleDomestic', why: 'order', order: { provider: 'Shopify', name: '#1099', rate: 8.1 } });
  assert.deepEqual(orderProposal(tx('Zahlung', 165, { reference: 'Bestellung 1099' }), ORDERS)?.order?.name, '#1099', 'without the #, in the reference');
  assert.deepEqual(orderProposal(tx('Order 1300', 60), ORDERS), { choice: 'saleAbroad', why: 'order', order: { provider: 'Shopify', name: '#1300', rate: 0 } }, 'no tax, delivered abroad: an export');
});

test('no proposal from an order when the amount differs, the number is part of another, or the rate is one the question cannot book', () => {
  assert.equal(orderProposal(tx('Bestellung #1099', 160), ORDERS), undefined);
  assert.equal(orderProposal(tx('Bestellung #11099', 165), ORDERS), undefined);
  assert.equal(orderProposal(tx('Bestellung #1301', 33), ORDERS), undefined, 'tea at the reduced rate: the choices book the normal rate only');
  assert.equal(orderProposal(tx('Bestellung #1099', 165, { currency: 'EUR' }), ORDERS), undefined);
});

test('the question carries the order\'s proposal and reads back with it', () => {
  const line = saleQuestionLine({ company: { owner: 'Corinne' } } as never, tx('Bestellung #1099', 165), '2026-07-21T09:00:00.000Z', ORDERS);
  assert.deepEqual(line.proposal, { choice: 'saleDomestic', why: 'order', order: { provider: 'Shopify', name: '#1099', rate: 8.1 } });
  const back = parseLine(JSON.parse(JSON.stringify(line)));
  assert.deepEqual(back?.event === 'asked' ? back.proposal : undefined, line.proposal, 'kept in the questions file with its order');
  assert.deepEqual(saleQuestionLine({ company: { owner: 'Corinne' } } as never, tx('Bestellung #1099', 165), '2026-07-21T09:00:00.000Z').proposal, { choice: 'saleDomestic', why: 'domesticCurrency' }, 'without the export: as before');
});
