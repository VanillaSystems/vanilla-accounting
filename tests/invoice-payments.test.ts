/**
 * Paid invoices found by their reference on camt.053 import (ADR 0010, src/invoices/payments.ts):
 * the camt parser reads the structured reference, the payment is allocated and its revenue booked
 * from the invoice's lines, the invoice PDF becomes the entry's receipt; partial payments, closed
 * periods, cancelled invoices and payments without a reference are left for a person.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCamt, transactionsOf } from '../src/parsers/camt053.js';
import { camt053Xml, type CamtEntry } from '../tools/demo/camt053.js';
import { confirmPayment, matchPayments, paymentProposals, PaymentError, type PaymentContext } from '../src/invoices/payments.js';
import { cancel, issue, status, totals } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { scorReference } from '../src/invoices/reference.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import './support/jurisdiction.js';

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const PDF = Buffer.from('%PDF-1.4 Rechnung');

function invoice(id: string, invoices: Issued[], over: Partial<Draft> = {}, to: typeof payTo | Omit<typeof payTo, 'qrIban'> = payTo): Issued {
  const d: Draft = {
    id, createdAt: '2026-07-06T09:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1',
    date: '2026-07-06', currency: 'CHF', language: 'de', comments: [],
    lines: [{ text: 'Hausmischung 1 kg', quantity: 20, unit: 'pcs', price: 28, vatRate: 2.6 }, { text: 'Schulung', quantity: 3, unit: 'h', price: 120, vatRate: 8.1, account: '3600' }],
    ...over,
  };
  return { ...issue(d, { customer, sender: { ...sender, payTo: to }, layout: DEFAULT_LAYOUT, invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `invoices/${id}.pdf`, sha256: 'x' } };
}

/** Bank transactions as the camt parser reads them from a statement holding `entries`. */
function fromCamt(entries: CamtEntry[], currency = 'CHF'): BankTransaction[] {
  const xml = camt053Xml({ id: 'S1', created: '2026-10-01T06:00:00', iban: 'CH6580808000000000001', currency, owner: 'Muster Kaffee GmbH', institution: 'Bank', from: '2026-07-01', to: '2026-09-30', opening: 0, closing: 0, entries });
  return readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: currency === 'CHF' ? 'Raiffeisen' : 'Wise', statements: currency === 'CHF' ? 'camt053' : 'wise' }));
}
const credit = (ref: string, date: string, amount: number, reference?: string, payer = 'BEISPIEL BISTRO AG'): CamtEntry =>
  ({ ref, date, amount, direction: 'CRDT', text: 'Gutschrift', details: [{ amount, counterparty: payer, ...(reference ? { reference } : {}), text: `Gutschrift ${payer}` }] });

const books = (transactions: BankTransaction[]): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } });
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank' }, { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR' }],
  revenueAccount: '3300', fx: { daily: (c, d) => (c === 'EUR' && d === '2026-09-02' ? 0.94 : undefined) },
  pdfOf: () => PDF, receiptId: () => 'r_invoice', indexedAt: (tx) => `${tx.date}T18:00:00Z`,
};
const sum = (xs: Array<{ amount: number }>) => Math.round(xs.reduce((s, x) => s + x.amount, 0) * 100) / 100;

test('camt: the structured QR reference of a payment is read', () => {
  const [tx] = fromCamt([credit('B1', '2026-08-04', 963.72, '000000000000000000020260010')]);
  assert.equal(tx.reference, '000000000000000000020260010');
});

test('a payment with the QR reference: invoice paid, revenue booked from its lines and VAT codes, the PDF its receipt; once', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 963.72, inv.reference)]));
  const out = matchPayments(b, book, ctx);
  assert.deepEqual(out.paid, [{ transactionRef: 'B1', number: '2026-001', amount: 963.72, fee: 0, booked: true }]);
  assert.equal(status(book.invoices[0], book.invoices), 'paid');
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.vatCode, e.amount, e.origin]), [
    ['1021', '3300', 'V26', 574.56, 'invoice'],
    ['1021', '3600', 'V81', 389.16, 'invoice'],
  ]);
  assert.equal(b.journalEntries[0].description, 'Rechnung 2026-001 Beispiel Bistro AG');
  assert.deepEqual(b.mappings, [{ transactionRef: 'B1', receiptId: 'r_invoice', by: 'rule', rule: 'invoice-reference' }]);
  assert.deepEqual([b.receipts[0].kind, b.receipts[0].amount, b.receipts[0].filename], ['sales-record', 963.72, '20260706-rechnung-2026-001.pdf']);
  assert.equal(out.files[0].pdf, PDF);

  const again = matchPayments(b, book, ctx);
  assert.equal(b.journalEntries.length, 2, 'not booked twice');
  assert.equal((book.invoices[0] as Issued).payments.length, 1, 'not allocated twice');
  assert.deepEqual([b.receipts.length, b.mappings.length, again.files.length], [1, 1, 0]);
});

test('a part payment leaves the rest open and books the same mix of rates', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 400, inv.reference)]));
  matchPayments(b, book, ctx);
  assert.equal(status(book.invoices[0], book.invoices), 'partly-paid');
  assert.equal(sum(b.journalEntries), 400);
  assert.deepEqual(b.journalEntries.map((e) => e.vatCode), ['V26', 'V81']);
});

test('a creditor reference (SCOR) in the remittance text, in EUR: booked at the ESTV rate of the payment day', () => {
  const inv = invoice('in_e', [], { currency: 'EUR', exemption: 'export', lines: [{ text: 'Export', quantity: 40, price: 19.5, vatRate: 0 }] }, { account: '1023', iban: 'BE29967000000164', bank: 'Wise' });
  assert.equal(inv.reference, scorReference('2026-001'));
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit("TRANSFER-1", "2026-09-02", 780, inv.reference.replace(/(.{4})/g, "$1 ").trim())], 'EUR'));
  matchPayments(b, book, ctx);
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.vatCode, e.amount, e.exchangeCurrency, e.exchangeRate]), [['1023', 'V0', 780, 'EUR', 0.94]]);
});

test('not booked by rule, but reported: a cancelled invoice, too much, a closed period', () => {
  const a = invoice('in_a', []);
  const c = cancel(invoice('in_c', [a]), { date: '2026-08-01', reason: 'Fehler' });
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [a, c], sent: [] };
  const b = books(fromCamt([
    credit('B0', '2026-06-20', 963.72, a.reference),
    credit('B1', '2026-08-04', 999, a.reference),
    credit('B2', '2026-08-05', 963.72, c.reference),
  ]));
  const out = matchPayments(b, book, ctx);
  assert.deepEqual(out.questions.map((q) => [q.transactionRef, q.problem]), [['B0', 'closed'], ['B1', 'surplus'], ['B2', 'cancelled']]);
  assert.deepEqual([b.journalEntries.length, (book.invoices[0] as Issued).payments.length], [0, 0]);
});

test('a payment without a reference is proposed (amount, customer, date), and booked only when a person confirms it', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 963.72, undefined, 'Beispiel Bistro AG, Bern'), credit('B2', '2026-07-01', 963.72)]));
  b.journalEntries.push({ id: 'cl', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, vatCode: 'V81', origin: 'classify' });
  assert.deepEqual(matchPayments(b, book, ctx).paid, []);
  const proposals = paymentProposals(b, book);
  assert.deepEqual(proposals.map((p) => [p.transactionRef, p.number, p.nameMatches]), [['B1', '2026-001', true]], 'B2 is older than the invoice');

  const out = confirmPayment(b, book, inv.id, 'B1', ctx);
  assert.equal(out.paid[0].booked, true);
  assert.deepEqual(b.journalEntries.map((e) => [e.id === 'cl', e.vatCode]), [[false, 'V26'], [false, 'V81']], "the classifier's entry is replaced");
  assert.equal((book.invoices[0] as Issued).payments[0].by, 'confirmed');
  assert.deepEqual(paymentProposals(b, book), []);
  assert.throws(() => confirmPayment(b, book, inv.id, 'B1', ctx), PaymentError);
});

test('a hand-booked payment is not replaced by a confirmation', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', totals(inv.lines).gross)]));
  b.journalEntries.push({ id: 'm', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, origin: 'manual' });
  assert.throws(() => confirmPayment(b, book, inv.id, 'B1', ctx), /von Hand gebucht/);
});
