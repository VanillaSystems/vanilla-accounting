/**
 * A payout report books its payouts in code (r10f-29, regression of r8f-15): the model reads the
 * report's figures once, at the match step (Receipt.payout: sales, refunds, fees, paid out), and
 * the booking step splits every payout the report is linked to into gross sales and the
 * provider's fees without asking the model again: each payout's sales are its amount, the last
 * one carries the report's refunds and fees on top, so the month's sales add up to the report's.
 * The accounts and codes come from a rule naming the provider, else from the firm's setup
 * («Auszahlungen eines Zahlungsanbieters: ja»: the revenue account of what it sells, the fee
 * account the answer added). A report whose payouts do not add up to what it paid out books nothing by code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext, payoutDefault } from '../src/booking/classify.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { APP_ROOT, APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';
import './support/jurisdiction.js';

/** A firm not registered for VAT that answered «Auszahlungen eines Zahlungsanbieters: ja» at setup, with the accounts the answer adds. */
function salon(): Workspace {
  const ws = tempWorkspace('payout-report-', join(APP_ROOT, 'demo-coiffeur', APP_FOLDER));
  const manifest = join(ws.paths.root, 'belege.workspace.yaml');
  writeFileSync(manifest, `${readFileSync(manifest, 'utf8').trimEnd()}\nprofile:\n  preset: freelancer\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: no\n  imports: no\n  employees: none\n  ownerPaysPrivately: yes\n  privateUse: []\n  payouts: yes\n`);
  mkdirSync(ws.paths.masterData, { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify([['1020', 'Bank'], ['2850', 'Privat'], ['3400', 'Dienstleistungsertrag'], ['6580', 'Zahlungsanbietergebühren'], ['1093', 'Durchlaufkonto']].map(([number, name]) => ({ number, name }))));
  return workspaceAt(ws.paths.root);
}

const PAYOUTS: Array<[string, number]> = [['2026-07-03', 1180.5], ['2026-07-10', 1265], ['2026-07-17', 1320.4], ['2026-07-24', 1098.7], ['2026-07-31', 1240]];
const payout = ([date, amount]: [string, number], i: number): BankTransaction =>
  ({ ref: `ZKB-${i + 1}`, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: `SumUp Auszahlung Kartenterminal ${date.slice(8)}.${date.slice(5, 7)}` });

const REPORT: Receipt = { id: 'rep', filename: 'sumup-juli.pdf', originalFilename: 'sumup-juli.pdf', extractedText: 'SumUp Monatsabrechnung Juli 2026 Kartenzahlungen brutto 6213.47 Gebühren 1.5 % -108.87 Ausgezahlt 6104.60', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-08-01T00:00:00Z', location: 'archived', date: '2026-07-31', amount: 6104.6, currency: 'CHF', payout: { sales: 6213.47, refunds: 0, fees: 108.87, paidOut: 6104.6 } };

function booksOf(linked: number): Books {
  const transactions = PAYOUTS.map(payout);
  return { transactions, receipts: [REPORT], mappings: transactions.slice(0, linked).map((t) => ({ transactionRef: t.ref, receiptId: 'rep' })), bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
}

const lines = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e: JournalEntry) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);

test('the setup\'s answer gives a firm without a rule its payout booking: sales on the revenue account of what it sells, fees on the account the answer added, no codes for a firm not registered', () => {
  const ws = salon();
  assert.deepEqual(payoutDefault(ws, ['1020', '3400', '6580']), { account: '3400', vat: null, fees: { account: '6580', vat: '' } });
  assert.equal(payoutDefault(ws, ['1020', '3400']), undefined, 'without the fee account in the chart there is nothing to book the fees on');
  assert.equal(payoutDefault({ ...ws, profile: { ...ws.profile!, payouts: 'no' } }, ['1020', '3400', '6580']), undefined, 'the answer was no');
});

test('a monthly report linked to five payouts books each gross in code, the last with the month\'s fees, without the model; the month\'s sales are the report\'s', async () => {
  const ws = salon();
  const books = booksOf(5);
  const out = await classifyTransactions(books, books.transactions, { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified.length, out.failed, out.unasked], [5, [], []]);
  assert.deepEqual(lines(books, 'ZKB-1'), [['1020', '3400', 1180.5, '']]);
  assert.deepEqual(lines(books, 'ZKB-5'), [['1020', '3400', 1348.87, ''], ['6580', '1020', 108.87, '']], 'the last payout carries the fees: its sales are its amount plus the fees');
  const sales = books.journalEntries.filter((e) => e.accountCredit === '3400').reduce((s, e) => s + e.amount, 0);
  assert.equal(Math.round(sales * 100) / 100, 6213.47, 'the month\'s turnover is the report\'s gross, what the threshold watches');
  const [first] = books.journalEntries;
  assert.deepEqual(first.by, { kind: 'code', check: 'payoutReport' });
  assert.match(first.reason ?? '', /Auszahlungsbericht/);
  assert.deepEqual(first.receipts, ['rep']);
});

test('a report whose linked payouts do not add up to what it paid out books nothing by code: the payment waits for the model', async () => {
  const ws = salon();
  const books = booksOf(4);
  const out = await classifyTransactions(books, books.transactions.slice(0, 4), { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, books.journalEntries], [[], []]);
  assert.equal(out.unasked.length, 4);
});

test('the match step keeps a report\'s figures only when they add up: sales − refunds − fees = paid out', () => {
  const base = { suggestedFilename: '20260731-sumup.pdf', matchedTransactionRefs: [], date: '2026-07-31', description: 'SumUp', amount: 6104.6, currency: 'CHF', confidence: 0.9 };
  assert.deepEqual(parseMatchResult(JSON.stringify({ ...base, payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } }))?.payout, { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 });
  assert.equal(parseMatchResult(JSON.stringify({ ...base, payout: { sales: 1480, refunds: 0, fees: 27.65, paidOut: 1412.35 } }))?.payout, undefined, 'figures that do not add up are no facts');
  assert.equal(parseMatchResult(JSON.stringify(base))?.payout, undefined);
});
