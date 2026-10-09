/**
 * src/books/changes.ts: diffBooks and applyChange are inverse on real books (both demos), and
 * applyChange decides applied / alreadySo / conflict by the record as it is now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Index } from '../src/types/index.js';
import { applyChange, diffBooks, fieldDiffs, invert, type RecordChange } from '../src/books/changes.js';
import { DEMO_ROOTS } from './support/workspace.js';

const demoBooks = (root: string): Index => JSON.parse(readFileSync(join(root, 'books.json'), 'utf8')) as Index;

/** A Treuhänder's afternoon on these books: one edit, one removal, one new entry, one unlink, one flag, one config value. */
function edited(a: Index): Index {
  const b = structuredClone(a);
  const entries = b.journalEntries!;
  entries[3] = { ...entries[3], accountDebit: '6500', vatCode: 'I0', description: 'umgebucht' };
  entries.splice(7, 1);
  entries.splice(2, 0, { id: 'review-new-1', transactionRef: 'M2026-900', date: '2026-09-30', accountDebit: '6800', accountCredit: '1520', amount: 600, description: 'Abschreibung' });
  b.mappings.splice(0, 1);
  b.transactions[5] = { ...b.transactions[5], noReceiptNeeded: true };
  b.config = { ...b.config, vatAdjustments: [{ id: 'adj', period: '2026-Q3', ziffer: '400', amount: 1, reason: 'test', entryIds: [] }] };
  return b;
}

for (const root of DEMO_ROOTS) {
  const name = basename(root);

  test(`${name}: applying diffBooks(a, b) to a yields b, and applying it again changes nothing`, () => {
    const a = demoBooks(root);
    const b = edited(a);
    assert.deepEqual(diffBooks(a, a), []);
    const changes = diffBooks(a, b);
    assert.ok(changes.length >= 6, `${changes.length} changes`);
    const c = structuredClone(a);
    assert.deepEqual(changes.map((ch) => applyChange(c, ch)), changes.map(() => 'applied'));
    assert.deepEqual(diffBooks(c, b), []);
    assert.deepEqual(changes.map((ch) => applyChange(c, ch)), changes.map(() => 'alreadySo'));
    for (const ch of [...changes].reverse()) assert.equal(applyChange(c, invert(ch)), 'applied');
    assert.deepEqual(diffBooks(c, a), [], 'inverting every change restores a');
  });

  test(`${name}: a record that moved since the change was made is a conflict, and stays as it is`, () => {
    const a = demoBooks(root);
    const [change] = diffBooks(a, edited(a)).filter((c) => c.collection === 'entries' && c.before && c.after);
    const moved = structuredClone(a);
    const entry = moved.journalEntries!.find((e) => e.id === change.key)!;
    entry.accountDebit = '6400';
    assert.equal(applyChange(moved, change), 'conflict');
    assert.equal(entry.accountDebit, '6400');
  });
}

test('array order is not a change, and a repeated key is told apart by its position', () => {
  const t = (ref: string, amount: number) => ({ ref, bank: 'x', date: '2026-07-01', amount, currency: 'CHF', direction: 'DBIT' as const, description: '' });
  const a: Index = { receipts: [], mappings: [], bankStatements: [], transactions: [t('A', 1), t('B', 2), t('B', 3)] };
  assert.deepEqual(diffBooks(a, { ...a, transactions: [a.transactions[2], a.transactions[0], a.transactions[1]] }).map((c) => c.key), ['B', 'B#2']);
  const b = structuredClone(a);
  b.transactions[2].amount = 4;
  const changes = diffBooks(a, b);
  assert.deepEqual(changes.map((c) => c.key), ['B#2']);
  assert.equal(applyChange(a, changes[0]), 'applied');
  assert.deepEqual(a.transactions.map((x) => x.amount), [1, 2, 4]);
});

test('fieldDiffs names the fields a person reads, before and after', () => {
  const change: RecordChange = {
    collection: 'entries', key: 'e1',
    before: { id: 'e1', transactionRef: 'r', date: '2026-07-01', accountDebit: '6570', accountCredit: '1020', amount: 10, vatCode: 'I81' },
    after: { id: 'e1', transactionRef: 'r', date: '2026-07-01', accountDebit: '6500', accountCredit: '1020', amount: 10 },
  };
  assert.deepEqual(fieldDiffs(change), [
    { field: 'accountDebit', before: '6570', after: '6500' },
    { field: 'vatCode', before: 'I81', after: undefined },
  ]);
});
