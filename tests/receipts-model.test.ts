/**
 * Belege's list and link dialog (src/app/areas/receipts/model.ts): what a period shows, what
 * needs you, what is locked by a filed quarter, and which payments rank first for a receipt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { badgeCount, candidates, groups, ledgerOf, suggestion, visible, type ToChf } from '../src/app/areas/receipts/model.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number, x: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...x });

const books: Index = {
  config: { closedThrough: '2026-06-30' },
  receipts: [
    receipt('paper', { date: '2026-09-12', amount: 58.4, description: 'Muster Büro AG, Druckerpapier' }),
    receipt('linked', { date: '2026-09-02', amount: 20 }),
    receipt('filed', { date: '2026-06-10', amount: 10 }),
    receipt('undated', { amount: 7 }),
    receipt('brochure', { date: '2026-09-05', amount: 0 }),
    receipt('eur', { date: '2026-08-20', amount: 100, currency: 'EUR' }),
  ],
  transactions: [
    tx('T-paper', '2026-09-13', 58.4),
    tx('T-near', '2026-09-12', 61),
    tx('T-linked', '2026-09-03', 20),
    tx('T-closed', '2026-06-11', 10),
    tx('T-fee', '2026-09-12', 58.4, { type: 'wise-fee' }),
    tx('T-eur', '2026-08-21', 100, { currency: 'EUR' }),
    tx('T-chf-for-eur', '2026-08-21', 94),
  ],
  mappings: [
    { receiptId: 'linked', transactionRef: 'T-linked' },
    { receiptId: 'filed', transactionRef: 'T-closed' },
  ],
  bankStatements: [],
};
const l = ledgerOf(books, '2026-07-01');
const q3 = parsePeriod('2026-Q3', '2026-10-11')!;
const flat: ToChf = (amount, currency) => amount * (currency === 'EUR' ? 0.94 : 1);
const view = (id: string) => l.byId.get(id)!;

test('a receipt linked to a payment of a filed quarter is locked; the vendor comes from the description', () => {
  assert.equal(view('filed').locked, true);
  assert.equal(view('paper').locked, false);
  assert.deepEqual([view('paper').vendor, view('paper').desc], ['Muster Büro AG', 'Druckerpapier']);
});

test('a period shows its receipts, counts them per filter, and hides what is no receipt', () => {
  const v = visible(l, q3, undefined, undefined);
  assert.deepEqual(v.rows.map((x) => x.r.id).sort(), ['eur', 'linked', 'paper', 'undated']);
  assert.deepEqual(v.counts, { alle: 4, zugeordnet: 1, offen: 3, ohneDatum: 1 });
  assert.deepEqual(v.hidden.map((x) => x.r.id), ['brochure']);
  assert.deepEqual(visible(l, q3, 'offen', 'druckerpapier').rows.map((x) => x.r.id), ['paper']);
});

test('what needs you comes first, an open receipt without a date with it, then each month', () => {
  const { rows } = visible(l, q3, undefined, undefined);
  const g = groups(rows, l, undefined, (x) => x.r.id === 'eur');
  assert.deepEqual(g.groups.map((x) => [x.key, x.rows.map((r) => r.r.id)]), [
    ['need', ['eur', 'paper', 'undated']],
    ['month:2026-09', ['linked']],
  ]);
  assert.deepEqual(g.later.map((x) => x.r.id), []);
  assert.equal(badgeCount(l), 3);
});

test('the payment of the same amount and the nearest date ranks first; fees, closed and linked payments never show', () => {
  const { best, more } = candidates(view('paper'), l, flat);
  const refs = [...best, ...more].map((c) => c.tx.ref);
  assert.equal(best[0].tx.ref, 'T-paper');
  assert.ok(best[0].sameAmount);
  assert.equal(best[0].days, 1);
  for (const gone of ['T-fee', 'T-closed']) assert.ok(!refs.includes(gone), gone);
  assert.deepEqual(candidates(view('linked'), l, flat).best.map((c) => c.tx.ref).includes('T-linked'), false);
});

test('a foreign receipt ranks its own currency above a CHF payment of the same value', () => {
  const { best } = candidates(view('eur'), l, flat);
  assert.deepEqual(best.slice(0, 2).map((c) => c.tx.ref), ['T-eur', 'T-chf-for-eur']);
});

test('a search finds payments by text; one exact fit becomes the suggestion', () => {
  assert.deepEqual(candidates(view('paper'), l, flat, 't-near').more.map((c) => c.tx.ref), ['T-near']);
  assert.equal(suggestion(view('paper'), l, flat)?.tx.ref, 'T-paper');
  assert.equal(suggestion(view('linked'), l, flat), undefined);
});
