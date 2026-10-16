/**
 * The composer's «+» (src/app/assistant/attach.ts): it finds receipts, bookings and payments in the
 * books by any word or the amount, its first list offers the page and the categories, and what it
 * attaches goes with the message the way the page's own reference does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICK_KINDS, bookCandidates, pickRows, search, type Candidate, type PickKind } from '../src/app/assistant/attach.js';
import { messageOf, newThread, type Thread } from '../src/app/assistant/thread.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import type { ContextRef } from '../src/types/assistant.js';

const receipt = (id: string, date: string, description: string, amount: number) => ({ id, filename: `${id}.pdf`, date, description, amount, currency: 'CHF' }) as Receipt;
const books = {
  receipts: [receipt('r-old', '2026-07-02', 'Swisscom Juli', 89.9), receipt('r-new', '2026-09-02', 'Swisscom September', 89.9), receipt('r-farb', '2026-08-14', 'Farbmix Material', 1243.55)],
  transactions: [{ ref: 'tx-1', date: '2026-09-03', amount: -89.9, currency: 'CHF', description: 'Swisscom (Schweiz) AG' } as BankTransaction],
  journalEntries: [{ id: 'je-1', date: '2026-08-15', amount: 1243.55, description: 'Farbmix Material' } as JournalEntry],
};
const sources: Record<PickKind, Candidate[]> = {
  receipt: bookCandidates(books, 'receipt'), entry: bookCandidates(books, 'entry'), payment: bookCandidates(books, 'payment'), automation: [],
};
const label = (k: PickKind) => ({ receipt: 'Beleg …', entry: 'Buchung …', payment: 'Zahlung …', automation: 'Ablauf oder Lauf …' })[k];
const page: ContextRef = { kind: 'entry', id: 'je-1', label: 'Farbmix Material' };

test('a category finds its rows by every typed word and by the amount as typed, newest first', () => {
  assert.deepEqual(search(sources.receipt, 'swisscom', 10).map((c) => c.ref.id), ['r-new', 'r-old']);
  assert.deepEqual(search(sources.receipt, 'swisscom sept', 10).map((c) => c.ref.id), ['r-new']);
  assert.deepEqual(search(sources.receipt, '1243.55', 10).map((c) => c.ref.id), ['r-farb']);
  assert.deepEqual(pickRows('payment', 'swisscom', page, sources, label), [{ kind: 'item', c: sources.payment[0] }]);
});

test('the first list offers the page and every category; a typed word searches every category at once', () => {
  assert.deepEqual(pickRows('root', '', page, sources, label), [{ kind: 'page', ref: page }, ...PICK_KINDS.map((of) => ({ kind: 'category', of }))]);
  assert.deepEqual(pickRows('root', '', undefined, sources, label)[0], { kind: 'category', of: 'receipt' }, 'no page reference: no page row');
  const found = pickRows('root', 'swisscom', page, sources, label).map((r) => (r.kind === 'item' ? `${r.c.ref.kind}:${r.c.ref.id}` : r.kind));
  assert.deepEqual(found, ['receipt:r-new', 'receipt:r-old', 'payment:tx-1']);
  assert.deepEqual(pickRows('root', 'buchung', page, sources, label), [{ kind: 'category', of: 'entry' }]);
});

test('what the picker attaches goes with the message beside the page; the page switched off stays out', () => {
  const picked = search(sources.payment, 'swisscom', 1)[0].ref;
  const thread: Thread = { ...newThread(), open: true, extra: [picked] };
  assert.deepEqual(messageOf(thread, page).context, [page, { kind: 'payment', id: 'tx-1', label: 'Swisscom (Schweiz) AG' }]);
  assert.deepEqual(messageOf({ ...thread, pageOff: true }, page).context, [picked]);
});
