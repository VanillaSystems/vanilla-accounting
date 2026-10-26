/**
 * A courier's customs invoice booked by its positions (issue #197): the import VAT the carrier
 * advanced, customs duty, the carrier's fees and freight, each on its account, by code from the
 * invoice's read lines. The import VAT is deducted only with the customs office's assessment that
 * names the firm; without it the line is a cost and the booking says so. An assessment that comes
 * later brings its deduction then: on the payment's day while its quarter is open, as a correction
 * in the open period once it is filed. A split that does not add up goes to the model, told why.
 * Synthetic invoices only (tests/fixtures/customs/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookImportVatDeductions, classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { customsSplit, positionOf, readAssessment, type SplitContext } from '../src/booking/customs-invoice.js';
import { documentKind } from '../src/intake/document-kind.js';
import { classifyStep } from '../src/intake/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { documents } from '../src/engines/index.js';
import { loadChart } from '../src/workspace/chart.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Receipt, ReceiptLine } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const fixture = (name: string) => readFileSync(join(APP_ROOT, 'tests/fixtures/customs', name), 'utf8');
const INVOICE_TEXT = fixture('courier-customs-invoice.txt');
const ASSESSMENT_TEXT = fixture('assessment.txt');

/** The demo company (effective method, UID CHE-123.456.789) with the chart's customs accounts. */
function company(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'customs-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const accounts = join(dir, 'master-data/accounts.json');
  const added = [['4020', 'Zölle'], ['4030', 'Einfuhrsteuer'], ['4040', 'Vorlageprovision, Verzollungsspesen'], ['6280', 'Transportaufwand']].map(([number, name]) => ({ number, name }));
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), ...added]));
  return workspaceAt(dir);
}

/** The invoice as the VAT step reads it: its lines, as printed. */
const LINES: ReceiptLine[] = [
  { description: 'Einfuhrsteuer (MWST bei der Einfuhr)', gross: 57.55, ratePercent: 0 },
  { description: 'Zoll', gross: 6.45, ratePercent: 0 },
  { description: 'Vorlageprovision', gross: 3.5, ratePercent: 0 },
];

const invoice = (o: Partial<Receipt> = {}): Receipt => ({
  id: 'inv1', filename: '20260512-kurier-zollrechnung-zr-2026-0815.pdf', originalFilename: 'zr.pdf', extractedText: INVOICE_TEXT,
  extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-05-12T00:00:00Z', location: 'archived',
  date: '2026-05-12', amount: 67.5, currency: 'CHF', vatId: 'CHE-999.888.777', hasSwissVat: false, vatSummary: [{ ratePercent: 0, vat: 0, gross: 67.5 }],
  lineItems: LINES, ...o,
});

const assessment = (o: Partial<Receipt> = {}): Receipt => ({
  ...invoice(), id: 'evv1', filename: '20260509-bazg-veranlagungsverfuegung-mwst.pdf', extractedText: ASSESSMENT_TEXT,
  date: '2026-05-09', amount: 57.55, kind: 'supporting', vatId: undefined, hasSwissVat: undefined, vatSummary: undefined, lineItems: undefined, ...o,
});

const PAYMENT: BankTransaction = { ref: 'P-1', bank: 'Raiffeisen', date: '2026-05-15', amount: 67.5, currency: 'CHF', direction: 'DBIT', description: 'Muster Kurier AG' };

function booksOf(receipts: Receipt[], linked: readonly string[] = receipts.map((r) => r.id), o: { closedThrough?: string; tx?: BankTransaction } = {}): Books {
  const tx = o.tx ?? PAYMENT;
  return {
    transactions: [tx], receipts, mappings: linked.map((receiptId) => ({ transactionRef: tx.ref, receiptId })),
    bankStatements: [], journalEntries: [], config: { closedThrough: o.closedThrough ?? '2026-03-31' },
  } as unknown as Books;
}

const lines = (books: Books, ref = PAYMENT.ref) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e: JournalEntry) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
const fx = loadFxResolver();
const noModel = async (): Promise<string> => { throw new Error('code books a customs invoice; no model call'); };

test('a customs invoice is booked by its positions in code: import VAT, duty and the advance fee each on its account, without input tax, and the booking says the assessment is missing', async () => {
  const books = booksOf([invoice()]);
  const out = await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual([out.classified, out.failed], [['P-1'], []]);
  assert.deepEqual(lines(books), [['4030', '1021', 57.55, 'M0'], ['4020', '1021', 6.45, 'M0'], ['4040', '1021', 3.5, 'M0']]);
  const [first] = books.journalEntries;
  assert.deepEqual(first.by, { kind: 'code', check: 'customsSplit' });
  assert.match(first.reason ?? '', /Einfuhrsteuer CHF 57\.55 ohne Vorsteuerabzug/);
  assert.match(first.reason ?? '', /Veranlagungsverfügung/);
  assert.match(first.description ?? '', /Einfuhrsteuer$/);
});

test('the carrier\'s own Swiss VAT on its fee follows the line\'s rate; freight lands on the transport account', async () => {
  const lineItems: ReceiptLine[] = [
    { description: 'Einfuhr-MWST', gross: 17.9, ratePercent: 8.1 },
    { description: 'Zusatzleistungen (Kontoabwicklungsgebühr, Vorlagegebühr)', gross: 23.78, ratePercent: 8.1 },
    { description: 'Frachtkosten Express', gross: 10.8, ratePercent: 8.1 },
  ];
  const tx = { ...PAYMENT, amount: 52.48 };
  const books = booksOf([invoice({ amount: 52.48, hasSwissVat: true, lineItems })], undefined, { tx });
  await classifyTransactions(books, [tx], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(lines(books), [['4030', '1021', 17.9, 'M0'], ['4040', '1021', 23.78, 'M81'], ['6280', '1021', 10.8, 'I81']],
    'the import VAT line\'s 8.1 is the import tax\'s rate, never the carrier\'s VAT on it');
});

test('a split that does not add up is not booked in code: the model books it, and its reason says why', async () => {
  const books = booksOf([invoice({ lineItems: [LINES[0], LINES[1]] })]);
  let prompted = false;
  const ask = async () => {
    prompted = true;
    return JSON.stringify({ 'P-1': { entries: [{ accountDebit: '4040', accountCredit: '', amount: 67.5, vat: 'none', description: 'Muster Kurier AG, Zollrechnung' }], reason: 'Zollrechnung als Ganzes.' } });
  };
  const out = await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(company()), ask });
  assert.ok(prompted, 'the model decides');
  assert.deepEqual(out.classified, ['P-1']);
  assert.deepEqual(lines(books), [['4040', '1021', 67.5, 'M0']]);
  assert.equal(books.journalEntries[0].by?.kind, 'model');
  assert.match(books.journalEntries[0].reason ?? '', /Zollrechnung nicht nach Positionen gebucht: die Zeilen von .* ergeben 64\.00, die Rechnung 67\.50/);
});

test('a line that names no position, or lumps duty and import VAT, holds the split too', () => {
  const words = documents().customs;
  assert.equal(positionOf('Zoll und Einfuhrsteuer', words), undefined, 'two taxes in one figure');
  assert.equal(positionOf('Vorlageprovision auf Einfuhrsteuer', words), 'fees', 'a fee on the tax is a fee');
  assert.equal(positionOf('Frais de port', words), 'freight', 'the longest word decides');
  assert.equal(positionOf('Autowaschanlage Token', words), undefined);
  const split = customsSplit(PAYMENT, [invoice({ lineItems: [...LINES.slice(0, 2), { description: 'Autowaschanlage Token', gross: 3.5 }] })], splitContext());
  assert.deepEqual(split && 'hold' in split && split.hold, { why: 'line', file: invoice().filename, line: 'Autowaschanlage Token' });
});

test('a carrier invoice without import VAT: freight alone is no customs invoice and stays the model\'s; duty and fees are split, and nothing is said about a deduction', async () => {
  const freight = invoice({ lineItems: [{ description: 'Fracht', gross: 60, ratePercent: 8.1 }, { description: 'Treibstoffzuschlag', gross: 7.5, ratePercent: 8.1 }] });
  assert.equal(customsSplit(PAYMENT, [freight], splitContext()), undefined);

  const books = booksOf([invoice({ lineItems: [{ description: 'Zölle', gross: 64, ratePercent: 0 }, LINES[2]] })]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(lines(books), [['4020', '1021', 64, 'M0'], ['4040', '1021', 3.5, 'M0']]);
  assert.doesNotMatch(books.journalEntries[0].reason ?? '', /Vorsteuer|Veranlagungsverfügung/);
});

test('with the assessment linked, the import VAT is deducted at once: a one-legged line off the import VAT account (– / 4030 M81-2)', async () => {
  const books = booksOf([invoice(), assessment()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(lines(books), [['4030', '1021', 57.55, 'M0'], ['4020', '1021', 6.45, 'M0'], ['4040', '1021', 3.5, 'M0'], ['', '4030', 57.55, 'M81-2']]);
  assert.match(books.journalEntries[0].reason ?? '', /laut Veranlagungsverfügung 20260509-bazg/);
  assert.doesNotMatch(books.journalEntries[0].reason ?? '', /ohne Vorsteuerabzug/);
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(company())), 0, 'the pass books no second deduction');
});

test('an assessment proves nothing for another firm, nor one whose amount no import VAT line has', () => {
  const words = documents().customs;
  assert.equal(readAssessment(assessment(), words, 'CHE-111.222.333'), undefined, 'another importer');
  assert.deepEqual(readAssessment(assessment(), words, 'CHE-123.456.789'), { receipt: 'evv1', file: assessment().filename, date: '2026-05-09', amount: 57.55 });
  const invoiceText = readAssessment(invoice({ extractedText: `${INVOICE_TEXT}\nEinfuhrsteuer gemäss Veranlagungsverfügung MWST` }), words, 'CHE-123.456.789');
  assert.equal(invoiceText, undefined, 'a courier invoice that names the assessment is none: it states no total of the assessment');
  const other = customsSplit(PAYMENT, [invoice(), assessment({ extractedText: ASSESSMENT_TEXT.replace('57.55', '41.20') })], splitContext());
  assert.ok(other && 'lines' in other);
  assert.deepEqual([other.assessments, other.unproven], [[], 57.55]);
});

test('an assessment that comes later, while the quarter is open: the next run finds it by its amount, links it and books the deduction on the payment\'s day', async () => {
  const ws = company();
  const books = booksOf([invoice()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.receipts.push(assessment());
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)), 1);
  const deduction = books.journalEntries.at(-1)!;
  assert.deepEqual([deduction.date, deduction.accountDebit, deduction.accountCredit, deduction.amount, deduction.vatCode, deduction.corrects], [PAYMENT.date, '', '4030', 57.55, 'M81-2', undefined]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evv1' && m.transactionRef === 'P-1'), 'the assessment is linked to its payment');
  assert.ok(books.journalEntries.filter((e) => e.transactionRef === 'P-1').every((e) => e.receipts?.includes('evv1')), 'the bookings saw it: no rebooking for it');
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)), 0, 'idempotent');
  books.receipts.push(assessment({ id: 'evv2', filename: 'copy-of-the-assessment.pdf' }));
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)), 0, 'a second copy of the assessment brings no second deduction');
});

test('an assessment that comes after the quarter was filed: the deduction is a correction in the open period, naming the filed entry, declared on the filed quarter\'s correction return', async () => {
  const ws = company();
  const books = booksOf([invoice()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.config.closedThrough = '2026-06-30';
  books.receipts.push(assessment({ date: '2026-07-20' }));
  const filed = books.journalEntries.map((e) => ({ ...e }));
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)), 1);
  const correction = books.journalEntries.at(-1)!;
  const original = books.journalEntries.find((e) => e.accountDebit === '4030')!;
  assert.deepEqual([correction.date, correction.corrects, correction.vatCode, correction.amount, correction.transactionRef], ['2026-07-20', '2026-Q2', 'M81-2', 57.55, 'P-1']);
  assert.match(correction.description ?? '', new RegExp(`Korrektur zu Buchung ${original.id} \\(2026-Q2\\)`));
  assert.deepEqual(books.journalEntries.slice(0, filed.length), filed, 'the filed bookings stay as filed');
  assert.equal(books.receipts.find((r) => r.id === 'evv1')?.filedPayment, 'P-1', 'no link into the filed quarter: the assessment points at its payment');
  assert.ok(!books.mappings.some((m) => m.receiptId === 'evv1'));
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)), 0, 'idempotent');
});

test('the automation\'s booking step books a late assessment\'s deduction even when no payment is left to book', async () => {
  const ws = company();
  const books = booksOf([invoice()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.receipts.push(assessment());
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  const logged: string[] = [];
  await classifyStep()({ ws, books: port, progress: () => {}, log: (l: string) => logged.push(l) });
  assert.deepEqual(lines(books).at(-1), ['', '4030', 57.55, 'M81-2']);
  assert.ok(logged.some((l) => /1 import VAT deduction/.test(l)));
});

test('paid in another currency: the payment is shared in proportion to the positions; the deduction stays the assessment\'s francs', async () => {
  const tx: BankTransaction = { ...PAYMENT, ref: 'P-EUR', bank: 'Wise', currency: 'EUR', amount: 72.4 };
  const books = booksOf([invoice(), assessment()], undefined, { tx });
  const ctx = loadClassifyContext(company());
  await classifyTransactions(books, [tx], { fx: { ...fx, daily: (c) => (c === 'EUR' ? 0.94 : undefined) }, context: ctx, ask: noModel });
  const got = books.journalEntries.filter((e) => e.transactionRef === 'P-EUR');
  const paid = got.filter((e) => e.accountCredit === '1023').reduce((s, e) => s + Math.round(e.amount * 100), 0);
  assert.equal(paid, 7240, 'the lines add up to what the bank paid, to the cent');
  assert.deepEqual(got.map((e) => [e.accountDebit, e.exchangeCurrency ?? 'CHF']), [['4030', 'EUR'], ['4020', 'EUR'], ['4040', 'EUR'], ['', 'CHF']]);
  assert.equal(got.at(-1)!.amount, 57.55);

  const far = booksOf([invoice()], undefined, { tx: { ...tx, amount: 90 } });
  const split = customsSplit({ ...tx, amount: 90 }, far.receipts, splitContext({ convert: (a) => a / 0.94 }));
  assert.deepEqual(split && 'hold' in split && split.hold.why, 'currency', 'beyond the slack the split holds and names it');
});

test('a firm without input tax never books the deduction', () => {
  const split = customsSplit(PAYMENT, [invoice(), assessment()], splitContext({ inputTax: false }));
  assert.ok(split && 'lines' in split);
  assert.equal(split.deductions.size, 0);
});

test('the customs office\'s assessment is a document beside the courier\'s invoice, never a receipt paid on its own; every position lands on an account of the shipped chart', () => {
  assert.deepEqual(documentKind(ASSESSMENT_TEXT, documents()), { is: 'supporting', why: 'customs-assessment' });
  assert.equal(documentKind(INVOICE_TEXT, documents()).is, 'receipt');
  const chart = new Set(loadChart().accounts.map((a) => a.number));
  for (const [position, { account }] of Object.entries(documents().customs.positions)) assert.ok(chart.has(account), `${position}: ${account}`);
});

function splitContext(o: Partial<SplitContext> = {}): SplitContext {
  return {
    words: documents().customs, chart: new Set(['4020', '4030', '4040', '6280']), uid: 'CHE-123.456.789', inputTax: true,
    convert: () => undefined, texts: { position: (p) => p, deduction: (a) => a.file }, name: 'Muster Kurier AG', ...o,
  };
}
