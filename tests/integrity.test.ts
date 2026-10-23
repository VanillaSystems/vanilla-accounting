/**
 * The books' referential integrity (#126): one of each dangling reference planted in a copy of the
 * demo is found with its record and the key it misses, and every shipped demo reports none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, writeBooks } from '../src/books/store.js';
import { danglingRefsOf, DANGLING_KINDS, type Dangling } from '../src/books/integrity.js';
import { openingFor } from '../src/books/year-close.js';
import { APP_FOLDER, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import type { InvoiceBook } from '../src/invoices/model.js';
import { DEMO_REPO, DEMO_ROOTS } from './support/workspace.js';
import './support/jurisdiction.js';

function demoCopy(): Workspace {
  const repo = mkdtempSync(join(tmpdir(), 'integrity-'));
  cpSync(DEMO_REPO, repo, { recursive: true });
  return workspaceAt(join(repo, APP_FOLDER));
}

const found = (ws: Workspace): Dangling[] => danglingRefsOf(ws, loadBooks(ws));

test('every shipped demo has no dangling reference', () => {
  for (const root of DEMO_ROOTS) {
    const ws = workspaceAt(root);
    assert.deepEqual(found(ws), [], root);
  }
});

test('one of each dangling reference planted in a demo copy is found, and nothing else', () => {
  const ws = demoCopy();
  const books = loadBooks(ws);
  const lock = books.config.closedThrough!;
  const open = books.transactions.find((t) => t.date > lock && !t.statement)!;
  const openEntry = books.journalEntries.find((e) => e.date > lock)!;
  const receipt = books.receipts[0];
  const statement = books.bankStatements[0];

  books.mappings.push({ transactionRef: 'gone-payment', receiptId: receipt.id });
  books.mappings.push({ transactionRef: open.ref, receiptId: 'gone-receipt' });
  openEntry.receipts = [...(openEntry.receipts ?? []), 'gone-entry-receipt'];
  books.journalEntries.push({ id: 'planted', transactionRef: 'M2026-900', date: openEntry.date, accountDebit: '9999', accountCredit: openEntry.accountDebit || openEntry.accountCredit, amount: 10, description: 'planted' });
  books.config.vatAdjustments = [...(books.config.vatAdjustments ?? []), { id: 'adj', period: '2026-Q3', ziffer: '400', amount: 1, reason: 'planted', entryIds: ['gone-adjusted'] }];
  books.config.correctionCases = [...(books.config.correctionCases ?? []), { id: 'case', period: '2026-Q1', title: 't', wrong: 'w', fix: 'f', originalEntryIds: ['gone-original'], correctionEntryIds: [] }];
  statement.refs = [...(statement.refs ?? []), 'gone-row'];
  receipt.filedPayment = 'gone-filed';
  open.statement = 'gone-statement-row';
  books.transactions.push({ ref: 'planted-tx', bank: 'Nowhere', date: open.date, amount: 5, currency: 'CHF', direction: 'DBIT', description: 'planted' });
  writeBooks(ws.paths, books);

  const invoices = JSON.parse(readFileSync(ws.paths.invoices, 'utf8')) as InvoiceBook;
  const paid = invoices.invoices.find((i) => i.status === 'issued' && !i.deleted)!;
  if (paid.status === 'issued') paid.payments.push({ transactionRef: 'gone-allocation', date: open.date, amount: 1, by: 'confirmed' });
  writeFileSync(ws.paths.invoices, JSON.stringify(invoices, null, 2));

  appendFileSync(yearPaths(ws.paths, '2026').questions, JSON.stringify({ v: 1, id: 'q-planted', at: '2026-10-01T10:00:00Z', by: 'owner', event: 'asked', on: { kind: 'receipt', id: 'gone-asked' }, text: 'planted', choices: [], origin: 'person' }) + '\n');

  const number = paid.status === 'issued' ? paid.number : '';
  assert.deepEqual(found(ws), [
    { kind: 'mappingTransaction', record: `mapping gone-payment ↔ ${receipt.id}`, missing: 'gone-payment' },
    { kind: 'mappingReceipt', record: `mapping ${open.ref} ↔ gone-receipt`, missing: 'gone-receipt' },
    { kind: 'entryReceipt', record: `entry ${openEntry.id}`, missing: 'gone-entry-receipt' },
    { kind: 'entryAccount', record: 'entry planted', missing: '9999' },
    { kind: 'vatAdjustmentEntry', record: 'vatAdjustment adj', missing: 'gone-adjusted' },
    { kind: 'correctionCaseEntry', record: 'correctionCase case', missing: 'gone-original' },
    { kind: 'allocationTransaction', record: `invoice ${number}`, missing: 'gone-allocation' },
    { kind: 'statementRef', record: `statement ${statement.filename}`, missing: 'gone-row' },
    { kind: 'receiptFiledPayment', record: `receipt ${receipt.id}`, missing: 'gone-filed' },
    { kind: 'transactionStatement', record: `transaction ${open.ref}`, missing: 'gone-statement-row' },
    { kind: 'questionTarget', record: 'question q-planted', missing: 'receipt gone-asked' },
    { kind: 'moneyAccount', record: 'transaction planted-tx', missing: 'Nowhere CHF' },
  ]);
  assert.deepEqual(DANGLING_KINDS.filter((k) => k !== 'openingMismatch'), found(ws).map((d) => d.kind), 'every kind but the opening is planted here');
});

test('a mapping or a question may name a booking without a payment, and an answered question about something gone is history', () => {
  const ws = demoCopy();
  const books = loadBooks(ws);
  const refs = new Set(books.transactions.map((t) => t.ref));
  assert.ok(books.mappings.some((m) => !refs.has(m.transactionRef) && books.journalEntries.some((e) => e.transactionRef === m.transactionRef)), 'the demo links a receipt to a booking without a payment');
  const line = (event: object) => JSON.stringify({ v: 1, id: 'q', at: '2026-10-01T10:00:00Z', by: 'owner', ...event }) + '\n';
  appendFileSync(yearPaths(ws.paths, '2026').questions, line({ event: 'asked', on: { kind: 'payment', id: 'gone' }, text: 't', choices: [], origin: 'person' }) + line({ event: 'answered', answer: { text: 'ok' } }));
  assert.deepEqual(found(ws), []);
});

test('a stored opening of the next year is checked against the closing of the closed year, account by account', () => {
  const ws = demoCopy();
  const books = loadBooks(ws);
  books.config.closedThrough = '2026-12-31';
  const opening = openingFor(ws, '2026', undefined, books);
  books.config.openingBalances = { ...books.config.openingBalances, 2027: opening.balances };
  writeBooks(ws.paths, books);
  assert.deepEqual(found(ws), [], 'the opening the year opening wrote matches');

  const [account, balance] = Object.entries(opening.balances)[0];
  books.config.openingBalances['2027'] = { ...opening.balances, [account]: balance + 100 };
  writeBooks(ws.paths, books);
  assert.deepEqual(found(ws), [{
    kind: 'openingMismatch',
    record: `openingBalances 2027 account ${account}`,
    missing: `${(balance + 100).toFixed(2)} stored, ${balance.toFixed(2)} closing 2026`,
  }]);

  books.config.closedThrough = '2026-09-30';
  writeBooks(ws.paths, books);
  assert.deepEqual(found(ws), [], 'an open year has no closing to compare');
});
