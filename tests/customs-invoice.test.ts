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
import { assessmentAccess, assessmentFacts, customsSplit, missingAssessments, positionOf, readAssessment, type SplitContext } from '../src/booking/customs-invoice.js';
import { applyAnswer } from '../src/server/edits.js';
import type { RequestError } from '../src/server/books.js';
import { documentKind } from '../src/intake/document-kind.js';
import { parseBookedBy } from '../src/books/booked-by.js';
import { ledgerOf } from '../src/app/areas/receipts/model.js';
import { fitOf, pairableReceipt } from '../src/intake/pairing.js';
import { classifyStep } from '../src/intake/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { documents } from '../src/engines/index.js';
import { loadChart } from '../src/workspace/chart.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Index, JournalEntry, Receipt, ReceiptLine } from '../src/types/index.js';
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
  const chart: Array<{ number: string }> = JSON.parse(readFileSync(accounts, 'utf8'));
  writeFileSync(accounts, JSON.stringify([...chart, ...added.filter((a) => !chart.some((c) => c.number === a.number))]));
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
  assert.deepEqual(first.by, { kind: 'code', check: 'purchaseVat' });
  assert.deepEqual(parseBookedBy(first.by), first.by, 'the books keep who booked it');
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
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(company())).booked, 0, 'the pass books no second deduction');
});

test('an assessment proves nothing for another firm, nor one whose amount no import VAT line has', () => {
  const words = documents().customs;
  assert.equal(readAssessment(assessment(), words, { uid: 'CHE-111.222.333' }), undefined, 'another importer');
  assert.deepEqual(readAssessment(assessment(), words, { uid: 'CHE-123.456.789' }), { receipt: 'evv1', file: assessment().filename, date: '2026-05-09', amount: 57.55, rate: 8.1, number: '26CHEI000000004711' });
  const invoiceText = readAssessment(invoice({ extractedText: `${INVOICE_TEXT}\nEinfuhrsteuer gemäss Veranlagungsverfügung MWST` }), words, { uid: 'CHE-123.456.789' });
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
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1);
  const deduction = books.journalEntries.at(-1)!;
  assert.deepEqual([deduction.date, deduction.accountDebit, deduction.accountCredit, deduction.amount, deduction.vatCode, deduction.corrects], [PAYMENT.date, '', '4030', 57.55, 'M81-2', undefined]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evv1' && m.transactionRef === 'P-1'), 'the assessment is linked to its payment');
  assert.ok(books.journalEntries.filter((e) => e.transactionRef === 'P-1').every((e) => e.receipts?.includes('evv1')), 'the bookings saw it: no rebooking for it');
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 0, 'idempotent');
  books.receipts.push(assessment({ id: 'evv2', filename: 'copy-of-the-assessment.pdf' }));
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 0, 'a second copy of the assessment brings no second deduction');
});

test('an assessment that comes after the quarter was filed: the deduction is a correction in the open period, naming the filed entry, declared on the filed quarter\'s correction return', async () => {
  const ws = company();
  const books = booksOf([invoice()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.config.closedThrough = '2026-06-30';
  books.receipts.push(assessment({ date: '2026-07-20' }));
  const filed = books.journalEntries.map((e) => ({ ...e }));
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1);
  const correction = books.journalEntries.at(-1)!;
  const original = books.journalEntries.find((e) => e.accountDebit === '4030')!;
  assert.deepEqual([correction.date, correction.corrects, correction.vatCode, correction.amount], ['2026-07-20', '2026-Q2', 'M81-2', 57.55]);
  assert.match(correction.transactionRef, /^M2026-\d{3}$/, 'a booking of its own without a payment, as a correction by hand is');
  assert.match(correction.description ?? '', new RegExp(`Korrektur zu Buchung ${original.id} \\(2026-Q2\\)`));
  assert.deepEqual(books.journalEntries.slice(0, filed.length), filed, 'the filed bookings stay as filed');
  assert.equal(books.receipts.find((r) => r.id === 'evv1')?.filedPayment, 'P-1', 'no link into the filed quarter: the assessment points at its payment');
  assert.deepEqual(books.mappings.filter((m) => m.receiptId === 'evv1').map((m) => m.transactionRef), [correction.transactionRef], 'linked to its correction, never to the filed payment');
  const view = ledgerOf(books as unknown as Index, '2026-07-01').views.find((v) => v.r.id === 'evv1')!;
  assert.ok(view.links.length > 0 && !view.links.includes('P-1'), 'its page shows the correction made, and offers none to make (Detail.tsx FiledPaymentNotice corrected)');
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 0, 'idempotent');
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

/** The checks a build before #197 keeps when it reads `by` (src/books/booked-by.ts): a sealed quarter hashes `by`, so nothing else may stand there. */
const CHECKS_BEFORE = ['saleCode', 'payoutReport', 'payoutOrders', 'creditNote', 'acquisitionTax', 'purchaseVat'];

test('every booking of the split and the deductions names a check older builds keep: a sealed quarter reads the same in every build', async () => {
  const ws = company();
  const books = booksOf([invoice()]);
  await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.config.closedThrough = '2026-06-30';
  books.receipts.push(assessment({ date: '2026-07-20' }));
  bookImportVatDeductions(books, loadClassifyContext(ws));
  assert.equal(books.journalEntries.length, 4);
  for (const e of books.journalEntries) assert.ok(e.by?.kind === 'code' && CHECKS_BEFORE.includes(e.by.check), `${e.description}: ${JSON.stringify(e.by)}`);
});

test('a person\'s word stands: a deduction she removed or changed is not booked again, and an assessment she typed as something else is not used', async () => {
  const ws = company();
  const setUp = async () => {
    const books = booksOf([invoice()]);
    await classifyTransactions(books, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
    books.receipts.push(assessment());
    assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1);
    return books;
  };
  const removed = await setUp();
  removed.journalEntries = removed.journalEntries.filter((e) => e.vatCode !== 'M81-2');
  removed.mappings = removed.mappings.filter((m) => m.receiptId !== 'evv1');
  assert.equal(bookImportVatDeductions(removed, loadClassifyContext(ws)).booked, 0, 'removed with its link: not booked again');

  const changed = await setUp();
  const d = changed.journalEntries.find((e) => e.vatCode === 'M81-2')!;
  Object.assign(d, { vatCode: 'M0', by: { kind: 'person', at: '2026-10-27T00:00:00Z' } });
  assert.equal(bookImportVatDeductions(changed, loadClassifyContext(ws)).booked, 0, 'changed by her: not booked beside it');

  const typed = booksOf([invoice()]);
  await classifyTransactions(typed, [PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  typed.receipts.push(assessment({ kind: 'invoice', kindBy: 'human' }));
  assert.equal(bookImportVatDeductions(typed, loadClassifyContext(ws)).booked, 0, 'a person typed it as an invoice: it proves nothing by code');
});

test('one invoice of two shipments: each import VAT line is deducted by its own assessment', async () => {
  const text = `${INVOICE_TEXT}\nZweite Sendung: Zollanmeldungsnummer 26CHEI000000004712`;
  const lineItems: ReceiptLine[] = [
    { description: 'Einfuhrsteuer Sendung 1', gross: 30, ratePercent: 0 },
    { description: 'Einfuhrsteuer Sendung 2', gross: 20, ratePercent: 0 },
    { description: 'Vorlageprovision', gross: 7, ratePercent: 0 },
  ];
  const tx = { ...PAYMENT, amount: 57 };
  const books = booksOf([invoice({ amount: 57, lineItems, extractedText: text })], undefined, { tx });
  const ws = company();
  await classifyTransactions(books, [tx], { fx, context: loadClassifyContext(ws), ask: noModel });
  books.receipts.push(
    assessment({ id: 'evvA', extractedText: ASSESSMENT_TEXT.replace('57.55', '30.00') }),
    assessment({ id: 'evvB', extractedText: ASSESSMENT_TEXT.replace('57.55', '20.00').replaceAll('26CHEI000000004711', '26CHEI000000004712') }),
  );
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 2);
  assert.deepEqual(lines(books).filter((l) => l[3] === 'M81-2').map((l) => l[2]).sort(), [20, 30]);
});

test('a copy of one assessment proves no other shipment: the number decides, and copies count once', () => {
  const words = documents().customs;
  const other = invoice({ id: 'inv2', extractedText: INVOICE_TEXT.replaceAll('26CHEI000000004711', '26CHEI000000009999') });
  const split = customsSplit(PAYMENT, [other, assessment(), assessment({ id: 'evv1-copy' })], splitContext());
  assert.ok(split && 'lines' in split);
  assert.deepEqual(split.assessments, [], 'the invoice names another assessment: same tax, other shipment');
  const own = customsSplit(PAYMENT, [invoice(), assessment(), assessment({ id: 'evv1-copy' })], splitContext());
  assert.ok(own && 'lines' in own);
  assert.equal(own.deductions.size, 1, 'two copies of one assessment deduct once');
  assert.equal(readAssessment(assessment(), words, { uid: 'CHE-123.456.789' })?.number, '26CHEI000000004711');
});

test('import VAT paid to the customs office itself: the assessment is the payment\'s receipt, found by its number and amount, booked as import VAT with the deduction', async () => {
  const toCustoms: BankTransaction = { ref: 'Z-1', bank: 'Raiffeisen', date: '2026-05-20', amount: 57.55, currency: 'CHF', direction: 'DBIT', description: 'BAZG Einfuhrabgaben', reference: '26CHEI000000004711' };
  const evv = assessment();
  assert.deepEqual(assessmentFacts(ASSESSMENT_TEXT, documents().customs).amount, 57.55, 'read at its arrival: its tax, for the matching');
  assert.ok(assessmentFacts(ASSESSMENT_TEXT, documents().customs).date?.startsWith('2026-05-0'));
  assert.ok(pairableReceipt(evv, new Set()), 'an assessment is a candidate receipt');
  const fit = fitOf(evv, toCustoms, () => undefined, () => false);
  assert.ok(fit?.number, 'the payment names its number');
  assert.equal(fitOf(evv, { ...toCustoms, reference: undefined }, () => undefined, () => false), undefined, 'a payment that names no assessment is never its');
  const books = booksOf([evv], undefined, { tx: toCustoms });
  await classifyTransactions(books, [toCustoms], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(lines(books, 'Z-1'), [['4030', '1021', 57.55, 'M0'], ['', '4030', 57.55, 'M81-2']]);
  assert.match(books.journalEntries[0].reason ?? '', /direkt an den Zoll/);
});

test('a person who takes the assessment off the payment the split deducted it on is not overruled: the mark is kept on the usual run, and no copy deducts elsewhere', async () => {
  const ws = company();
  const books = booksOf([invoice(), assessment()]);
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  await classifyStep()({ ws, books: port, progress: () => {}, log: () => {} });
  assert.deepEqual(lines(books).at(-1), ['', '4030', 57.55, 'M81-2'], 'the split deducts with the assessment linked');
  assert.ok(books.receipts.find((r) => r.id === 'evv1')?.importVatDeduction, 'the run keeps the mark, though it booked nothing more itself');
  // The person takes the assessment off the payment («Lösen»): the payment is booked again without it.
  books.mappings = books.mappings.filter((m) => m.receiptId !== 'evv1');
  books.receipts.find((r) => r.id === 'evv1')!.notPaidBy = ['P-1'];
  books.journalEntries = [];
  await classifyStep()({ ws, books: port, progress: () => {}, log: () => {} });
  assert.deepEqual(lines(books).map((l) => l[3]), ['M0', 'M0', 'M0'], 'no deduction comes back');
  assert.ok(!books.mappings.some((m) => m.receiptId === 'evv1'), 'and the assessment is not linked back');

  // A copy of the used assessment proves nothing on another courier payment of the same tax.
  const p2: BankTransaction = { ...PAYMENT, ref: 'P-2', date: '2026-05-25' };
  books.transactions.push(p2);
  books.receipts.push(invoice({ id: 'inv2', extractedText: 'Zollrechnung ZR-2026-0900' }), assessment({ id: 'evv1-copy' }));
  books.mappings.push({ transactionRef: 'P-2', receiptId: 'inv2' });
  await classifyStep()({ ws, books: port, progress: () => {}, log: () => {} });
  assert.deepEqual(lines(books, 'P-2').map((l) => l[3]), ['M0', 'M0', 'M0']);
});

test('an import VAT line that claimed input tax already (the model or a rule booked it at a rate) gets no second deduction from a later assessment', () => {
  const books = booksOf([invoice()]);
  books.journalEntries.push({ id: 'm1', transactionRef: 'P-1', date: PAYMENT.date, accountDebit: '4030', accountCredit: '1021', amount: 67.5, vatCode: 'M81', description: 'Muster Kurier AG', origin: 'classify', by: { kind: 'model', model: 'm' }, receipts: ['inv1'] });
  books.receipts.push(assessment());
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(company())).booked, 0);
});

/**
 * Issue #227: a courier's invoice that prints the import VAT as «MwSt / TVA / IVA» at code Z (0 %),
 * duty as a line of 0.00, and its extra services (one of them a printed invoice, named by no
 * position) at 8.1 %. Invented, of the shape seen in a replay.
 */
const Z_TEXT = fixture('courier-vat-line-invoice.txt');
const Z_LINES: ReceiptLine[] = [
  { description: 'Einfuhrzoll / droits de douane / dazi e oneri', gross: 0, ratePercent: 0 },
  { description: 'MwSt / TVA / IVA', gross: 7.2, ratePercent: 0 },
  { description: 'Sonstige Abgaben / autres frais / altre spese', gross: 0, ratePercent: 0 },
  { description: 'Kontoabwicklungsgebühr / frais de gestion de compte', gross: 16.2, ratePercent: 8.1 },
  { description: 'Vorlagegebühr / Frais d\'avance de fonds', gross: 4.32, ratePercent: 8.1 },
  { description: 'GEDRUCKTE RECHNUNG / FACTURE IMPRIMÉE / FATTURA CARTACEA', gross: 2.16, ratePercent: 8.1 },
];
const Z_PAYMENT: BankTransaction = { ...PAYMENT, ref: 'P-Z', amount: 29.88, description: 'Muster Express AG' };
const zInvoice = (o: Partial<Receipt> = {}) => invoice({ id: 'invz', filename: '20260512-muster-express-rechnung-mx1234567.pdf', extractedText: Z_TEXT, amount: 29.88, hasSwissVat: true, lineItems: Z_LINES, ...o });
const zAssessment = () => assessment({ id: 'evvz', extractedText: ASSESSMENT_TEXT.replace('57.55', '7.20').replace('26CHEI000000004711', '26CHX4711000815'), amount: 7.2 });

test('#227: «MwSt / TVA / IVA» at 0 % on an invoice that prints duty at 0.00 is the import VAT; an unnamed line at 8.1 % is the carrier\'s fee; split in code without asking the model', async () => {
  const books = booksOf([zInvoice()], undefined, { tx: Z_PAYMENT });
  const out = await classifyTransactions(books, [Z_PAYMENT], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(out.classified, ['P-Z']);
  assert.deepEqual(lines(books, 'P-Z'), [['4030', '1021', 7.2, 'M0'], ['4040', '1021', 22.68, 'M81']]);
  assert.match(books.journalEntries[0].reason ?? '', /Einfuhrsteuer CHF 7\.20 ohne Vorsteuerabzug/);
});

test('#227: a tax line alone is no customs invoice, and a tax line at a rate (the carrier\'s own VAT as a line) holds the split', () => {
  const words = documents().customs;
  const plain = invoice({ lineItems: [{ description: 'Beratung', gross: 100, ratePercent: 8.1 }, { description: 'MwSt', gross: 8.1, ratePercent: 0 }], amount: 108.1 });
  assert.equal(customsSplit({ ...PAYMENT, amount: 108.1 }, [plain], splitContext()), undefined, 'no line names duty or import VAT: the model\'s');
  const own = zInvoice({ lineItems: [...Z_LINES.slice(0, 4), { description: 'MWST', gross: 1.68, ratePercent: 8.1 }] });
  const split = customsSplit(Z_PAYMENT, [own], splitContext());
  assert.deepEqual(split && 'hold' in split && split.hold, { why: 'line', file: own.filename, line: 'MWST' });
  assert.equal(positionOf('MwSt / TVA / IVA', words), undefined, 'the words alone name no position: only on a customs invoice at no rate');
});

test('#227: «Veranlagungsverfügung fehlt» lists the import VAT without its assessment, with the declaration number, access code and link the invoice names; the deduction settles it', async () => {
  const words = documents().customs;
  assert.deepEqual(assessmentAccess(Z_TEXT, words), { numbers: ['26CHX4711000815'], code: 'Ab3+Xy9Kq2Lm', url: 'https://e-dec-web.ezv.admin.ch/edecZugangscodeGui' });
  assert.deepEqual(assessmentAccess('Zugangscode: K7p-22xQ\nDeklarationsnummer 26CHEI000000004711', words).code, 'K7p-22xQ', 'or after its label in a sentence');
  const ws = company();
  const books = booksOf([zInvoice()], undefined, { tx: Z_PAYMENT });
  assert.deepEqual(missingAssessments(books, words, true), [], 'an unbooked payment is a task of its own');
  await classifyTransactions(books, [Z_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  const [missing] = missingAssessments(books, words, true);
  assert.deepEqual([missing.payment, missing.receipt, missing.amount, missing.access.code], ['P-Z', 'invz', 7.2, 'Ab3+Xy9Kq2Lm']);
  assert.deepEqual(missingAssessments(books, words, false), [], 'a firm without input tax deducts none');
  books.receipts.push(zAssessment());
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1, 'the assessment that comes brings the deduction');
  assert.deepEqual(lines(books, 'P-Z').at(-1), ['', '4030', 7.2, 'M81-2']);
  assert.deepEqual(missingAssessments(books, words, true), []);
});

test('#227: the assistant books import VAT by the same rule: no tax-amount code against the bank, no input tax on import VAT without the assessment, the one-sided deduction with it', async () => {
  const ws = company();
  const ctx = { bankAccounts: ws.bankAccounts, chart: new Set<string>(), earlier: [], conversation: 'c', firm: { uid: 'CHE-123.456.789' }, clearing: new Set<string>() };
  const booked = async () => {
    const books = booksOf([zInvoice()], undefined, { tx: Z_PAYMENT });
    await classifyTransactions(books, [Z_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
    return books;
  };
  const refusal = (code: string) => (e: unknown) => (e as RequestError).refusal?.code === code;
  let books = await booked();
  const vatLine = books.journalEntries.find((e) => e.accountDebit === '4030')!;
  assert.throws(() => applyAnswer(books, [{ kind: 'entry', id: vatLine.id, set: { vatCode: 'M81-2' } }], ctx), refusal('taxAmountTwoSided'), 'the import VAT as cost and input tax at once');
  assert.throws(() => applyAnswer(books, [{ kind: 'entry', id: vatLine.id, set: { vatCode: 'M81' } }], ctx), refusal('importVatUnproven'), 'a rate on the import VAT account');
  const deduction = { transactionRef: 'P-Z', date: Z_PAYMENT.date, accountDebit: '', accountCredit: '4030', amount: 7.2, vatCode: 'M81-2', description: 'Vorsteuer Einfuhrsteuer' };
  assert.throws(() => applyAnswer(books, [{ kind: 'newEntry', entry: deduction }], ctx), refusal('importVatUnproven'), 'the courier\'s invoice is no proof');
  books = await booked();
  books.receipts.push(zAssessment());
  applyAnswer(books, [{ kind: 'link', receipt: 'evvz', payment: 'P-Z' }, { kind: 'newEntry', entry: deduction }], ctx);
  assert.deepEqual(lines(books, 'P-Z').at(-1), ['', '4030', 7.2, 'M81-2'], 'with the assessment linked the deduction stands');
});

function splitContext(o: Partial<SplitContext> = {}): SplitContext {
  return {
    words: documents().customs, chart: new Set(['4020', '4030', '4040', '6280']), firm: { uid: 'CHE-123.456.789' }, inputTax: true,
    convert: () => undefined, texts: { position: (p) => p, deduction: (a) => a.file }, name: 'Muster Kurier AG', ...o,
  };
}

/**
 * Issue #285: the assessment's header is a column of labels and a column of values, so the text puts
 * the other fields' values (bordereau number, country, positions, the account, the UID, the currency)
 * between «Gesamtbetrag MWST» and its amount. Invented, of the shape seen on a real assessment.
 */
const COLUMNS_TEXT = fixture('assessment-columns.txt');

test('#285: the assessment\'s total is read wherever the text puts it after its label on its page, never a date, a UID or a tariff number', () => {
  const words = documents().customs;
  const columns = assessment({ id: 'evvc', extractedText: COLUMNS_TEXT });
  assert.ok(COLUMNS_TEXT.indexOf('41.30') - COLUMNS_TEXT.indexOf('Gesamtbetrag MWST') > 80, 'the amount stands further from its label than the reader once looked');
  assert.deepEqual(readAssessment(columns, words, { uid: 'CHE-123.456.789' }), { receipt: 'evvc', file: columns.filename, date: '2026-05-09', amount: 41.3, rate: 8.1, number: '26CHEI000000008812' });
  assert.equal(assessmentFacts(COLUMNS_TEXT, words).amount, 41.3);
  const dated = COLUMNS_TEXT.replace('Euro (EUR)', 'Euro (EUR)\n26.08.2026\n9003.1100\nCHE-123.456.789');
  assert.equal(readAssessment({ ...columns, extractedText: dated }, words, { uid: 'CHE-123.456.789' })?.amount, 41.3, 'a date, a tariff number and a UID are no money');
  const nextPage = `VERANLAGUNGSVERFÜGUNG MWST\nCHE123456789\nGesamtbetrag MWST [CHF]:\n\f12.50\n`;
  assert.equal(readAssessment({ ...columns, extractedText: nextPage }, words, { uid: 'CHE-123.456.789' }), undefined, 'a later page\'s money is not the total');
});

/**
 * Issue #285: a courier's invoice that names the import VAT it advanced only as «MWST.-freie Kosten»,
 * its own VAT on the advance fee as «8,10 % MWST» at no rate of the line's own, and cites the
 * declaration's number. Invented.
 */
const UNTAXED_LINES: ReceiptLine[] = [
  { description: 'Vorlageprovisionsgebühr', gross: 26.5, ratePercent: 8.1 },
  { description: 'MWST.-freie Kosten', gross: 41.3, ratePercent: 0 },
  { description: '8,10 % MWST', gross: 2.15, ratePercent: 0 },
];
const UNTAXED_TEXT = 'Rechnung\nMuster Kurier AG\nKosten: 26,50\n8,10 % MWST: 2,15\nTotal MWST.-frei: 41,30\nFälliger Gesamtbetrag CHF 69,95\nZollquittungsnummer: 26CHEI000000008812\nZugangscode: Qw3rTy7u';
const U_PAYMENT: BankTransaction = { ...PAYMENT, ref: 'P-U', amount: 69.95 };
const uInvoice = (o: Partial<Receipt> = {}) => invoice({ id: 'invu', filename: '20260512-muster-kurier-rechnung-4711.pdf', extractedText: UNTAXED_TEXT, amount: 69.95, hasSwissVat: true, lineItems: UNTAXED_LINES, ...o });

test('#285: costs free of VAT on an invoice that cites the declaration are the import VAT; «8,10 % MWST» is the carrier\'s VAT on its fee; the assessment proves the import VAT line', async () => {
  const books = booksOf([uInvoice(), assessment({ id: 'evvc', extractedText: COLUMNS_TEXT, amount: 41.3 })], undefined, { tx: U_PAYMENT });
  const out = await classifyTransactions(books, [U_PAYMENT], { fx, context: loadClassifyContext(company()), ask: noModel });
  assert.deepEqual(out.classified, ['P-U']);
  assert.deepEqual(lines(books, 'P-U'), [['4040', '1021', 28.65, 'M81'], ['4030', '1021', 41.3, 'M0'], ['', '4030', 41.3, 'M81-2']],
    'the fee with its 2.15 VAT claims that VAT; the import VAT is deducted by the assessment');
});

test('#285: costs free of VAT name no import VAT on an invoice that cites no declaration, and the carrier\'s VAT without a fee at its rate holds the split', () => {
  const postage = uInvoice({ extractedText: 'Rechnung\nPorto und MWST.-freie Kosten' });
  assert.equal(customsSplit(U_PAYMENT, [postage], splitContext()), undefined, 'postage and others list VAT-free costs too: the model\'s');
  const lone = uInvoice({ lineItems: [{ description: 'MWST.-freie Kosten', gross: 67.8, ratePercent: 0 }, UNTAXED_LINES[2]] });
  const split = customsSplit(U_PAYMENT, [lone], splitContext());
  assert.deepEqual(split && 'hold' in split && split.hold, { why: 'line', file: lone.filename, line: '8,10 % MWST' });
});

/**
 * A courier's invoice that names the import VAT it advanced only as «MWST.» at no rate (printed as
 * «Kosten … Total MWST.-frei»), its fee with its own VAT at 8.1 %, and cites the declaration's
 * number. Invented, of the shape seen in a replay.
 */
const TAX_LINES: ReceiptLine[] = [
  { description: 'Vorlageprovisionsgebühr', gross: 28.65, ratePercent: 8.1 },
  { description: 'MWST.', gross: 41.3, ratePercent: 0 },
];
const TAX_TEXT = 'Rechnung\nMuster Kurier AG\nKosten: 26,50\nTotal MWST.-pflichtig: 26,50\n8,10 % MWST: 2,15\nKosten: 41,30\nTotal MWST.-frei: 41,30\nFälliger Gesamtbetrag CHF 69,95\nZollquittungsnummer: 26CHEI000000008812\nZugangscode: Qw3rTy7u';
const T_PAYMENT: BankTransaction = { ...PAYMENT, ref: 'P-T', amount: 69.95 };
const tInvoice = (o: Partial<Receipt> = {}) => invoice({ id: 'invt', filename: '20260512-muster-kurier-rechnung-4712.pdf', extractedText: TAX_TEXT, amount: 69.95, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 2.15, gross: 28.65 }, { ratePercent: 0, vat: 0, gross: 41.3 }], lineItems: TAX_LINES, ...o });
const tAssessment = (o: Partial<Receipt> = {}) => assessment({ id: 'evvt', extractedText: COLUMNS_TEXT, amount: 41.3, ...o });

test('«MWST.» at no rate on an invoice that cites the declaration is the import VAT: split in code, and the assessment of that number no one linked brings its deduction', async () => {
  const ws = company();
  const books = booksOf([tInvoice(), tAssessment()], ['invt'], { tx: T_PAYMENT });
  const out = await classifyTransactions(books, [T_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  assert.deepEqual(out.classified, ['P-T']);
  assert.deepEqual(lines(books, 'P-T'), [['4040', '1021', 28.65, 'M81'], ['4030', '1021', 41.3, 'M0']]);
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1);
  assert.deepEqual(lines(books, 'P-T').at(-1), ['', '4030', 41.3, 'M81-2']);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evvt' && m.transactionRef === 'P-T'), 'the assessment is linked to its payment');
});

test('«MWST.» at no rate on an invoice that cites no declaration is no customs invoice: the model\'s', () => {
  assert.equal(customsSplit(T_PAYMENT, [tInvoice({ extractedText: 'Rechnung\nMuster Kurier AG\nTotal MWST.-frei: 41,30' })], splitContext()), undefined);
});

/** An invoice whose lines code does not read as a customs invoice, and a model that books its payment with a rate on the import VAT account. */
const unread = () => tInvoice({ lineItems: [{ description: 'Sendungsnummer 4712', gross: 69.95, ratePercent: 0 }] });
const ratedModel = async () => JSON.stringify({ 'P-T': { reason: 'Kurierrechnung mit Einfuhrsteuer', entries: [
  { accountDebit: '4040', accountCredit: '', amount: 28.65, vatCode: 'M81', description: 'Muster Kurier AG, Vorlageprovision' },
  { accountDebit: '4030', accountCredit: '', amount: 41.3, vatCode: 'M81', description: 'Muster Kurier AG, Einfuhrsteuer' },
] } });

test('the model\'s rate on the import VAT account is left off: the import VAT is a cost without input tax until the assessment deducts it', async () => {
  const books = booksOf([unread()], undefined, { tx: T_PAYMENT });
  const out = await classifyTransactions(books, [T_PAYMENT], { fx, context: loadClassifyContext(company()), ask: ratedModel });
  assert.deepEqual(out.classified, ['P-T']);
  const vatLine = books.journalEntries.find((e) => e.accountDebit === '4030')!;
  assert.deepEqual([vatLine.amount, vatLine.vatCode], [41.3, undefined], 'no input tax claimed on the import VAT itself');
  assert.deepEqual(vatLine.by, { kind: 'code', check: 'purchaseVat' });
  assert.match(vatLine.reason ?? '', /Veranlagungsverfügung/);
});

test('an invoice code does not read as a customs invoice: the model\'s import VAT line is paired with the assessment no one linked whose number the invoice cites, never with one of another number', async () => {
  const ws = company();
  const run = async (evv: Receipt) => {
    const books = booksOf([unread(), evv], ['invt'], { tx: T_PAYMENT });
    await classifyTransactions(books, [T_PAYMENT], { fx, context: loadClassifyContext(ws), ask: ratedModel });
    return books;
  };
  const other = await run(tAssessment({ extractedText: COLUMNS_TEXT.replace('26CHEI000000008812', '26CHEI000000009999') }));
  assert.equal(bookImportVatDeductions(other, loadClassifyContext(ws)).booked, 0, 'an assessment of another declaration proves nothing here');
  const books = await run(tAssessment());
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 1);
  assert.deepEqual(lines(books, 'P-T').at(-1), ['', '4030', 41.3, 'M81-2']);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evvt' && m.transactionRef === 'P-T'), 'the assessment is linked to its payment');
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 0, 'idempotent');
});

/**
 * An assessment printed as a table (labels in one column, values in the next), its tax labelled
 * «MWST-Betrag» and no «Gesamtbetrag MWST», at the reduced rate. Read as text the labels come
 * first and the values after them, so the first money after a label is the tax base.
 */
const TABLE_TEXT = fixture('assessment-table.txt');
const tableAssessment = (o: Partial<Receipt> = {}) => assessment({ id: 'evvk', filename: '20261019-bazg-veranlagungsverfuegung-mwst.pdf', extractedText: TABLE_TEXT, date: '2026-10-19', amount: 29, ...o });
const K_LINES: ReceiptLine[] = [
  { description: 'Zoll', gross: 0, ratePercent: 0 },
  { description: "Einfuhrsteuer (BAZG) 2.6 % auf CHF 1'115.40", gross: 29, ratePercent: 0 },
  { description: 'Vorlageprovision inkl. MWST 8.1 %', gross: 35.88, ratePercent: 8.1 },
];
const K_INVOICE_TEXT = "Muster Kurier AG\nCHE-999.888.777 MWST\nMuster Kaffee GmbH\nZollrechnung 7720-4410\nDatum: 20.10.2026\nPosition\nZoll\nEinfuhrsteuer (BAZG) 2.6 % auf CHF 1'115.40\nVorlageprovision inkl. MWST 8.1 %\nTotal CHF\nDie Veranlagungsverfügung MWST (eVV) liegt bei.\nCHF\n0.00\n29.00\n35.88\n64.88";
const kInvoice = (o: Partial<Receipt> = {}) => invoice({ id: 'invk', filename: '20261020-kurier-zollrechnung-7720-4410.pdf', extractedText: K_INVOICE_TEXT, date: '2026-10-20', amount: 64.88, lineItems: K_LINES, ...o });
const K_PAYMENT: BankTransaction = { ref: 'P-K', bank: 'Raiffeisen', date: '2026-10-23', amount: 64.88, currency: 'CHF', direction: 'DBIT', description: 'Muster Kurier AG' };

test('an assessment printed as a table is read by its tax, base × rate, whatever its label: the tax and the rate it states', () => {
  const words = documents().customs;
  assert.deepEqual(readAssessment(tableAssessment(), words, { uid: 'CHE-123.456.789' }), { receipt: 'evvk', file: tableAssessment().filename, date: '2026-10-19', amount: 29, rate: 2.6 });
  assert.deepEqual(assessmentFacts(TABLE_TEXT, words), { amount: 29, currency: 'CHF', date: '2026-10-19' });
  const cites = kInvoice({ extractedText: `Importeur CHE-123.456.789\n${K_INVOICE_TEXT}\nEinfuhrsteuer 2.6 % auf CHF 1'115.40: CHF 29.00` });
  assert.equal(readAssessment(cites, words, { uid: 'CHE-123.456.789' }), undefined, 'a courier invoice that names the assessment in a sentence is none');
  const mixed = "Veranlagungsverfügung MWST\nImporteur CHE-123.456.789\nBemessungsgrundlage\nSatz\nMWST\n1'000.00\n8.1 %\n81.00\n500.00\n2.6 %\n13.00\nTotal\n94.00";
  assert.deepEqual(readAssessment(tableAssessment({ extractedText: mixed }), words, { uid: 'CHE-123.456.789' }), { receipt: 'evvk', file: tableAssessment().filename, date: '2026-10-19', amount: 94 }, 'two rates: the tax of both, a total row counted once, no one rate');
});

test('the courier\'s bill and the assessment no one linked: the import VAT is deducted at the assessment\'s rate (– / 4030 M26-2) and the assessment is linked to the payment', async () => {
  const ws = company();
  const books = booksOf([kInvoice(), tableAssessment()], ['invk'], { tx: K_PAYMENT, closedThrough: '2026-09-30' });
  await classifyTransactions(books, [K_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  bookImportVatDeductions(books, loadClassifyContext(ws));
  assert.deepEqual(lines(books, 'P-K'), [['4030', '1021', 29, 'M0'], ['4040', '1021', 35.88, 'M81'], ['', '4030', 29, 'M26-2']]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evvk' && m.transactionRef === 'P-K'), 'the assessment is linked to its payment');
  assert.deepEqual(missingAssessments(books, documents().customs, true), [], 'nothing is left unclaimed');
  assert.equal(bookImportVatDeductions(books, loadClassifyContext(ws)).booked, 0, 'idempotent at the reduced rate too');
});

/**
 * Issue #483: a courier's invoice that prints its own VAT on its fee as a line of its own, read as
 * «MWST» at no rate (the VAT step's reading differs from run to run: «MWST 8.1% auf 25.00» or «MWST»),
 * beside the import VAT it advanced and duty of 0.00, with the assessment that proves the import VAT
 * linked. Invented, of the shape of the webshop persona's courier bill.
 */
const F_TEXT = 'Muster Express AG\nRechnung Zoll und Steuern 5310000001\nDatum: 13.07.2026\nZollanmeldung Nr. 26CHEI000000004711, Zugangscode: K7Q2M9XA\n\nPosition\nZoll\nEinfuhrsteuer\nVorlageprovision\nMWST 8.1% auf 25.00\nTotal CHF\nMWST-Nr. CHE-999.888.777 MWST\n\nMWST-Code\nZ 0%\nZ 0%\nE 8.1%\nE\n\nBetrag CHF\n0.00\n129.46\n25.00\n2.03\n156.49';
const F_LINES = (tax: string): ReceiptLine[] => [
  { description: 'Zoll', gross: 0, ratePercent: 0 },
  { description: 'Einfuhrsteuer', gross: 129.46, ratePercent: 0 },
  { description: 'Vorlageprovision', gross: 25, ratePercent: 8.1 },
  { description: tax, gross: 2.03, ratePercent: 0 },
];
const F_PAYMENT: BankTransaction = { ...PAYMENT, ref: 'P-F', date: '2026-07-29', amount: 156.49, description: 'Muster Express AG' };
const fInvoice = (tax: string) => invoice({ id: 'invf', filename: '20260713-muster-express-zoll.pdf', extractedText: F_TEXT, date: '2026-07-13', amount: 156.49, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 25, vat: 2.03 }], lineItems: F_LINES(tax) });
const fAssessment = () => assessment({ id: 'evvf', filename: '20260710-bazg-veranlagungsverfuegung-mwst.pdf', extractedText: ASSESSMENT_TEXT.replace('57.55', '129.46').replace('710.50', '1598.32'), date: '2026-07-10', amount: 129.46 });

for (const tax of ['MWST', 'MWST 8.1% auf 25.00']) {
  test(`#483: the courier's own VAT on its fee, read as «${tax}» at no rate, is the fee's VAT on its line (4040 M81), never import VAT; only the assessment's tax is import VAT, and no assessment is asked for`, async () => {
    const words = documents().customs;
    const ws = company();
    const books = booksOf([fInvoice(tax), fAssessment()], undefined, { tx: F_PAYMENT, closedThrough: '2026-06-30' });
    const out = await classifyTransactions(books, [F_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
    assert.deepEqual(out.classified, ['P-F']);
    assert.deepEqual(lines(books, 'P-F'), [['4030', '1021', 129.46, 'M0'], ['4040', '1021', 27.03, 'M81'], ['', '4030', 129.46, 'M81-2']],
      'the 2.03 is 8.1 % of the fee of 25.00: on the fee\'s line, claimed as input tax');
    assert.doesNotMatch(books.journalEntries[0].reason ?? '', /131\.49/, 'the import VAT is the assessment\'s 129.46, not with the fee\'s VAT');
    assert.deepEqual(missingAssessments(books, words, true), [], 'no «Veranlagungsverfügung fehlt» for the fee\'s VAT');
  });
}

test('#483: a tax line at no rate that is not the tax on the courier\'s taxed lines stays the import VAT it advanced', () => {
  const other = fInvoice('MWST');
  other.lineItems = [F_LINES('')[0], F_LINES('')[2], { description: 'MWST', gross: 131.49, ratePercent: 0 }];
  const split = customsSplit(F_PAYMENT, [other], splitContext());
  assert.ok(split && !('hold' in split));
  assert.equal(split.importVat, 131.49);
});

/** A courier's bill of `lines` at the #483 bill's text, its total their sum, paid at once. */
const sBill = (lines: ReceiptLine[]) => {
  const amount = lines.reduce((s, l) => s + Math.round(l.gross * 100), 0) / 100;
  return { bill: invoice({ ...fInvoice('MWST'), amount, lineItems: lines }), tx: { ...F_PAYMENT, amount } };
};
const tax = (description: string, gross: number): ReceiptLine => ({ description, gross, ratePercent: 0 });
const fee = (gross: number, description = 'Verzollungsgebühr'): ReceiptLine => ({ description, gross, ratePercent: 8.1 });
const zero: ReceiptLine = { description: 'Zoll', gross: 0, ratePercent: 0 };
const positions = (split: ReturnType<typeof customsSplit>) => {
  assert.ok(split && !('hold' in split), JSON.stringify(split));
  return split.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, l.vatCode ?? l.vatRate ?? l.vat]);
};
const evv = (amount: number) => fAssessment().extractedText!.replace('129.46', amount.toFixed(2));

test('#483 review S1: import VAT as much as the fee\'s VAT, and the fee\'s VAT stating its rate: the stated line is the fee\'s, the other stays import VAT, and the assessment proves it', () => {
  const { bill, tx } = sBill([zero, tax('MWST', 6.48), fee(80), tax('MWST 8.1%', 6.48)]);
  assert.deepEqual(positions(customsSplit(tx, [bill], splitContext())), [['4030', '', 6.48, 'none'], ['4040', '', 86.48, 8.1]]);
  const withEvv = customsSplit(tx, [bill, assessment({ id: 'evv6', extractedText: evv(6.48), amount: 6.48 })], splitContext());
  assert.deepEqual(positions(withEvv), [['4030', '', 6.48, 'none'], ['4040', '', 86.48, 8.1], ['', '4030', 6.48, 'M81-2']]);
});

test('#483 review S1d: import VAT within the slack of the fee\'s VAT stays import VAT beside the stated fee VAT', () => {
  const { bill, tx } = sBill([zero, tax('MWST', 6.52), fee(80), tax('MWST 8.1%', 6.48)]);
  assert.deepEqual(positions(customsSplit(tx, [bill], splitContext())), [['4030', '', 6.52, 'none'], ['4040', '', 86.48, 8.1]]);
});

test('#483 review S9: several shipments: an import VAT line as much as the fee\'s VAT stays import VAT when the fee\'s VAT states its rate', () => {
  const { bill, tx } = sBill([tax('MWST', 12), tax('MWST', 8.1), fee(100), tax('MWST 8.1%', 8.1)]);
  const split = customsSplit(tx, [bill], splitContext());
  assert.deepEqual(positions(split), [['4030', '', 12, 'none'], ['4030', '', 8.1, 'none'], ['4040', '', 108.1, 8.1]]);
});

test('#483 review: a bare tax line as much as the fee\'s VAT and as much as an assessment linked beside it stays import VAT; two bare lines that both could be, neither is the fee\'s', () => {
  const { bill, tx } = sBill([zero, tax('MWST', 6.48), fee(80)]);
  assert.deepEqual(positions(customsSplit(tx, [bill], splitContext())), [['4040', '', 86.48, 8.1]], 'alone: the fee\'s VAT');
  const withEvv = customsSplit(tx, [bill, assessment({ id: 'evv6', extractedText: evv(6.48), amount: 6.48 })], splitContext());
  assert.deepEqual(positions(withEvv), [['4030', '', 6.48, 'none'], ['4040', '', 80, 8.1], ['', '4030', 6.48, 'M81-2']]);
  const two = sBill([zero, tax('MWST', 6.48), tax('MWST', 6.48), fee(80)]);
  assert.deepEqual(positions(customsSplit(two.tx, [two.bill], splitContext())), [['4030', '', 6.48, 'none'], ['4030', '', 6.48, 'none'], ['4040', '', 80, 8.1]]);
});

test('#483 review S6: a line that names more than the tax («MWST auf Waren») is not the fee\'s VAT, whatever its amount', () => {
  const { bill, tx } = sBill([zero, fee(80), tax('MWST auf Waren', 6.48)]);
  const split = customsSplit(tx, [bill], splitContext());
  assert.ok(!split || 'hold' in split || !split.lines.some((l) => l.accountDebit === '4040' && l.amount === 86.48), 'never added to the fee');
});

test('#483 review S1c: a fee read with its tax in: the tax line is as much as the share in it', () => {
  const { bill, tx } = sBill([tax('MWST', 41.3), fee(28.65, 'Vorlageprovisionsgebühr'), tax('MWST', 2.15)]);
  const split = customsSplit(tx, [bill], splitContext());
  assert.deepEqual(positions(split), [['4030', '', 41.3, 'none'], ['4040', '', 30.8, 8.1]], 'the 2.15 is the courier\'s, not import VAT');
});

/**
 * The setup asks no UID since #452, so a firm may keep its books without one in Firma › Firma. Its
 * assessment still names it as the importer, by its name (and a UID the settings do not know): the
 * import VAT is deducted as for a firm with a UID. The webshop persona's shape: the courier's bill
 * linked to its payment, the assessment beside it, no one linked it.
 */
function companyWithoutUid(): Workspace {
  const ws = company();
  writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^ {2}uid: .*\n/m, ''));
  return workspaceAt(ws.paths.root);
}
const importerAssessment = (importer: string) => ({ ...fAssessment(), extractedText: fAssessment().extractedText!.replace('MUSTER OPTIK AG', importer) });

test('a firm without a UID in its settings: the assessment that names it as the importer deducts the import VAT; one naming another importer does not', async () => {
  const ws = companyWithoutUid();
  assert.equal(ws.company.uid, undefined, 'the setup kept no UID');
  const books = booksOf([fInvoice('MWST'), importerAssessment('MUSTER KAFFEE GMBH\nMusterstrasse 1, 8000 Zürich')], ['invf'], { tx: F_PAYMENT, closedThrough: '2026-06-30' });
  await classifyTransactions(books, [F_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  bookImportVatDeductions(books, loadClassifyContext(ws));
  assert.deepEqual(lines(books, 'P-F'), [['4030', '1021', 129.46, 'M0'], ['4040', '1021', 27.03, 'M81'], ['', '4030', 129.46, 'M81-2']]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'evvf' && m.transactionRef === 'P-F'), 'the assessment is linked to its payment');
  assert.ok(books.receipts.find((r) => r.id === 'evvf')?.importVatDeduction, 'and marked as deducted');
  assert.equal(workspaceAt(ws.paths.root).company.uid, undefined, 'the UID on the assessment is never kept on its own');

  const other = booksOf([fInvoice('MWST'), importerAssessment('MUSTER KAFFEE GMBH TREUHAND\nBahnhofstrasse 3, 8001 Zürich')], ['invf'], { tx: F_PAYMENT, closedThrough: '2026-06-30' });
  await classifyTransactions(other, [F_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  bookImportVatDeductions(other, loadClassifyContext(ws));
  assert.deepEqual(lines(other, 'P-F'), [['4030', '1021', 129.46, 'M0'], ['4040', '1021', 27.03, 'M81']], 'another firm whose name begins as hers proves nothing for her');

});

/** An assessment of the shape the courier's bill above cites, with `header` as its parties' block. */
const evvOf = (header: string, id = 'evvn'): Receipt => assessment({
  id, filename: `20260710-bazg-${id}.pdf`, date: '2026-07-10', amount: 129.46,
  extractedText: `Bundesamt für Zoll und Grenzsicherheit BAZG\nVERANLAGUNGSVERFÜGUNG MWST\n26CHEI000000004711.1\n\n${header}\n\nGesamtbetrag MWST [CHF]:\n\n129.46\n\nBemessungsgrundlage MWST: 1598.32\nAnsatz [%]: 8.1`,
});
const FIRM = { name: 'Muster Kaffee GmbH', owner: 'Anna Muster' };

test('without a UID the firm is named by its whole name in the importer\'s block, never by a longer name, as consignee, on another page, by one word or by the owner\'s name', () => {
  const words = documents().customs;
  const named = (header: string, firm: { uid?: string; name?: string; owner?: string } = FIRM) => readAssessment(evvOf(header), words, firm)?.amount;
  for (const header of [
    'Importeur:\nMUSTER KAFFEE GMBH\nMusterstrasse 1\nCH 8000 Zürich',
    'Importeur: Muster Kaffee GmbH, Musterstrasse 1, 8000 Zürich',
    'Importeur: c/o Muster Kaffee GmbH, Musterstrasse 1, 8000 Zürich',
    // A header printed as a column of labels and then one of values.
    'Zollanmeldung\nDatum der Annahme\nImporteur\nUID Importeur\nSpediteur\nUrsprungsland\n\n26CHEI000000004711\n10.07.2026\nMuster Kaffee GmbH, Musterstrasse 1, 8000 Zürich\nCHE-999.888.777\nMuster Kurier AG\nJP',
  ]) assert.equal(named(header), 129.46, header);
  for (const [header, why] of [
    ['Importeur:\nZÜRCHER MUSTER KAFFEE GMBH\nBahnhofstrasse 3', 'a longer name in front'],
    ['Importeur:\nALT-MUSTER KAFFEE GMBH', 'a longer name joined in front'],
    ['Importeur:\nMUSTER KAFFEE GMBH (Schweiz) AG', 'a longer name in brackets after'],
    ['Importeur:\nMUSTER KAFFEE GMBH  Holding', 'a longer name after two spaces'],
    ['Importeur:\nMUSTER KAFFEE GMBH TREUHAND', 'a longer name after'],
    ['Importeur:\nMUSTER KAFFEE\nGMBH', 'a name wrapped onto two lines'],
    ['Importeur: Andere Handels AG, Bahnhofstrasse 3, 8001 Zürich\nEmpfänger: Muster Kaffee GmbH, Musterstrasse 1, 8000 Zürich', 'the firm as consignee, another importer'],
    ['Empfänger:\nMuster Kaffee GmbH\nImporteur:\nAndere Handels AG', 'the firm before the importer\'s label'],
    ['Versender: Muster Kaffee GmbH, Leipzig, DE', 'no importer\'s block at all'],
  ]) assert.equal(named(header), undefined, why);
  const courierPage = { ...evvOf('Importeur:\nAndere Handels AG'), extractedText: `Muster Express AG\nMuster Kaffee GmbH\nMusterstrasse 1\n\f${evvOf('Importeur:\nAndere Handels AG').extractedText}` };
  assert.equal(readAssessment(courierPage, words, FIRM), undefined, 'the firm\'s name only on the courier\'s page of the same file');
  assert.equal(named('Importeur:\nOptik\nBahnhofstrasse 3', { name: 'Optik' }), undefined, 'a name of one word is a word of any text');
  assert.equal(named('Importeur:\nAnna Muster\nMusterstrasse 1', { name: 'Anna Muster', owner: 'Anna Muster' }), undefined, 'the owner\'s name alone names a person, not the firm');
  assert.equal(named('Importeur:\nMuster Kaffee GmbH', {}), undefined, 'a firm without UID and name is named by none');
  assert.equal(named('Importeur:\nMUSTER KAFFEE GMBH', { uid: 'CHE-111.222.333', ...FIRM }), undefined, 'a firm with a UID is named by its UID, never by its name alone');
  assert.equal(named('Importeur: Andere Handels AG, CHE-999.888.777\nSpediteur: Muster Kaffee GmbH, CHE-123.456.789', { uid: 'CHE-123.456.789' }), undefined, 'the UID too counts in the importer\'s block only');
});

test('an assessment on file that does not name the firm stays «Veranlagungsverfügung fehlt», and says why', async () => {
  const ws = companyWithoutUid();
  const wrapped = evvOf('Importeur:\nMUSTER KAFFEE\nGMBH\nMusterstrasse 1', 'evvw');
  const books = booksOf([fInvoice('MWST'), wrapped], ['invf'], { tx: F_PAYMENT, closedThrough: '2026-06-30' });
  await classifyTransactions(books, [F_PAYMENT], { fx, context: loadClassifyContext(ws), ask: noModel });
  bookImportVatDeductions(books, loadClassifyContext(ws));
  assert.deepEqual(lines(books, 'P-F'), [['4030', '1021', 129.46, 'M0'], ['4040', '1021', 27.03, 'M81']], 'no deduction from a name code cannot read whole');
  const words = documents().customs;
  const [missing] = missingAssessments(books, words, true, { name: ws.company.name, owner: ws.company.owner });
  assert.deepEqual([missing?.amount, missing?.unnamed], [129.46, { receipt: 'evvw', file: wrapped.filename }], 'the line names the assessment on file that does not name the firm');
  assert.equal(missingAssessments(books, words, true)[0]?.unnamed, undefined, 'without the firm, nothing is said about it');
});
