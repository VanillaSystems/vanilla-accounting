/**
 * Zahlung verknüpfen, the ranking (src/app/areas/receipts/model.ts candidates), persona round 8:
 * r8k-5, a supplier invoice saw a customer's TWINT credit as «Passt am besten» while the collective
 * payment with its part of exactly the invoice's amount came 7th, unnamed; r8h-21, a payment 60
 * days and 20 % off was «Passt am besten» for a receipt without a date, and one stray Enter linked
 * it. A collective payment's exact part ranks first and names the part; money the wrong way is
 * never a best fit; nothing close means no best fit; a search reaches payments with a receipt.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { candidates, ledgerOf, suggestion, type ToChf } from '../src/app/areas/receipts/model.js';

const flat: ToChf = (amount) => amount;
const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-10-09T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number, x: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...x });

/** The coiffeur's October: a TWINT credit 66.60 off the invoice, a collective payment of 812.50 with the invoice's 512.50 as one part, and the rest. */
const COLLECTIVE = tx('RB-812', '2026-10-08', 812.5, {
  description: 'Zahlungsauftrag E-Banking 2 Zahlungen',
  parts: [
    { amount: 512.5, currency: 'CHF', counterparty: 'Beispiel Haarkosmetik AG', reference: 'HK-2026-10' },
    { amount: 300, currency: 'CHF', counterparty: 'Salonmiete Oktober' },
  ],
});
const books: Index = {
  config: { closedThrough: '2026-03-31' },
  receipts: [
    receipt('hk', { date: '2026-10-01', amount: 512.5, description: 'Beispiel Haarkosmetik, Farben Oktober 2026' }),
    receipt('gs', { date: '2026-10-01', amount: -80, description: 'Beispiel Haarkosmetik, Gutschrift' }),
    receipt('fm', { amount: 1537.22, description: 'Farbmix AG, Rechnung FM-79010' }),
    receipt('other', { date: '2026-09-15', amount: 99 }),
  ],
  transactions: [
    tx('TW-0928', '2026-09-28', 445.9, { direction: 'CRDT', description: 'TWINT Sammelgutschrift', counterparty: 'TWINT AG' }),
    COLLECTIVE,
    tx('RB-0930', '2026-09-30', 580, { description: 'Grosshandel Beauty' }),
    tx('RB-0805', '2026-08-05', 1890.35, { description: 'SVA Beitrag Q3', counterparty: 'SVA St. Gallen' }),
    tx('RB-refund', '2026-10-03', 80, { direction: 'CRDT', description: 'Rückvergütung Beispiel Haarkosmetik' }),
    tx('RB-out80', '2026-10-02', 80, { description: 'Coiffeurbedarf Shop' }),
  ],
  mappings: [{ receiptId: 'other', transactionRef: 'RB-0930' }],
  bankStatements: [],
};
const l = ledgerOf(books, '2026-10-01');
const view = (id: string) => l.byId.get(id)!;

test('r8k-5: the collective payment with a part of exactly the invoice\'s amount is the best fit, named by its part; the TWINT credit is not', () => {
  const { best, more } = candidates(view('hk'), l, flat);
  assert.equal(best[0]?.tx.ref, 'RB-812', JSON.stringify(best.map((c) => c.tx.ref)));
  assert.deepEqual(best[0].part, COLLECTIVE.parts![0], 'the row names the part that pays the receipt');
  assert.deepEqual(best[0].fit, { kind: 'same' }, 'no «Betrag weicht ab» on an exact part');
  assert.ok(!best.some((c) => c.tx.ref === 'TW-0928'), 'money in is never the best fit for a supplier invoice');
  assert.ok(more.some((c) => c.tx.ref === 'TW-0928'), 'but still listed further down');
  assert.equal(suggestion(view('hk'), l, flat)?.tx.ref, 'RB-812', 'and the one-key suggestion is the collective payment');
});

test('r8k-5: a search reaches a payment that already has a receipt, by the words of its parts and counterparty', () => {
  const taken = ledgerOf({ ...books, mappings: [...books.mappings, { receiptId: 'other', transactionRef: 'RB-812' }] }, '2026-10-01');
  const hk = taken.byId.get('hk')!;
  assert.deepEqual(candidates(hk, taken, flat, 'haarkosmetik').more.map((c) => c.tx.ref).sort(), ['RB-812', 'RB-refund'], 'the collective payment by a part\'s counterparty, though it holds a receipt');
  assert.deepEqual(candidates(hk, taken, flat, 'hk-2026-10').more.map((c) => c.tx.ref), ['RB-812'], 'a part\'s reference too');
  assert.deepEqual(candidates(hk, taken, flat, 'sva').more.map((c) => c.tx.ref), ['RB-0805'], 'the bank\'s counterparty');
});

test('a credit note (money back) never has money out as its best fit', () => {
  const { best } = candidates(view('gs'), l, flat);
  assert.deepEqual(best.map((c) => c.tx.ref), ['RB-refund']);
});

test('r8h-21: a payment 60 days and 20 % off is no «Passt am besten»: a receipt without a date that nothing fits has no best fit', () => {
  const { best, more } = candidates(view('fm'), l, flat);
  assert.deepEqual(best, [], JSON.stringify(best.map((c) => [c.tx.ref, c.score])));
  assert.ok(more.some((c) => c.tx.ref === 'RB-0805'), 'the SVA payment is still listed, further down');
  assert.equal(suggestion(view('fm'), l, flat), undefined);
});
