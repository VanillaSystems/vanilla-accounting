/**
 * Where a drop's files landed and what came of them (src/app/shell/drop-summary.ts, F10, #341): the
 * page behind the drop window moves to the period most of the taken files landed in, unless the
 * period on screen holds it; a receipt without a date of its own does not decide; the window's
 * last lines count the payments and receipts from the books; the bar moves with the run's step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesIn, dropProgress, dropSummary, landedPeriod, majorityPeriod, ownDate } from '../src/app/shell/drop-summary.js';
import { parsePeriod } from '../src/accounting/periods.js';
import type { DropRow } from '../src/types/drop.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { Question } from '../src/questions/model.js';

const TODAY = '2026-11-12';
const q = (token: string) => parsePeriod(token, TODAY)!;
const row = (key: string, extra: Partial<DropRow> = {}): DropRow => ({ key, id: key, name: `${key}.pdf`, size: 1, state: 'taken', ...extra });
const statement = row('s', { kind: 'camt', facts: { from: '2026-10-01', to: '2026-10-31' }, statement: { file: 's.xml', refs: ['a'] } });
const dates: Record<string, string[]> = { r1: ['2026-06-12'], r2: ['2026-10-21'], s: ['2026-10-31'] };
const datesOf = (r: DropRow) => dates[r.id] ?? [];

test('an October statement dropped while Q2 is shown moves the page to Q4', () => {
  assert.equal(landedPeriod([statement], datesOf, q('2026-Q2'), TODAY, 'quarter')?.token, '2026-Q4');
});

test('the period on screen holds where the files landed: the page stays', () => {
  assert.equal(landedPeriod([statement], datesOf, q('2026-Q4'), TODAY, 'quarter'), undefined);
  assert.equal(landedPeriod([statement], datesOf, q('2026'), TODAY, 'quarter'), undefined);
});

test('a receipt counts once it has its date; a file not taken does not count', () => {
  assert.equal(landedPeriod([row('r9')], datesOf, q('2026-Q2'), TODAY, 'quarter'), undefined, 'not read yet');
  assert.equal(landedPeriod([row('r1'), row('r2', { state: 'duplicate' })], datesOf, q('2026-Q4'), TODAY, 'quarter')?.token, '2026-Q2');
  assert.equal(landedPeriod([row('r2')], datesOf, q('2026-Q2'), TODAY, 'half')?.token, '2026-H2');
});

// The persona's drop (#341): a Q3 statement with 23 payments, receipts of Q3, one till photo dated today.
const payments = Array.from({ length: 23 }, (_, i): BankTransaction => ({
  ref: `p${i}`, date: i < 8 ? '2026-07-15' : i < 16 ? '2026-08-15' : '2026-09-15', amount: 100 + i, currency: 'CHF', direction: i % 5 ? 'DBIT' : 'CRDT', bank: 'Raiffeisen', description: `Zahlung ${i}`,
  ...(i >= 12 && i < 20 ? { waitsForReceipt: { since: '2026-11-12' } } : {}),
} as BankTransaction));
const receipts: Array<Pick<Receipt, 'id' | 'date' | 'dateSource' | 'location'>> = [
  { id: 'a', date: '2026-07-03', location: 'archived' }, { id: 'b', date: '2026-08-06', location: 'archived' }, { id: 'c', date: '2026-06-28', location: 'archived' },
  { id: 'today', date: TODAY, location: 'archived' }, { id: 'phone', date: TODAY, dateSource: 'captured', location: 'archived' }, { id: 'staged', location: 'staged' },
];
const rows = [row('q3', { kind: 'camt', facts: { from: '2026-07-01', to: '2026-09-30' }, statement: { file: 'q3.xml', refs: payments.map((p) => p.ref) } }), ...receipts.map((r) => row(r.id)), row('dup', { state: 'duplicate' })];
const receiptOf = (r: DropRow) => receipts.find((x) => x.id === r.id);
const books = { transactions: payments, mappings: [{ receiptId: 'a', transactionRef: 'p1' }, { receiptId: 'b', transactionRef: 'p9' }] as never };

test('the page goes where most of the drop landed, not where its newest file is dated', () => {
  const of = datesIn(books, receiptOf);
  assert.equal(majorityPeriod(rows, of, TODAY, 'quarter')?.token, '2026-Q3', '23 payments and two receipts of Q3 against one receipt dated today');
  assert.equal(landedPeriod(rows, of, q('2026-Q4'), TODAY, 'quarter')?.token, '2026-Q3', 'the empty books stood on today\'s quarter');
  assert.equal(landedPeriod(rows, of, q('2026-Q3'), TODAY, 'quarter'), undefined);
});

test('a receipt dated by the day it was taken has no date of its own and decides nothing', () => {
  assert.equal(ownDate({ date: TODAY, dateSource: 'captured' }), undefined);
  assert.equal(ownDate({ date: '2026-07-03' }), '2026-07-03');
  const of = datesIn({ transactions: [] }, receiptOf);
  assert.deepEqual(of(row('phone')), []);
  assert.equal(majorityPeriod([row('phone'), row('a')], of, TODAY, 'quarter')?.token, '2026-Q3', 'the one receipt with its own date');
  assert.equal(majorityPeriod([row('phone')], of, TODAY, 'quarter'), undefined, 'nothing dated: the page stays');
});

test('a statement whose payments the page has not loaded yet counts by its last day', () => {
  assert.deepEqual(datesIn({ transactions: [] }, receiptOf)(rows[0]), ['2026-09-30']);
});

test('the summary counts the drop\'s payments and receipts from the books', () => {
  const booked = new Set(payments.slice(0, 12).map((p) => p.ref));
  const questions = [{ id: 'q1', status: 'open', on: { kind: 'payment', id: 'p20' } }, { id: 'q2', status: 'closed', on: { kind: 'payment', id: 'p21' } }] as unknown as Question[];
  const s = dropSummary(rows, books, (t) => !booked.has(t.ref), receiptOf as never, questions);
  assert.deepEqual(s.payments, { n: 23, from: '2026-07-15', to: '2026-09-15', booked: 12, waitReceipt: 8, asked: 1, unbooked: 2 });
  assert.deepEqual(s.receipts, { n: 6, read: 5, matched: 2, unmatched: 3 });
  assert.deepEqual(dropSummary([row('dup', { state: 'duplicate' })], books, () => true, receiptOf as never, []), {}, 'nothing taken: nothing to say');
});

test('the bar moves with the part of the run that is done, not only with files at rest', () => {
  assert.equal(dropProgress([]), 0);
  assert.equal(dropProgress([1, ...Array(16).fill(0)]), 6, 'the statement at rest, sixteen receipts queued');
  assert.equal(dropProgress([1, ...Array(16).fill((2 + 8 / 16) / 4)]), 65, 'their run is in its third step of four, half of them read');
  assert.equal(dropProgress(Array(17).fill(1)), 100);
});
