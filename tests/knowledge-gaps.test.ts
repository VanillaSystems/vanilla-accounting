/**
 * npm run gaps: a transaction counts as a gap only when no knowledge file claims it, by its bank
 * text or by a receipt linked to it; gaps of one merchant group across months and card numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { knowledgeGaps } from '../src/knowledge/gaps.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const counterparties = [
  compileCounterparty({ id: 'post', name: 'Post', match: { tx: ['post cH'] } }, { binding: 'post.yaml' }),
  compileCounterparty({ id: 'acme', name: 'Acme', match: { uid: ['CHE-153.004.184'] } }, { binding: 'acme.yaml' }),
];

const tx = (ref: string, description: string, more: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: 'UBS', date: '2026-07-15', amount: 10, currency: 'CHF', direction: 'DBIT', description, ...more,
});
const receipt = { id: 'r1', filename: 'acme-invoice.pdf', extractedText: 'Acme AG CHE-153.004.184 MWST' } as Receipt;

test('only unrouted transactions count, grouped by merchant across months and numbers', () => {
  const gaps = knowledgeGaps([
    tx('T1', 'Post CH AG Bern'),
    tx('T2', 'Zahlung Miete Büro Musterweg 3, Juli'),
    tx('T3', 'Zahlung Miete Büro Musterweg 3, August'),
    tx('T4', 'Card transaction of 12.00 USD issued by EXAMPLE*CLOUD 4411 SAN FRANCISCO'),
    tx('T5', 'Card transaction of 12.00 USD issued by EXAMPLE*CLOUD 9902 SAN FRANCISCO'),
    tx('T6', 'Card transaction of 30.00 CHF issued by Shop 7 Zug'),
    tx('T7', 'Card transaction of 30.00 CHF issued by Shop 7 Zug', { type: 'wise-fee' }),
  ], { mappings: [{ transactionRef: 'T6', receiptId: 'r1' }], receipts: [receipt] }, counterparties);

  assert.deepEqual(gaps, [
    { merchant: 'example cloud san francisco', count: 2, example: 'T4' },
    { merchant: 'miete büro musterweg', count: 2, example: 'T2' },
  ]);
});
