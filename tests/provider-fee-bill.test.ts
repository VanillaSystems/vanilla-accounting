/**
 * A payment provider's monthly fee bill brings the input tax it shows (bookVatCorrections): the
 * provider keeps its fees from the payouts, so no payment carries them, and the bill's Swiss VAT is one
 * single-leg entry without a payment on the company's fee account. Booked once per bill, never over
 * the person, never in a filed period. Invented business, bills and books.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { bookVatCorrections, type CorrectionContext } from '../src/booking/vat-corrections.js';
import { bookBillCorrections, loadClassifyContext } from '../src/booking/classify.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { parseProvider } from '../src/knowledge/provider.js';
import { applyChange } from '../src/server/edits.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { Books } from '../src/books/store.js';
import type { FxResolver } from '../src/accounting/fx-rates.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';

const FILE = `id: plattform
name: Plattform Beispiel
match:
  tx: [ "plattform beispiel" ]
  uid: [ "CHE-999.888.777" ]
documents:
  - id: fee-bill
    kind: invoice
    text: [ "Plattform Beispiel", "Gebührenrechnung" ]
    proves: vat-correction
provider:
  clearing: "1093"
  since: 2026-07-01
  fees: { account: "6570", vat: I0, billVat: M81-2 }
`;
const plattform = (file = FILE) => compileCounterparty(parse(file), { binding: 'knowledge/suppliers/plattform.yaml' }, 'supplier');

const bill = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'bill-aug', filename: 'gebuehren-august.pdf', originalFilename: 'gebuehren-august.pdf', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date: '2026-09-05', amount: 108.1, currency: 'EUR', vatId: 'CHE-999.888.777', hasSwissVat: true,
  extractedText: 'Plattform Beispiel\nGebührenrechnung August 2026\nGebühren EUR 100.00\nMWST 8.1 % EUR 8.10\nTotal EUR 108.10',
  vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }], ...over,
});
const booksOf = (receipts: Receipt[], journalEntries: JournalEntry[] = [], mappings: Mapping[] = [], closedThrough = '2026-06-30'): Books =>
  ({ receipts, journalEntries, transactions: [] as BankTransaction[], mappings, bankStatements: [], config: { closedThrough } }) as unknown as Books;

let ids = 0;
let refs = 0;
const ctx = (over: Partial<CorrectionContext> = {}): CorrectionContext => ({
  inputTax: true, isClosed: (d) => d <= '2026-06-30', inChart: (a) => ['6570', '1093'].includes(a), base: 'CHF',
  rate: (c, d) => (c === 'EUR' && d === '2026-09-05' ? 0.94879 : undefined),
  code: (_rate, _account, billVat) => billVat ?? 'I81-2',
  newId: () => `e${++ids}`, manualRef: () => `M2026-${String(++refs).padStart(3, '0')}`,
  texts: { description: (b, d) => `${b}, Vorsteuer ${d}`, reason: (b) => `Rechnung von ${b}` },
  ...over,
});

test('the bill books its VAT once: empty debit, the fee account, the code of the tax, in its currency at the day\'s rate, linked', () => {
  const books = booksOf([bill()]);
  const done = bookVatCorrections(books, [plattform()], ctx());
  assert.deepEqual(done.booked, [{ receipt: 'bill-aug', ref: done.booked[0]?.ref }]);
  const ref = done.booked[0].ref;
  assert.deepEqual(books.journalEntries.map(({ id: _id, reason: _r, ...e }) => e), [{
    transactionRef: ref, date: '2026-09-05', accountDebit: '', accountCredit: '6570', amount: 8.1, vatCode: 'M81-2',
    description: 'Plattform Beispiel, Vorsteuer 2026-09-05', exchangeCurrency: 'EUR', exchangeRate: 0.94879,
    origin: 'classify', receipts: ['bill-aug'], by: { kind: 'code', check: 'purchaseVat' },
  }]);
  assert.deepEqual(books.mappings, [{ transactionRef: ref, receiptId: 'bill-aug', by: 'rule', rule: 'vat-correction' }]);
  const again = bookVatCorrections(books, [plattform()], ctx());
  assert.deepEqual([again.booked, again.linked, books.journalEntries.length], [[], [], 1], 'a second run books nothing');
});

test('a correction the person booked already takes the bill instead of a second booking', () => {
  const hers: JournalEntry = { id: 'h1', transactionRef: 'M2026-007', date: '2026-09-06', accountDebit: '', accountCredit: '6570', amount: 8.1, vatCode: 'M81-2', exchangeCurrency: 'EUR', exchangeRate: 0.94879, origin: 'manual' };
  const books = booksOf([bill()], [hers]);
  const done = bookVatCorrections(books, [plattform()], ctx());
  assert.deepEqual([done.booked, done.linked], [[], [{ receipt: 'bill-aug', ref: 'M2026-007' }]]);
  assert.equal(books.journalEntries.length, 1);
  assert.deepEqual(books.journalEntries[0].receipts, ['bill-aug'], 'the booking carries its bill');
});

test('what code cannot decide stays with the person, and nothing is booked', () => {
  const run = (b: Receipt, c: Partial<CorrectionContext> = {}, file = FILE) => {
    const books = booksOf([b]);
    const done = bookVatCorrections(books, [plattform(file)], ctx(c));
    assert.equal(books.journalEntries.length, 0);
    return done.waiting.map((w) => w.why);
  };
  assert.deepEqual(run(bill({ date: '2026-06-05' })), ['filed'], 'a bill of a filed period');
  assert.deepEqual(run(bill({ hasSwissVat: false })), ['noVat'], 'no Swiss VAT on the bill');
  assert.deepEqual(run(bill({ vatId: 'CHE-123.456.789' })), ['noVat'], 'another firm\'s VAT number');
  assert.deepEqual(run(bill({ vatSummary: [] })), ['noVat'], 'no VAT block read');
  assert.deepEqual(run(bill(), { inChart: () => false }), ['noAccount'], 'the fee account is not in the chart');
  assert.deepEqual(run(bill(), {}, FILE.replace(/provider:[\s\S]*$/, '')), ['noAccount'], 'a business that is no payment provider');
  assert.deepEqual(run(bill({ date: '2026-09-07' })), ['noRate'], 'no daily rate for the day');
  assert.deepEqual(run(bill(), { code: () => undefined }), ['noCode'], 'the account takes no code of the tax');
  assert.deepEqual(run(bill(), { inputTax: false }), [], 'a firm without input tax books none, and asks nothing');
  assert.deepEqual(run(bill({ notPaidBy: ['M2026-003'] })), [], 'a bill the person took apart from a booking is hers');
  assert.deepEqual(run(bill({ extractedText: 'Plattform Beispiel\nAbonnement' })), [], 'another document of the business is paid as usual');
});

test('the person deletes the booking: the bill is taken apart from it and never booked again; the undo links it back', () => {
  const books = booksOf([bill()]);
  bookVatCorrections(books, [plattform()], ctx());
  const [entry] = books.journalEntries;
  const undo = applyChange(books, { kind: 'deleteEntry', id: entry.id })!;
  assert.deepEqual([books.mappings, books.receipts[0].notPaidBy], [[], [entry.transactionRef]]);
  assert.deepEqual(bookVatCorrections(books, [plattform()], ctx()).booked, [], 'not booked again over her');
  applyChange(books, undo);
  assert.deepEqual([books.mappings.map((m) => m.transactionRef), books.receipts[0].notPaidBy], [[entry.transactionRef], undefined]);
});

test('the code: the company\'s billVat at its rate, else the one the fee account takes for the tax itself', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const context = loadClassifyContext(ws);
  const fx = { daily: () => 0.94879 } as unknown as FxResolver;
  const codeOn = (file: string, b = bill()) => {
    const books = booksOf([b]);
    bookBillCorrections(books, { ...context, counterparties: [plattform(file)] }, fx);
    return books.journalEntries.map((e) => [e.vatCode, e.accountCredit, e.exchangeRate]);
  };
  assert.deepEqual(codeOn(FILE), [['M81-2', '6570', 0.94879]], 'the company\'s code');
  assert.deepEqual(codeOn(FILE.replace(', billVat: M81-2', '')), [['I81-2', '6570', 0.94879]], 'an operating expense account: I');
  assert.deepEqual(codeOn(FILE.replace('account: "6570", vat: I0, billVat: M81-2', 'account: "4210", vat: I0')), [['M81-2', '4210', 0.94879]], 'a cost of goods account: M');
  const reduced = bill({ vatSummary: [{ ratePercent: 2.6, net: 100, vat: 2.6, gross: 102.6 }] });
  assert.deepEqual(codeOn(FILE, reduced), [['I26-2', '6570', 0.94879]], 'billVat of another rate is not taken: the account decides');
});

test('provider.fees.billVat: the code of the tax itself, or a refusal that says so', () => {
  const fees = (billVat: unknown) => parseProvider({ fees: { account: '6580', vat: 'I0', billVat } });
  assert.deepEqual(fees('M81-2'), { provider: { reports: {}, fees: { account: '6580', vat: 'I0', billVat: 'M81-2' } } });
  assert.match(String((fees('M81') as { problem: string }).problem), /billVat must be the code of the tax itself/);
});

test('the app\'s Shopify file knows its monthly Payments Invoice as a bill of a VAT-only correction', () => {
  const shopify = compileCounterparty(parse(readFileSync(join(APP_ROOT, 'processes/suppliers/shopify.yaml'), 'utf8')), { vendor: 'processes/suppliers/shopify.yaml' }, 'supplier');
  const [doc] = shopify.documents.filter((d) => d.proves === 'vat-correction');
  assert.ok(doc.text.every((re) => re.test('Shopify Payments Invoice for July 2026\nTransaction Fees 100.00\nVAT (8.1%) 8.10')));
  assert.ok(!doc.text.every((re) => re.test('Bill #100000001\nApps (2 items)\nStandard - SWITZERLAND (8.1%)')), 'its app subscription bill is paid by card as usual');
});
