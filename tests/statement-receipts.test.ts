/**
 * A bank statement among the receipts (issue #151, src/books/statement-facts.ts): told from its
 * text and its file name by code, dated on the period's last day, placed at the manifest's
 * account by IBAN or by the bank's name; an invoice that mentions a statement stays one.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from '../src/engines/index.js';
import { accountOfStatement, statementFacts, statementPdf, statementPeriod, typeStatements } from '../src/books/statement-facts.js';
import { parseIban } from '../src/workspace/banks.js';
import { ClosedPeriodError, loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { applyChange } from '../src/server/edits.js';
import type { Receipt } from '../src/types/index.js';
import { booksOnDisk, tempWorkspace, writeIndex } from './support/workspace.js';

const words = documents();
const doc = (lines: string[], filename = 'scan.pdf', originalFilename = filename) => ({ extractedText: lines.join('\n'), filename, originalFilename });

const ACCOUNTS = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', iban: parseIban('CH6580808000000000001') },
  { bank: 'Wise', currency: 'EUR', account: '1023', iban: parseIban('BE29967000000164') },
  { bank: 'Wise', currency: 'USD', account: '1024' },
  { bank: 'manual', currency: 'CHF', account: '2451' },
];

const KONTOAUSZUG = ['Raiffeisenbank Musterdorf', 'Kontoauszug 01.02.2026 - 28.02.2026', 'Muster Kaffee GmbH, Musterstrasse 1, 8000 Zürich', 'IBAN CH65 8080 8000 0000 0000 1, Währung CHF', '',
  'Saldovortrag 01.02.2026: 18 500.00', "03.02.2026 | Zahlung Swisscom | -89.00 | Ref. R-1", 'Schlusssaldo 28.02.2026: 18 411.00'];

test('a Kontoauszug is told by its title, IBAN, period and balance lines; its date is the period\'s last day; its account by the IBAN', () => {
  const facts = statementFacts(doc(KONTOAUSZUG), words);
  assert.deepEqual(facts, { from: '2026-02-01', to: '2026-02-28', iban: 'CH6580808000000000001' });
  assert.equal(accountOfStatement(facts!, doc(KONTOAUSZUG), ACCOUNTS)?.account, '1021');
});

test('a statement whose text has no numeric period takes it from the file name, its original name included; the bank\'s name and the currency place it', () => {
  const lines = ['Wise Europe SA', 'EUR statement', 'Muster Kaffee GmbH', 'Balance brought forward 1,200.00 EUR', 'Closing balance 980.00 EUR'];
  const byName = statementFacts(doc(lines, 'statement_12345678_EUR_2026-02-01_2026-02-28.pdf'), words);
  assert.deepEqual(byName, { from: '2026-02-01', to: '2026-02-28', currency: 'EUR' });
  assert.equal(accountOfStatement(byName!, doc(lines), ACCOUNTS)?.account, '1023', 'two Wise accounts: the currency of the name decides');
  const renamed = statementFacts(doc(lines, '20260301-wise.pdf', 'statement_12345678_USD_2026-02-01_2026-02-28.pdf'), words);
  assert.equal(renamed?.to, '2026-02-28');
  assert.equal(accountOfStatement(renamed!, doc(lines), ACCOUNTS)?.account, '1024');
  assert.equal(statementFacts(doc(lines, 'Auszug.pdf'), words), undefined, 'the title and a balance line alone, with no period and no IBAN, are too little');
  const period = statementFacts(doc(['EUR statement', 'Period 2026-02-01 to 2026-02-28', 'Closing balance 980.00 EUR']), words);
  assert.deepEqual(period, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(accountOfStatement(period!, doc(lines), ACCOUNTS), undefined, 'two accounts of the bank and no currency: no account to tell');
});

test('a Raiffeisen-named file is a statement too, with the period of its name', () => {
  const lines = ['Raiffeisen', 'Kontoauszug', 'Saldo zu Ihren Gunsten 4 321.10'];
  const facts = statementFacts(doc(lines, 'Kontoauszug 01.03.2026 - 31.03.2026 - CH6580808000000000001 - 2026-03-31.pdf'), words);
  assert.deepEqual(facts, { from: '2026-03-01', to: '2026-03-31' });
  assert.equal(accountOfStatement(facts!, doc(lines), ACCOUNTS)?.account, '1021', 'one Raiffeisen account: the bank\'s name places it');
});

test('an invoice with a service period, the payee\'s IBAN and a Saldo line is no statement, nor one that only mentions a Kontoauszug', () => {
  const invoice = ['Muster Treuhand AG', 'Rechnung Nr. 2026-14', 'Leistungsperiode 01.02.2026 - 28.02.2026', 'Buchhaltung Februar CHF 850.00', 'Total CHF 850.00', 'Saldo zu unseren Gunsten: CHF 850.00', 'IBAN CH65 8080 8000 0000 0000 1', 'Den Kontoauszug legen wir bei.'];
  assert.equal(statementFacts(doc(invoice), words), undefined);
  const mention = ['Muster Treuhand AG', 'Kontoauszug beiliegend', 'Rechnung Nr. 2026-15', 'Total CHF 120.00'];
  assert.equal(statementFacts(doc(mention), words), undefined, 'a statement word after a receipt word, with no IBAN, period or balance, is no statement');
  assert.equal(statementFacts(doc(['Statement of work', 'Project Alpha', 'Phase 1: 2026-02-01 to 2026-02-28']), words), undefined, 'a bare «Statement» with one sign is none');
});

// A currency account's statement with no IBAN (an account number instead), its period's days
// written out with a timezone after each, and its balance under «USD on <day>» (issue #164).
const USD_STATEMENT = ['Example Payments Ltd.', '1 Sample Street', 'London', '', 'USD statement', '1 March 2026 [GMT+02:00] - 31 March 2026 [GMT+02:00]', 'Generated on: 14 April 2026', '',
  'Account Holder', 'Muster Kaffee GmbH', 'Musterstrasse 1', '', 'USD on 31 March 2026 [GMT+02:00]', 'Description', '', '0.00 USD', 'Incoming', '', 'Outgoing', '', 'Amount'];

test('a currency account\'s statement without an IBAN is told by its «USD on <day>» balance heading and the period of its name', () => {
  const facts = statementFacts(doc(USD_STATEMENT, 'statement_12345678_USD_2026-03-01_2026-03-31.pdf'), words);
  assert.deepEqual(facts, { from: '2026-03-01', to: '2026-03-31', currency: 'USD' });
  assert.equal(accountOfStatement(facts!, doc(USD_STATEMENT), ACCOUNTS), undefined, 'no bank named in its head: it stays under Belege, typed');
  assert.equal(statementFacts(doc(USD_STATEMENT, 'scan.pdf'), words), undefined, 'the heading alone, with no period read and no IBAN, is one sign');
  assert.ok(statementFacts(doc(['EUR statement', 'EUR per 31.03.2026', 'Saldo 10.00'], 'statement_1_EUR_2026-03-01_2026-03-31.pdf'), words), 'a numeric day after the code counts too');
  const invoice = ['Example Cloud Ltd.', 'Invoice 2026-031', 'Statement of charges', 'USD on 31 March 2026', 'Total 49.00 USD'];
  assert.equal(statementFacts(doc(invoice, 'statement_1_USD_2026-03-01_2026-03-31.pdf'), words), undefined, 'an invoice that names a statement after its title stays an invoice');
  assert.equal(statementFacts(doc(['Statement of work', 'usd on 31 March 2026', 'Phase 1']), words), undefined, 'a currency code is upper case, and one sign is too little');
});

test('statementPeriod reads a dash, «bis» or «to» between two days, in either order; statementPdf reads both file names', () => {
  assert.deepEqual(statementPeriod('Auszug 1.2.2026 bis 28.2.2026'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(statementPeriod('Period 2026-02-28 to 2026-02-01'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(statementPeriod('Rechnung vom 03.02.2026, zahlbar bis 05.03.2026 netto'), undefined, 'two days with words between them are no period');
  assert.equal(statementPeriod('31.13.2026 - 01.14.2026'), undefined);
  assert.deepEqual(statementPdf('statement_12345678_CHF_2026-02-01_2026-02-28.pdf'), { currency: 'CHF', fromDate: '2026-02-01', toDate: '2026-02-28' });
  assert.deepEqual(statementPdf('Kontoauszug 01.01.2026 - 31.01.2026 - CH6580808000000000001 - 2026-01-31.pdf'), { fromDate: '2026-01-01', toDate: '2026-01-31' });
  assert.equal(statementPdf('20260105-example-cloud-invoice-2026-01.pdf'), null);
  assert.equal(statementPdf('Kontoauszug 01.02.2026 - 31.02.2026.pdf'), null, 'a day the calendar has not is no period');
  assert.equal(statementPeriod('01.04.2026 - 31.04.2026'), undefined);
});

test('typeStatements: a receipt nobody typed that reads as a statement is typed and dated; a person\'s kind, a person\'s «ordinary receipt», an own date and an invoice stay; twice gives the same', () => {
  const invoice = { id: 'inv', filename: 'r.pdf', date: '2026-02-03', extractedText: 'Swisscom AG\nRechnung 4711\nTotal CHF 89.00\nMWST 8.1%' };
  const receipts = [
    { id: 'a', ...doc(KONTOAUSZUG, 'Kontoauszug.pdf') },
    { id: 'b', ...doc(KONTOAUSZUG, 'b.pdf'), kind: 'invoice', kindBy: 'human' },
    { id: 'c', ...doc(KONTOAUSZUG, 'c.pdf'), date: '2026-03-02' },
    { id: 'd', ...doc(KONTOAUSZUG, '20260305-d.pdf'), date: '2026-03-05', dateSource: 'captured' },
    { id: 'e', ...doc(KONTOAUSZUG, 'e.pdf'), kindBy: 'human' },
    invoice,
  ] as unknown as Receipt[];
  const once = typeStatements(receipts, words);
  const typed = { kind: 'statement', kindBy: 'rule', kindRule: 'document:statement' };
  assert.deepEqual(once[0], { ...receipts[0], ...typed, date: '2026-02-28' });
  assert.deepEqual(once[1], receipts[1], 'a kind a person gave stays');
  assert.deepEqual(once[2], { ...receipts[2], ...typed }, 'its own date stays');
  assert.deepEqual(once[3], { id: 'd', ...doc(KONTOAUSZUG, '20260305-d.pdf'), ...typed, date: '2026-02-28' }, 'a day read off the capture gives way to the period');
  assert.deepEqual(once[4], receipts[4], 'a person made it an ordinary receipt again: no rule types it');
  assert.deepEqual(once[5], invoice);
  assert.deepEqual(typeStatements(once, words), once);
  assert.equal('kind' in receipts[0], false, 'the receipts handed in are not changed');
});

test('books already at schema 5 type their statements on load, a filed quarter\'s too, links kept; a closed year\'s receipts stay as read', () => {
  const at = (id: string, lines: string[], filename: string, more: Partial<Receipt> = {}) =>
    ({ id, ...doc(lines, filename), extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-04-14T00:00:00Z', location: 'archived', ...more });
  const ws = tempWorkspace('statement-load-');
  writeIndex(ws, {
    config: { closedThrough: '2026-06-30' },
    receipts: [
      at('usd', USD_STATEMENT, 'statement_12345678_USD_2026-03-01_2026-03-31.pdf'),
      at('old', KONTOAUSZUG, 'Kontoauszug 01.12.2025 - 31.12.2025.pdf', { date: '2025-12-31' }),
    ],
    transactions: [{ ref: 'T1', date: '2026-03-12', amount: -20, currency: 'USD', description: 'Card payment', account: '1024' }],
    mappings: [{ receiptId: 'usd', transactionRef: 'T1' }],
    bankStatements: [],
  } as never);
  const before = booksOnDisk(ws);
  const books = loadBooks(ws);
  const usd = books.receipts.find((r) => r.id === 'usd')!;
  assert.deepEqual([usd.kind, usd.date], ['statement', '2026-03-31'], 'typed and dated though its quarter is filed');
  assert.equal(books.receipts.find((r) => r.id === 'old')!.kind, undefined, 'a closed year\'s file never changes');
  assert.deepEqual(books.mappings, [{ receiptId: 'usd', transactionRef: 'T1' }]);
  saveBooks(ws, books);
  const after = booksOnDisk(ws);
  assert.deepEqual(Object.keys(after).filter((f) => after[f] !== before[f]), ['2026/receipts.jsonl'], 'only the open year\'s receipts are written');
  assert.equal(loadBooks(ws).receipts.find((r) => r.id === 'usd')!.kind, 'statement');
});

test('a filed quarter\'s statement linked to a filed payment takes «statement» and a date by hand or by the AI, links kept; «noise» would take its link and is refused; «ordinary receipt» stays a person\'s', () => {
  const ws = tempWorkspace('statement-kind-');
  writeIndex(ws, {
    config: { closedThrough: '2026-06-30' },
    receipts: [{ id: 'st', ...doc(['Scan'], 'scan.pdf'), extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-04-14T00:00:00Z', location: 'archived' }],
    transactions: [{ ref: 'T1', date: '2026-03-12', amount: -20, currency: 'USD', description: 'Card payment', account: '1024' }],
    mappings: [{ receiptId: 'st', transactionRef: 'T1' }],
    bankStatements: [],
  } as never);
  const books = loadBooks(ws);
  assert.throws(() => update(books, PERSON, (b) => applyChange(b, { kind: 'receiptKind', id: 'st', as: 'noise' })), ClosedPeriodError);
  update(books, PERSON, (b) => {
    applyChange(b, { kind: 'receiptKind', id: 'st', as: 'statement' }, { kind: 'assistant', conversation: 'c1' });
    applyChange(b, { kind: 'receipt', id: 'st', set: { date: '2026-03-31' } }, { kind: 'assistant', conversation: 'c1' });
  });
  const st = books.receipts[0];
  assert.deepEqual([st.kind, st.kindBy, st.date], ['statement', 'human', '2026-03-31']);
  assert.deepEqual(books.mappings, [{ receiptId: 'st', transactionRef: 'T1' }]);
  update(books, PERSON, (b) => applyChange(b, { kind: 'receiptKind', id: 'st', as: null }));
  assert.deepEqual([books.receipts[0].kind, books.receipts[0].kindBy], [undefined, 'human'], 'no rule types it again');
  saveBooks(ws, books);
});
