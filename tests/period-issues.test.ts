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
  const issues = periodIssues(books, [question('q1', 'KELLER'), question('q2', 'OKT'), question('q3', 'NATEL', 'answered')], '2026-07-01', '2026-09-30');
  assert.deepEqual(issues.map((i) => [i.kind, i.kind === 'question' ? i.q.id : i.kind === 'evidence' ? i.entry.id : i.kind === 'unbooked' ? i.tx.ref : i.receipt.id]), [
    ['question', 'q1'],
    ['evidence', 'e-natel'],
    ['unbooked', 'SEP'],
    ['unlinked', 'lonely'],
  ]);
  assert.deepEqual(periodIssues({ ...books, transactions: books.transactions.filter((t) => t.ref !== 'SEP' && t.ref !== 'NATEL'), receipts: [], journalEntries: books.journalEntries!.filter((e) => e.id !== 'e-natel') }, [], '2026-07-01', '2026-09-30'), [], 'nothing open: nothing listed');
});
