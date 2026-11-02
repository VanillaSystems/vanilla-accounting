/**
 * The order of arrival decides nothing: bank statements dropped before the receipts end where the
 * receipts first end. A payment the app booked without a receipt (the model's answer that only
 * settles, on a money account) stays a candidate for the receipts that match it, whole or by its
 * parts, and is booked again with them; a person's booking of it stands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStep } from '../src/intake/classify.js';
import { noReceiptFor, runPairChain } from '../src/intake/pair-chain.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

function company(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'late-receipts-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const accounts = join(dir, 'master-data/accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1090', name: 'Durchlaufkonto' }]));
  return workspaceAt(dir);
}

/** One debit of the bank paying two suppliers' invoices: a collective payment with its parts. */
const BATCH: BankTransaction = {
  ref: 'BATCH-1', bank: 'Raiffeisen', date: '2026-10-07', amount: 169.7, currency: 'CHF', direction: 'DBIT', description: 'Sammelzahlung',
  parts: [
    { amount: 41.2, currency: 'CHF', counterparty: 'Paket Muster AG', reference: '000000000000000000000000011', counterpartyIban: 'CH0000000000000000011' },
    { amount: 128.5, currency: 'CHF', counterparty: 'Druckerei Beispiel AG', reference: '000000000000000000000000022', counterpartyIban: 'CH0000000000000000022' },
  ],
};

const invoice = (id: string, vendor: string, amount: number, vat: number): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-08T00:00:00Z', location: 'archived', kind: 'invoice',
  date: '2026-10-01', amount, currency: 'CHF', title: { vendor, what: 'Rechnung' }, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: amount, vat }],
  extractedText: `${vendor}, Rechnung, Total CHF ${amount.toFixed(2)} inkl. 8.1% MWST ${vat.toFixed(2)}`,
} as Receipt);

const RECEIPTS = [invoice('paket', 'Paket Muster AG', 41.2, 3.09), invoice('druck', 'Druckerei Beispiel AG', 128.5, 9.63)];

/** The first run, with no receipt yet: the model parks the payment on the transfer account. */
const parks = async () => JSON.stringify({ 'BATCH-1': { entries: [{ accountDebit: '1090', accountCredit: '', amount: 169.7, vatCode: '', description: 'Sammelzahlung ohne Beleg' }], reason: 'vorläufig auf Durchlaufkonto' } });
/** A run with both receipts linked: each part, asked on its own, on its expense with its receipt's input tax. */
const books_ = async () => JSON.stringify({
  'BATCH-1#1': { entries: [{ accountDebit: '6200', accountCredit: '', amount: 41.2, vat: 'charged', vatRate: 8.1, description: 'Paket Muster AG, Versand' }], reason: 'Rechnung mit 8.1 % MWST' },
  'BATCH-1#2': { entries: [{ accountDebit: '6570', accountCredit: '', amount: 128.5, vat: 'charged', vatRate: 8.1, description: 'Druckerei Beispiel AG, Drucksachen' }], reason: 'Rechnung mit 8.1 % MWST' },
});

function booksOf(): Books {
  return { transactions: [structuredClone(BATCH)], receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
}

const port = (books: Books) => ({ read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) });
const classify = (ws: Workspace, books: Books, ask: () => Promise<string>) => classifyStep()({ ws, books: port(books), ask, progress: () => {}, log: () => {} });
const pair = (ws: Workspace, books: Books) => runPairChain(port(books), { toChf: (a) => a, noReceipt: noReceiptFor(ws) });
const entries = (books: Books) => books.journalEntries.filter((e) => e.transactionRef === 'BATCH-1').map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
const links = (books: Books) => books.mappings.filter((m) => m.transactionRef === 'BATCH-1').map((m) => m.receiptId).sort();

test('statements before receipts: the collective payment the model parked on a money account pairs with its parts\' receipts and is booked with their input tax', async () => {
  const ws = company();
  const books = booksOf();
  await classify(ws, books, parks);
  assert.deepEqual(entries(books), [['1090', '1021', 169.7, '']], 'the first run, before any receipt');

  books.receipts.push(...structuredClone(RECEIPTS));
  await pair(ws, books);
  assert.deepEqual(links(books), ['druck', 'paket'], 'each receipt pairs with its part');

  await classify(ws, books, books_);
  assert.deepEqual(entries(books), [['6200', '1021', 41.2, 'I81'], ['6570', '1021', 128.5, 'I81']], 'booked again with the receipts');
});

test('receipts before statements end the same way', async () => {
  const ws = company();
  const books = booksOf();
  books.receipts.push(...structuredClone(RECEIPTS));
  await pair(ws, books);
  await classify(ws, books, books_);
  assert.deepEqual(links(books), ['druck', 'paket']);
  assert.deepEqual(entries(books), [['6200', '1021', 41.2, 'I81'], ['6570', '1021', 128.5, 'I81']]);
});

test('a person\'s booking of the payment onto a money account stands: no receipt pairs with it', async () => {
  const ws = company();
  const books = booksOf();
  books.journalEntries.push({ id: 'p1', transactionRef: 'BATCH-1', date: '2026-10-07', accountDebit: '1090', accountCredit: '1021', amount: 169.7, description: 'Umbuchung', origin: 'manual', by: { kind: 'person' } } as Books['journalEntries'][number]);
  books.receipts.push(...structuredClone(RECEIPTS));
  await pair(ws, books);
  assert.deepEqual(links(books), [], 'her booking says it has no receipt of its own');
});
