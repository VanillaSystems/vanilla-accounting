/**
 * `classify --force` removes entries so it can book their transactions again. It must
 * only ever remove classify's own open-period work: anything it removes that it cannot
 * book again (corrections, Eigenverbrauch, a sales report's orders, closed entries) is lost.
 * Runs on the golden master's frozen books (tests/support/golden.ts).
 */
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '../src/types/index.js';
import { entriesForceMayRemove } from '../src/accounting/classify-force.js';
import { goldenSet } from './support/golden.js';

const { books, refs, expect: golden } = goldenSet();
const entries = books.journalEntries;
const closedThrough = books.config.closedThrough;
const removed = new Set(entriesForceMayRemove(entries, refs, closedThrough));
const survivors = entries.filter((e) => !removed.has(e));

const noTx = entries.filter((e) => e.date > closedThrough && !refs.has(e.transactionRef));
const corrections = entries.filter((e) => e.corrects);
const closed = entries.filter((e) => e.date <= closedThrough);
const sales = entries.filter((e) => e.date > closedThrough && refs.has(e.transactionRef) && /^Webshop Bestellung #\d+, .*, [^(]+$/.test(e.description ?? ''));

test('open entries without a bank transaction all survive', () => {
  for (const e of noTx) assert.ok(!removed.has(e), `${e.id} ${e.transactionRef} removed`);
});

test('every entry that corrects a filed quarter survives', () => {
  for (const e of corrections) assert.ok(!removed.has(e), `${e.id} (corrects ${e.corrects}) removed`);
});

test('closed-period entries survive', () => {
  for (const e of closed) assert.ok(!removed.has(e), `closed ${e.id} ${e.date} removed`);
});

test('a transaction is removed whole or not at all, so classify can book it again', () => {
  const removedRefs = new Set([...removed].map((e) => e.transactionRef));
  const partial = survivors.filter((e) => removedRefs.has(e.transactionRef));
  assert.deepEqual(partial.map((e) => e.transactionRef), []);
});

test('per-order sales an earlier tool booked on a provider\'s payouts survive', () => {
  for (const e of sales) assert.ok(!removed.has(e), `${e.id} ${e.description} removed`);
});

test('what --force removes on the frozen books, and how many of each kind it must keep', () => {
  assert.equal(survivors.length, entries.length - removed.size);
  golden('classify-force', {
    removed: removed.size, openWithoutTransaction: noTx.length, corrections: corrections.length, closed: closed.length, shopifySales: sales.length,
  });
});

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  id: over.transactionRef ?? 'x', transactionRef: 'TX-1', date: '2026-08-01',
  accountDebit: '6000', accountCredit: '1021', amount: 10, ...over,
});

test('origin decides on new entries', () => {
  const ours = entry({ transactionRef: 'TX-1', origin: 'classify' });
  const legacy = entry({ transactionRef: 'TX-2' });
  const mixed = [entry({ transactionRef: 'TX-3', origin: 'classify' }), entry({ transactionRef: 'TX-3', corrects: '2026-Q2' })];
  const anchor = entry({ transactionRef: 'SR-webshop-9', origin: 'classify' });
  const manual = entry({ transactionRef: 'TX-4', origin: 'manual' });
  const handEdited = [entry({ transactionRef: 'TX-5', origin: 'classify' }), entry({ transactionRef: 'TX-5', origin: 'manual' })];
  const out = entriesForceMayRemove(
    [ours, legacy, ...mixed, anchor, manual, ...handEdited],
    new Set(['TX-1', 'TX-2', 'TX-3', 'TX-4', 'TX-5']),
    '2026-06-30',
  );
  assert.deepEqual(out, [ours, legacy]);
});

test('a payout an earlier tool split into per-order sales is kept whole', () => {
  const payoutId = createHash('sha256').update('payout|TX-6').digest('hex').substring(0, 16);
  const split = [
    entry({ transactionRef: 'TX-6', id: 'sale-1', description: 'Webshop Bestellung #1001, Muster, Schweiz' }),
    entry({ transactionRef: 'TX-6', id: payoutId, description: 'Stripe, Auszahlung' }),
  ];
  const plain = entry({ transactionRef: 'TX-7' });
  assert.deepEqual(entriesForceMayRemove([...split, plain], new Set(['TX-6', 'TX-7']), '2026-06-30'), [plain]);
});
