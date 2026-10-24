/**
 * A bank statement among the receipts (issue #151, src/intake/statement-facts.ts): told from its
 * text and its file name by code, dated on the period's last day, placed at the manifest's
 * account by IBAN or by the bank's name; an invoice that mentions a statement stays one.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from '../src/engines/index.js';
import { accountOfStatement, statementFacts, statementPdf, statementPeriod } from '../src/books/statement-facts.js';
import { parseIban } from '../src/workspace/banks.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, climb } from '../src/workspace/schema.js';

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

test('statementPeriod reads a dash, «bis» or «to» between two days, in either order; statementPdf reads both file names', () => {
  assert.deepEqual(statementPeriod('Auszug 1.2.2026 bis 28.2.2026'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(statementPeriod('Period 2026-02-28 to 2026-02-01'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(statementPeriod('Rechnung vom 03.02.2026, zahlbar bis 05.03.2026 netto'), undefined, 'two days with words between them are no period');
  assert.equal(statementPeriod('31.13.2026 - 01.14.2026'), undefined);
  assert.deepEqual(statementPdf('statement_12345678_CHF_2026-02-01_2026-02-28.pdf'), { currency: 'CHF', fromDate: '2026-02-01', toDate: '2026-02-28' });
  assert.deepEqual(statementPdf('Kontoauszug 01.01.2026 - 31.01.2026 - CH6580808000000000001 - 2026-01-31.pdf'), { fromDate: '2026-01-01', toDate: '2026-01-31' });
  assert.equal(statementPdf('20260105-example-cloud-invoice-2026-01.pdf'), null);
});

test('books 4 → 5: a receipt nobody typed that reads as a statement is typed and dated; a person\'s kind, an own date and an invoice stay; the step runs twice to the same result', () => {
  const invoice = { id: 'inv', filename: 'r.pdf', date: '2026-02-03', extractedText: 'Swisscom AG\nRechnung 4711\nTotal CHF 89.00\nMWST 8.1%' };
  const books = {
    schema: 4, config: { closedThrough: '2026-03-31' },
    receipts: [
      { id: 'a', ...doc(KONTOAUSZUG, 'Kontoauszug.pdf') },
      { id: 'b', ...doc(KONTOAUSZUG, 'b.pdf'), kind: 'invoice', kindBy: 'human' },
      { id: 'c', ...doc(KONTOAUSZUG, 'c.pdf'), date: '2026-03-02' },
      { id: 'd', ...doc(KONTOAUSZUG, '20260305-d.pdf'), date: '2026-03-05', dateSource: 'captured' },
      invoice,
    ],
  };
  const clone = (d: Record<string, unknown>) => structuredClone(d);
  const once = climb<Record<string, unknown>>(books, 4, BOOKS_SCHEMA, BOOKS_MIGRATIONS, 'ledger.json', clone);
  const twice = climb<Record<string, unknown>>(once, 4, BOOKS_SCHEMA, BOOKS_MIGRATIONS, 'ledger.json', clone);
  const [a, b, c, d, e] = once.receipts as Array<Record<string, unknown>>;
  const typed = { kind: 'statement', kindBy: 'rule', kindRule: 'document:statement' };
  assert.deepEqual(a, { ...books.receipts[0], ...typed, date: '2026-02-28' });
  assert.deepEqual(b, books.receipts[1], 'a kind a person gave stays');
  assert.deepEqual(c, { ...books.receipts[2], ...typed }, 'its own date stays');
  assert.deepEqual(d, { id: 'd', ...doc(KONTOAUSZUG, '20260305-d.pdf'), ...typed, date: '2026-02-28' }, 'a day read off the name gives way to the period');
  assert.deepEqual(e, invoice);
  assert.deepEqual(twice, once);
  assert.equal('kind' in books.receipts[0], false, 'the books handed in are not changed');
});
