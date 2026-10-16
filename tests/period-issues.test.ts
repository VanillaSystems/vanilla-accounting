/**
 * What the review before filing names as still open in its period (persona round 4, r4c-38): the
 * open questions on its payments, a booking whose code its receipts contradict («I81 ohne Beleg»),
 * a payment nobody booked, a receipt without a payment. Nothing of another period, nothing settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import type { Question } from '../src/questions/model.js';
import { periodIssues } from '../src/app/areas/automation/period-issues.js';
import { journalOf, unsettledAtFiling } from '../src/app/areas/journal/model.js';
import { openWork } from '../src/server/open-work.js';
import { tempWorkspace } from './support/workspace.js';
import type { Books } from '../src/books/store.js';

const tx = (ref: string, date: string, amount: number, direction: 'DBIT' | 'CRDT' = 'DBIT'): BankTransaction => ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction, description: ref });
const receipt = (id: string, date: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', date, amount: 50 });
const books: Index = {
  config: { closedThrough: '2026-06-30' },
  transactions: [tx('KELLER', '2026-07-02', 4860, 'CRDT'), tx('NATEL', '2026-08-15', 89), tx('SEP', '2026-09-15', 89), tx('OKT', '2026-10-03', 12), tx('PAID', '2026-08-20', 50)],
  journalEntries: [
    { id: 'e-keller', transactionRef: 'KELLER', date: '2026-07-02', accountDebit: '1020', accountCredit: '3400', amount: 4860, vatCode: 'V81', origin: 'classify' },
    { id: 'e-natel', transactionRef: 'NATEL', date: '2026-08-15', accountDebit: '6510', accountCredit: '1020', amount: 89, vatCode: 'I81', origin: 'manual' },
    { id: 'e-paid', transactionRef: 'PAID', date: '2026-08-20', accountDebit: '6510', accountCredit: '1020', amount: 50, vatCode: 'I0', origin: 'classify' },
  ],
  receipts: [receipt('lonely', '2026-09-03'), receipt('paid', '2026-08-20'), receipt('october', '2026-10-04')],
  mappings: [{ receiptId: 'paid', transactionRef: 'PAID' }],
  bankStatements: [],
};
const question = (id: string, on: string, status: Question['status'] = 'open'): Question => ({ id, on: { kind: 'payment', id: on }, text: '?', choices: [], by: 'app', origin: 'booking', topic: 'saleVat', askedAt: '2026-10-01T00:00:00Z', status });

test('the review names each open issue of its quarter, and nothing of another quarter or already settled', () => {
  const issues = periodIssues(books, [question('q1', 'KELLER'), question('q2', 'OKT'), question('q3', 'NATEL', 'answered')], '2026-07-01', '2026-09-30', []);
  assert.deepEqual(issues.map((i) => [i.kind, i.kind === 'question' ? i.q.id : i.kind === 'evidence' ? i.entry.id : i.kind === 'unbooked' ? i.tx.ref : i.receipt.id]), [
    ['question', 'q1'],
    ['evidence', 'e-natel'],
    ['unbooked', 'SEP'],
    ['unlinked', 'lonely'],
  ]);
  assert.deepEqual(periodIssues({ ...books, transactions: books.transactions.filter((t) => t.ref !== 'SEP' && t.ref !== 'NATEL'), receipts: [], journalEntries: books.journalEntries!.filter((e) => e.id !== 'e-natel') }, [], '2026-07-01', '2026-09-30', []), [], 'nothing open: nothing listed');
});

const filed: Index = { ...books, config: { closedThrough: '2026-09-30' } };

test('a contradiction left when the quarter was filed stays named, for a correction in the open period, until a correction names its payment (r5h-33)', () => {
  const u = unsettledAtFiling(journalOf(filed), 'quarter');
  assert.deepEqual([u?.period, u?.items.map((i) => [i.v.e.id, i.check.kind])], ['2026-Q3', [['e-natel', 'vatWithoutReceipt']]]);
  assert.equal(journalOf(filed).views.find((v) => v.e.id === 'e-natel')!.evidence, undefined, 'the filed entry is not offered its one click: it stays as filed');
  const corrected: Index = { ...filed, journalEntries: [...filed.journalEntries!, { id: 'corr', transactionRef: 'M2026-001', date: '2026-10-05', accountDebit: '6510', accountCredit: '6510', amount: 89, vatCode: '-I81', description: 'Korrektur NATEL: ohne Beleg', corrects: '2026-Q3', origin: 'manual' }] };
  assert.deepEqual(unsettledAtFiling(journalOf(corrected), 'quarter')?.items, []);
  assert.equal(unsettledAtFiling(journalOf(books), 'quarter')?.period, '2026-Q2', 'before Q3 is filed, only the quarter filed last counts');
  assert.deepEqual(unsettledAtFiling(journalOf(books), 'quarter')?.items, []);
});

test('what waits, for the AI sidebar, names the bookings against their receipts, those left at filing, and the possible duplicates (w08, r5h-34)', () => {
  const ws = tempWorkspace('open-work-');
  const twin = (id: string, file: string): Receipt => ({ ...receipt(id, '2026-09-10'), filename: file, extractedText: 'Farbmix AG Rechnung FM-77812 Total CHF 1243.55', amount: 1243.55, description: 'Farbmix AG, Rechnung FM-77812' });
  const open = openWork(ws, { ...books, receipts: [...books.receipts, twin('fm', 'fm-77812.pdf'), twin('img', 'img-4801.jpg')] } as Books, [], 'de');
  assert.match(open, /Bookings whose VAT code contradicts their receipts \(1\)[^\n]*\n- 15\.08\.2026 [^\n]*\(NATEL\): «I81 ohne Beleg: die Vorsteuer braucht einen Beleg mit MWST, sonst I0\.»/);
  assert.match(open, /Receipts that may be a copy of another \(1\)[^\n]*\n- «Farbmix AG, Rechnung FM-77812» may be a copy of «Farbmix AG, Rechnung FM-77812»/);
  assert.doesNotMatch(open, /Nothing waits/);
  const after = openWork(ws, filed as Books, [], 'de');
  assert.match(after, /Bookings of the filed 2026-Q3 that contradicted their receipts and were not settled before filing \(1\)[^\n]*\n- 15\.08\.2026 /);
});
