/**
 * A set of receipts above its payment: a receipt code or the model would add to a payment whose
 * receipts already add up to it belongs to another payment. Code and the model never link it, even
 * for a vendor that groups several receipts into one payment; a person may, and the payment shows
 * the excess (src/accounting/receipt-due.ts excessOf, excessOfPayment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadBooks, moduleActor, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { excessOf, excessOfPayment, linkedOf } from '../src/accounting/receipt-due.js';
import { workspaceAt, findFile } from '../src/workspace/workspace.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

const r = (id: string, amount: number, over: Partial<Receipt> = {}) => ({ id, amount, currency: 'CHF', ...over }) as Receipt;
const tx = { ref: 'P', date: '2026-07-03', amount: 71.4, currency: 'CHF', direction: 'DBIT' } as BankTransaction;

test('a set above its payment by more than a centime per receipt is over; one receipt, another currency, money in or a credit note that brings it down are not', () => {
  assert.equal(excessOf([r('a', 50), r('b', 21.4), r('c', 12.3)], tx), 12.3);
  assert.equal(excessOf([r('a', 50), r('b', 21.42)], tx), undefined, 'two centimes over on two receipts: rounding');
  assert.equal(excessOf([r('a', 50), r('b', 21.43)], tx), 0.03);
  assert.equal(excessOf([r('a', 200)], tx), undefined, 'one receipt may cover several payments: instalments, a part payment');
  assert.equal(excessOf([r('a', 50, { currency: 'EUR' }), r('b', 40, { currency: 'EUR' })], tx), undefined, 'receipts in another currency than the payment');
  assert.equal(excessOf([r('a', 50), r('b', 40)], { ...tx, direction: 'CRDT' }), undefined, 'money in');
  assert.equal(excessOf([r('a', 50), r('b', 40), r('c', -18.6)], tx), undefined, 'a credit note in the set');
  assert.equal(excessOf([r('a', 50), r('b', 40), r('c', 30, { kind: 'supporting' })], tx), 18.6, 'only purchase documents count');
  assert.equal(linkedOf([r('a', 50), r('b', 40)], tx), 'read', 'a set a person linked above the payment does not hold its booking');
});

test('a set with a receipt linked to another payment too is not compared: a split charge\'s legs, instalments', () => {
  const books = { transactions: [tx, { ...tx, ref: 'Q' }], receipts: [r('a', 50), r('b', 40)], mappings: [{ transactionRef: 'P', receiptId: 'a' }, { transactionRef: 'P', receiptId: 'b' }] };
  assert.equal(excessOfPayment(books, 'P'), 18.6);
  assert.equal(excessOfPayment({ ...books, mappings: [...books.mappings, { transactionRef: 'Q', receiptId: 'b' }] }, 'P'), undefined);
  assert.equal(excessOfPayment({ ...books, mappings: [{ transactionRef: 'P', receiptId: 'a' }] }, 'P', 'b'), 18.6, 'with a receipt about to be linked');
});

/** The demo's Post invoice of May (CHF 208.70) and the payment that pays it. */
const RECEIPT = '7cde279c427e1f41';
const PAYMENT = '90000000031';

/**
 * A copy of the demo whose Post invoice of May is back in the inbox, its link gone, the Post a
 * vendor that groups receipts into one payment, and the payment holding receipts of `held` CHF.
 */
function dropped(held: number[]): ReturnType<typeof workspaceAt> {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-over-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  appendFileSync(join(dir, 'knowledge/suppliers/swiss-post.yaml'), '\ngrouped: true\n');
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const receipt = books.receipts.find((x) => x.id === RECEIPT)!;
  const file = findFile(ws.paths, 'receipts', receipt.filename)!;
  const pdf = readFileSync(file);
  rmSync(file);
  update(books, moduleActor('test'), (b) => {
    b.receipts = b.receipts.filter((x) => x.id !== RECEIPT);
    b.mappings = b.mappings.filter((m) => m.receiptId !== RECEIPT && m.transactionRef !== PAYMENT);
    held.forEach((amount, i) => {
      const text = `%PDF-1.4 Post CH invoice part ${i}`;
      writeFileSync(join(dirname(file), `held-${i}.pdf`), text);
      b.receipts.push(r(idOf(text), amount, { filename: `held-${i}.pdf`, location: 'archived', kind: 'invoice', date: '2026-05-12', extractedText: text }));
      b.mappings.push({ transactionRef: PAYMENT, receiptId: idOf(text), by: 'llm' });
    });
  });
  saveBooks(ws, books);
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'scan-post.pdf'), pdf);
  return ws;
}

/** A model whose match reads `amount` off every receipt and names the payment for it, sure of it. */
function sure(amount: number): Ask {
  return async (prompt, opts) => {
    if (opts.step === 'receipt-match') return JSON.stringify({ suggestedFilename: '20260512-post-ch.pdf', date: '2026-05-12', description: 'Post CH', amount, currency: 'CHF', matchedTransactionRefs: [PAYMENT], confidence: 0.95 });
    if (opts.step === 'receipt-pair') return '[]';
    return '{}';
  };
}

const idOf = (text: string) => createHash('sha256').update(text).digest('hex').substring(0, 16);
const heldIds = (n: number) => Array.from({ length: n }, (_, i) => idOf(`%PDF-1.4 Post CH invoice part ${i}`)).sort();
const linkedTo = (ws: ReturnType<typeof workspaceAt>) => loadBooks(ws).mappings.filter((m) => m.transactionRef === PAYMENT).map((m) => m.receiptId).sort();

test('the model\'s match does not add a receipt to a grouping vendor\'s payment whose receipts already add up to it: the receipt stays free', async () => {
  const ws = dropped([100, 108.7]);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: sure(208.7), steps: [['read', readStep], ['match', matchStep]] });
  assert.deepEqual(linkedTo(ws), heldIds(2));
  const books = loadBooks(ws);
  const receipt = books.receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.equal(receipt.location, 'archived');
  assert.equal(books.mappings.some((m) => m.receiptId === receipt.id), false, 'free for its own payment');
});

test('the model\'s match still adds the receipt that completes a grouping vendor\'s payment', async () => {
  const ws = dropped([100]);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: sure(108.7), steps: [['read', readStep], ['match', matchStep]] });
  const receipt = loadBooks(ws).receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.deepEqual(linkedTo(ws), [...heldIds(1), receipt.id].sort());
});
