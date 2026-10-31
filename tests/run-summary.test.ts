/**
 * What a run view shows a step made (src/workflows/summary.ts): from the books before and after
 * the step, every receipt taken up or changed (by the fields a person checks), every payment
 * linked and every entry booked, each with its facts; a receipt whose text alone changed is not
 * news, and unchanged books make nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { madeBetween } from '../src/workflows/summary.js';
import { DEMO_ROOT } from './support/workspace.js';

test('a step that took up a receipt, read its facts, linked it and booked it, said in that order', () => {
  const before = loadBooks(workspaceAt(DEMO_ROOT));
  assert.deepEqual(madeBetween(before, structuredClone(before)), [], 'nothing changed, nothing made');

  const after = structuredClone(before);
  const old = after.receipts[0];
  old.extractedText = `${old.extractedText} (read again)`;
  const tx = after.transactions.find((t) => !after.mappings.some((m) => m.transactionRef === t.ref))!;
  after.receipts.push({ ...structuredClone(old), id: 'new-receipt-0001', filename: '20261014-vendor.pdf', amount: 115.92, currency: 'EUR', hasSwissVat: false });
  after.mappings.push({ transactionRef: tx.ref, receiptId: 'new-receipt-0001' });
  after.journalEntries.push({ id: 'J-new-1', transactionRef: tx.ref, date: tx.date, accountDebit: '6500', accountCredit: '1020', amount: 115.92, vatCode: 'I0', description: 'Vendor' });

  const made = madeBetween(before, after);
  assert.deepEqual(made.map((m) => m.kind), ['receipt', 'link', 'entry'], 'a changed text alone is not news');
  assert.deepEqual(made[0], { kind: 'receipt', id: 'new-receipt-0001', file: '20261014-vendor.pdf', isNew: true, changed: [], ...(old.date ? { date: old.date } : {}), amount: 115.92, currency: 'EUR', ...(old.vatId ? { vatId: old.vatId } : {}), swissVat: false });
  assert.equal(made[1].kind === 'link' && made[1].receiptFile, '20261014-vendor.pdf');
  assert.equal(made[1].kind === 'link' && made[1].transaction, tx.ref);
  assert.deepEqual(made[2], { kind: 'entry', id: 'J-new-1', date: tx.date, debit: '6500', credit: '1020', amount: 115.92, vatCode: 'I0', description: 'Vendor' });

  const renamed = structuredClone(before);
  renamed.receipts[0].filename = 'renamed.pdf';
  const [r] = madeBetween(before, renamed);
  assert.deepEqual(r.kind === 'receipt' && [r.isNew, r.changed], [false, ['filename']]);
});
