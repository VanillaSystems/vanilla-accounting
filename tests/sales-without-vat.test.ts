/**
 * Customer payments booked without output tax because no invoice was linked
 * (src/accounting/sales-without-vat.ts): the owner sees each one in MWST, Kontoauszüge and the
 * run that brought the statement, until the invoice is uploaded or the payment is marked as
 * carrying no VAT. Runs on the demo books with made-up payments in the open quarter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { salesWithoutVat } from '../src/accounting/sales-without-vat.js';
import { linesOf, standOf } from '../src/app/areas/automation/runs-model.js';
import type { BankTransaction, Index, JournalEntry } from '../src/types/index.js';
import type { RunSummary } from '../src/workflows/model.js';
import { DEMO_ROOT } from './support/workspace.js';

const demo = loadBooks(workspaceAt(DEMO_ROOT)) as unknown as Index;
const closedThrough = demo.config!.closedThrough!;

const pay = (ref: string, date: string, direction: BankTransaction['direction'], o: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: 4000, currency: 'CHF', direction, description: `Zahlung ${ref}`, ...o });
const entry = (ref: string, date: string, debit: string, credit: string, vatCode: string, o: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount: 4000, vatCode, origin: 'classify', receipts: [], ...o });

const cases: Array<[BankTransaction, JournalEntry]> = [
  [pay('sale', '2026-08-12', 'CRDT'), entry('sale', '2026-08-12', '1021', '3400', 'V0')],
  [pay('sale-nocode', '2026-08-13', 'CRDT'), entry('sale-nocode', '2026-08-13', '1021', '3400', '')],
  [pay('expense', '2026-08-14', 'DBIT'), entry('expense', '2026-08-14', '6500', '1021', 'I0')],
  [pay('linked', '2026-08-15', 'CRDT'), entry('linked', '2026-08-15', '1021', '3400', 'V0')],
  [pay('taxed', '2026-08-16', 'CRDT'), entry('taxed', '2026-08-16', '1021', '3400', 'V81')],
  [pay('closed', closedThrough, 'CRDT'), entry('closed', closedThrough, '1021', '3400', 'V0')],
  [pay('marked', '2026-08-17', 'CRDT', { noReceiptNeeded: true }), entry('marked', '2026-08-17', '1021', '3400', 'V0')],
  [pay('by-hand', '2026-08-18', 'CRDT'), entry('by-hand', '2026-08-18', '1021', '3400', 'V0', { origin: 'manual' })],
  [pay('loan', '2026-08-19', 'CRDT'), entry('loan', '2026-08-19', '1021', '2400', 'V0')],
];
const books: Index = {
  ...demo,
  transactions: [...demo.transactions, ...cases.map(([p]) => p)],
  journalEntries: [...demo.journalEntries!, ...cases.map(([, e]) => e)],
  mappings: [...demo.mappings, { transactionRef: 'linked', receiptId: 'invoice-2026-030' } as Index['mappings'][number]],
};

test('an incoming payment of the open period booked as revenue at a zero or no code, with no invoice linked, counts', () => {
  assert.deepEqual(salesWithoutVat(books, true).map((s) => s.payment.ref), ['sale', 'sale-nocode']);
  assert.deepEqual(salesWithoutVat(books, true)[0].entries.map((e) => e.id), ['e-sale']);
});

test('expenses, linked invoices, taxed sales, closed periods, payments marked as needing none, hand bookings and non-revenue credits do not', () => {
  const refs = new Set(salesWithoutVat(books, true).map((s) => s.payment.ref));
  for (const ref of ['expense', 'linked', 'taxed', 'closed', 'marked', 'by-hand', 'loan']) assert.ok(!refs.has(ref), ref);
});

test('books not registered for VAT owe no output tax: nothing counts', () => {
  assert.deepEqual(salesWithoutVat(books, false), []);
});

test('the demo books have none, and the run that brought the statement with such a payment is to check', () => {
  assert.deepEqual(salesWithoutVat(demo, true), []);
  const run: RunSummary = {
    id: 'r', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' }, mode: 'live', startedAt: '2026-10-15T11:00:00Z', status: 'done', path: [],
    startedBy: { kind: 'outside', file: 'x' }, digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] },
    // The 30th has no bank balance in the demo, so the balance check stays out of it.
    arrived: [{ kind: 'statement', file: 'Raiffeisen/s.xml', account: '1021', added: 9, bank: 'Raiffeisen', currency: 'CHF', from: '2026-08-01', to: '2026-08-30' }],
  };
  const [line] = linesOf(run, books, true);
  assert.deepEqual(line.kind === 'statement' && line.withoutVat.map((s) => s.payment.ref), ['sale', 'sale-nocode']);
  assert.equal(standOf(run, linesOf(run, books, true)), 'check');
  assert.equal(standOf(run, linesOf(run, books, false)), 'ok');
  const september: RunSummary = { ...run, arrived: [{ ...run.arrived![0], from: '2026-09-01', to: '2026-09-29' }] as RunSummary['arrived'] };
  assert.equal(standOf(september, linesOf(september, books, true)), 'ok', 'another month\'s statement does not hold them');
});
