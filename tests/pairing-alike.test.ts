/**
 * Receipts and payments nothing tells apart: n payments and n receipts of one supplier, of one
 * amount, each side on one day. Which receipt goes with which payment changes no booking, so the
 * chain pairs them one to one in a stable order instead of leaving all of them to the person. Where
 * the candidates differ (a day, a name, how many there are), the choice stays the model's or the
 * person's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { searchPairs, stagesOf } from '../src/intake/pairing.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import type { Books } from '../src/books/store.js';
import type { Ask } from '../src/intake/pipeline.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const toChf = (a: number, c: string) => (c === 'EUR' ? a * 0.94 : a);
const receipt = (id: string, over: Partial<Receipt> = {}): Receipt => ({
  // Two labels of one day are two documents, not one twice (duplicatesIn): their texts differ.
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `Quittung Sendung ${id}x Empfänger ${id}y Strasse ${id}z`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date: '2026-08-19', amount: 7.5, currency: 'CHF', title: { vendor: 'Kiosk Muster', what: 'Porto' }, ...over,
});
const card = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: 'Wise', date: '2026-08-19', amount: 7.98, currency: 'EUR', direction: 'DBIT', description: 'Card transaction of 7.50 CHF issued by Kiosk Muster Bern', ...over,
});
const books = (receipts: Receipt[], transactions: BankTransaction[]): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const kinds = (b: Books) => stagesOf(searchPairs(b, toChf, () => false)).map((s) => s.kind);
const pairs = (b: Books) => b.mappings.map((m) => `${m.receiptId}>${m.transactionRef}`).sort();

test('two alike payments and two alike receipts are paired one to one in a stable order, without a model', async () => {
  const b = books([receipt('r2'), receipt('r1')], [card('c2'), card('c1')]);
  assert.deepEqual(kinds(b), ['clear', 'clear']);
  const result = await runPairChain(port(b), { toChf });
  assert.deepEqual(pairs(b), ['r1>c1', 'r2>c2']);
  assert.equal(result.left.length, 0, 'none is left for the person');
});

test('three alike of each: every payment holds one receipt, whichever order they came in', async () => {
  const b = books([receipt('r3'), receipt('r1'), receipt('r2')], [card('c2'), card('c3'), card('c1')]);
  await runPairChain(port(b), { toChf });
  assert.deepEqual(pairs(b), ['r1>c1', 'r2>c2', 'r3>c3']);
});

test('the model checks each pair of an alike set like any clear pair', async () => {
  const b = books([receipt('r1'), receipt('r2')], [card('c1'), card('c2')]);
  const details: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    details.push(opts?.detail ?? '');
    const n = JSON.parse(prompt.match(/\n\n(\[[\s\S]*\])\n\n/)![1]).length;
    return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, fits: true, why: 'names the vendor' })));
  };
  await runPairChain(port(b), { toChf, ask });
  assert.deepEqual(details, ['check']);
  assert.deepEqual(b.mappings.map((m) => m.rule?.split(':')[0]), ['pair-checked', 'pair-checked']);
  assert.deepEqual(pairs(b), ['r1>c1', 'r2>c2']);
});

test('unequal counts stay a choice: two receipts and three payments, or three receipts and two payments', () => {
  assert.deepEqual(kinds(books([receipt('r1'), receipt('r2')], [card('c1'), card('c2'), card('c3')])), ['short', 'short']);
  assert.deepEqual(kinds(books([receipt('r1'), receipt('r2'), receipt('r3')], [card('c1'), card('c2')])), ['short', 'short', 'short']);
});

test('candidates that differ stay a choice: a payment on another day, or one that names another shop', () => {
  assert.deepEqual(kinds(books([receipt('r1'), receipt('r2')], [card('c1'), card('c2', { date: '2026-08-20' })])), ['short', 'short']);
  const other = card('c2', { description: 'Card transaction of 7.50 CHF issued by Kiosk Bahnhof' });
  assert.deepEqual(kinds(books([receipt('r1'), receipt('r2')], [card('c1'), other])), ['short', 'short']);
});

test('receipts of another amount do not join the set: each pair of its own amount stays as clear as it was', async () => {
  const b = books([receipt('r1'), receipt('r2'), receipt('big', { amount: 12 })], [card('c1'), card('c2'), card('cb', { amount: 12.77, description: 'Card transaction of 12.00 CHF issued by Kiosk Muster Bern' })]);
  await runPairChain(port(b), { toChf });
  assert.deepEqual(pairs(b), ['big>cb', 'r1>c1', 'r2>c2']);
});
