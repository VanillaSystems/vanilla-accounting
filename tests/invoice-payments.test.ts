/**
 * Paid invoices found by their reference on camt.053 import (ADR 0010, src/invoices/payments.ts):
 * the camt parser reads the structured reference, the payment is allocated and its revenue booked
 * from the invoice's lines, the invoice PDF becomes the entry's receipt; partial payments, closed
 * periods, cancelled invoices and payments without a reference are left for a person. A payment
 * naming an open invoice's number with its amount, and a refund naming a credit note, are booked
 * by rule too: the refund with the minus code, so the VAT return lowers the revenue and its tax.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { camt053Xml, type CamtEntry } from '../tools/demo/camt053.js';
import { confirmPayment, matchPayments, paymentProposals, releasePayment, PaymentError, type PaymentContext } from '../src/invoices/payments.js';
import { cancel, creditNoteDraft, issue, openAmount, openOn, paymentsNamingOpen, refundDue, status, totals } from '../src/invoices/rules.js';
import { vat } from '../src/engines/index.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { scorReference } from '../src/providers/qr-bill/reference.js';
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
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }, { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }],
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

test('r10c-3: «Lösen» undoes the link: the invoice is open again, the entries the link booked and the link to its PDF go, and the booking that stood before the link is back', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 963.72, undefined, 'Beispiel Bistro AG, Bern')]));
  const guess = { id: 'cl', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, vatCode: 'V81', origin: 'classify' as const };
  b.journalEntries.push({ ...guess });
  const linked = confirmPayment(b, book, inv.id, 'B1', ctx);
  assert.deepEqual(linked.replaced, [guess], 'the link says what it replaced, so that «Lösen» can put it back');
  assert.equal(b.mappings.length, 1);

  const released = releasePayment(b, book, inv.id, 'B1', ctx, linked.replaced);
  assert.deepEqual([released.allocation.transactionRef, released.allocation.by, released.removed.length, released.restored.map((e) => e.id)], ['B1', 'confirmed', 2, ['cl']]);
  assert.equal(status(book.invoices[0], book.invoices), 'issued', 'the invoice is open again');
  assert.deepEqual(b.journalEntries, [guess], 'the revenue booking is what stood before the link');
  assert.deepEqual(b.mappings, [], 'the link to the invoice PDF is gone');
  assert.deepEqual(paymentProposals(b, book).map((p) => p.transactionRef), ['B1'], 'the payment is offered again');
  assert.throws(() => releasePayment(b, book, inv.id, 'B1', ctx), PaymentError, 'nothing to release twice');

  // A payment a person booked by hand keeps her booking through link and release.
  const hand = { id: 'm', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, origin: 'manual' as const };
  b.journalEntries = [hand];
  confirmPayment(b, book, inv.id, 'B1', ctx);
  const kept = releasePayment(b, book, inv.id, 'B1', ctx);
  assert.deepEqual([kept.removed, kept.restored, b.journalEntries], [[], [], [hand]]);
});

test('a hand-booked payment is not replaced by a confirmation: linked, its booking stays as the revenue (r9c-3)', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', totals(inv.lines).gross)]));
  b.journalEntries.push({ id: 'm', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, origin: 'manual' });
  const out = confirmPayment(b, book, inv.id, 'B1', ctx);
  assert.equal(out.paid[0].booked, false);
  assert.deepEqual(b.journalEntries.map((e) => e.id), ['m']);
  assert.equal(status(book.invoices[0], book.invoices), 'paid');
});

const debit = (ref: string, date: string, amount: number, text: string, payee = 'Beispiel Bistro AG'): CamtEntry =>
  ({ ref, date, amount, direction: 'DBIT', text: 'Zahlung', details: [{ amount, counterparty: payee, reference: text, text: `Zahlung ${payee}` }] });

test('a payment without reference whose text names an open invoice and pays it: booked from the invoice, the classifier\'s V0 replaced', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 963.72, 'Garage Rechnung 2026-001', 'Hans Meier')]));
  b.journalEntries.push({ id: 'cl', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3300', amount: 963.72, vatCode: 'V0', origin: 'classify' });
  const out = matchPayments(b, book, ctx);
  assert.deepEqual(out.paid, [{ transactionRef: 'B1', number: '2026-001', amount: 963.72, fee: 0, booked: true }]);
  assert.equal((book.invoices[0] as Issued).payments[0].by, 'number');
  assert.deepEqual(b.journalEntries.map((e) => [e.accountCredit, e.vatCode, e.amount, e.origin]), [['3300', 'V26', 574.56, 'invoice'], ['3600', 'V81', 389.16, 'invoice']]);
  assert.equal(status(book.invoices[0], book.invoices), 'paid');
  matchPayments(b, book, ctx);
  assert.equal(b.journalEntries.length, 2, 'once');
});

test('a number in the text but another amount, a longer number, or a hand booking: not booked, a proposal or a question', () => {
  const a = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [a], sent: [] };
  const b = books(fromCamt([
    credit('B1', '2026-08-04', 500, 'Anzahlung Rechnung 2026-001', 'Hans Meier'),
    credit('B2', '2026-08-05', 963.72, 'Auftrag 2026-0012', 'Hans Meier'),
  ]));
  assert.deepEqual(matchPayments(b, book, ctx).paid, []);
  assert.deepEqual(b.journalEntries, []);
  assert.deepEqual(paymentProposals(b, book).map((p) => [p.transactionRef, p.numberMatches, p.payer]), [['B1', true, 'Hans Meier'], ['B2', false, 'Hans Meier']], 'the part payment naming it first; the payer, not the text');

  const c = books(fromCamt([credit('B3', '2026-08-04', 963.72, 'Rechnung 2026-001')]));
  c.journalEntries.push({ id: 'm', transactionRef: 'B3', date: '2026-08-04', accountDebit: '1021', accountCredit: '3000', amount: 963.72, origin: 'manual' });
  const out = matchPayments(c, book, ctx);
  assert.deepEqual(out.questions.map((q) => [q.transactionRef, q.problem]), [['B3', 'booked']]);
  assert.deepEqual(c.journalEntries.map((e) => e.id), ['m'], 'her booking stays');
});

function paidWithCredit() {
  const inv = invoice('in_k', [], { lines: [{ text: 'Malerarbeiten Wohnzimmer', quantity: 1, price: 2352.5, vatRate: 8.1 }] });
  const pay = { transactionRef: 'P1', date: '2026-08-04', amount: 2543.05, by: 'reference' as const };
  const paid: Issued = { ...inv, payments: [pay] };
  const draft = creditNoteDraft(paid, { amount: 200, reason: 'Kratzer im Parkett, Kulanz', settlement: 'refund' }, { id: 'cn_1', createdAt: '2026-08-10T09:00:00Z', origin: 'manual', deleted: false }, '2026-08-10');
  const cn: Issued = { ...issue(draft, { customer, sender, layout: DEFAULT_LAYOUT, invoices: [paid], now: '2026-08-10T10:00:00Z' }), pdf: { file: 'invoices/cn.pdf', sha256: 'x' } };
  return { paid, cn, book: { schema: 1, customers: [customer], invoices: [paid, cn], sent: [] } as InvoiceBook };
}

test('a credit note\'s refund naming its number: matched, booked with the minus code, and the VAT return lowers revenue and tax (no export)', () => {
  const { cn, book } = paidWithCredit();
  assert.equal(cn.number, '2026-002');
  assert.equal(refundDue(cn, book.invoices), 200);
  const b = books(fromCamt([debit('R1', '2026-08-20', 200, 'Gutschrift 2026-002 Kulanz Parkett', 'Peter Keller')]));
  const out = matchPayments(b, book, ctx);
  assert.deepEqual(out.paid, [{ transactionRef: 'R1', number: '2026-002', amount: 200, fee: 0, booked: true }]);
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.vatCode, e.amount, e.description]), [['3300', '1021', '-V81', 200, 'Gutschrift 2026-002 Beispiel Bistro AG']]);
  assert.equal(refundDue(book.invoices[1], book.invoices), 0, 'paid back');
  assert.equal(b.receipts[0].filename, '20260810-gutschrift-2026-002.pdf');

  const z = Object.fromEntries(vat().report(b.journalEntries, '2026-Q3', []).ziffern.map((x) => [x.number, x.amount]));
  assert.equal(z['220'] ?? 0, 0, 'not an export');
  assert.equal(z['200'], -200, 'the turnover goes down by the refund');
  assert.deepEqual([z['303'], z['399']], [-185.01, -14.99], 'at 8.1 %: 200 × 8.1/108.1 less output tax');
  assert.equal(vat().figures(b.journalEntries, '2026-Q3', []).payable, -14.99);
});

test('a refund to the customer without the number is proposed; confirmed, it is booked the same way', () => {
  const { cn, book } = paidWithCredit();
  const b = books(fromCamt([debit('R1', '2026-08-20', 200, 'Rückzahlung', 'Beispiel Bistro AG'), debit('R2', '2026-08-21', 200, 'Miete')  ]));
  b.transactions[1].counterparty = 'Vermieter AG';
  assert.deepEqual(matchPayments(b, book, ctx).paid, []);
  assert.deepEqual(paymentProposals(b, book).map((p) => [p.transactionRef, p.direction, p.number]), [['R1', 'DBIT', '2026-002']], 'not the rent');
  confirmPayment(b, book, cn.id, 'R1', ctx);
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.vatCode, e.amount]), [['3300', '-V81', 200]]);
  assert.throws(() => confirmPayment(b, book, cn.id, 'R2', ctx), PaymentError);
});

test('a payment before the invoice date, or booked by hand, whose text names the invoice is proposed; linked, the open amount drops and a hand booking stays (r9c-3)', () => {
  // EUR invoice of 16.10. for 4200; Wise pays EUR 3000 on 12.10. «Rechnung 2026-001 Teilzahlung», no reference.
  const inv = invoice('in_e', [], { date: '2026-10-16', currency: 'EUR', lines: [{ text: 'Beratung Oktober', quantity: 1, price: 4200, vatRate: 0 }], exemption: 'export' }, { account: '1023', iban: 'BE38967000000002', bank: 'Wise' });
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('W1', '2026-10-12', 3000, 'Rechnung 2026-001 Teilzahlung', 'Beispiel Bistro AG')], 'EUR'));
  assert.deepEqual(matchPayments(b, book, ctx).paid, [], 'a part payment is never booked by rule');
  const proposed = paymentProposals(b, book);
  assert.deepEqual(proposed.map((p) => [p.transactionRef, p.number, p.numberMatches, p.booked]), [['W1', '2026-001', true, false]], 'proposed although it came before the invoice: the text names it');

  // Booked by hand first (1023 / 3400 V0-E): still proposed, as booked.
  b.journalEntries.push({ id: 'm', transactionRef: 'W1', date: '2026-10-12', accountDebit: '1023', accountCredit: '3400', amount: 3000, vatCode: 'V0-E', exchangeCurrency: 'EUR', exchangeRate: 0.95661, origin: 'manual' });
  assert.deepEqual(paymentProposals(b, book).map((p) => [p.transactionRef, p.booked]), [['W1', true]]);
  const out = confirmPayment(b, book, inv.id, 'W1', { ...ctx, fx: { daily: () => 0.95661 } });
  assert.deepEqual(out.paid, [{ transactionRef: 'W1', number: '2026-001', amount: 3000, fee: 0, booked: false }], 'allocated, not booked again');
  assert.deepEqual(b.journalEntries.map((e) => e.id), ['m'], 'the hand booking is the revenue; it stays');
  const linked = book.invoices[0] as Issued;
  assert.deepEqual(linked.payments, [{ transactionRef: 'W1', date: '2026-10-12', amount: 3000, by: 'confirmed' }]);
  assert.equal(openAmount(linked, book.invoices), 1200, 'the open amount drops to what is still owed');
  assert.equal(openOn(linked, book.invoices, '2026-12-31'), 1200, 'the year end counts the rest only');
  assert.ok(b.mappings.some((m) => m.transactionRef === 'W1' && m.receiptId === 'r_invoice'), 'the invoice is the payment\'s receipt');
  assert.deepEqual(paymentProposals(b, book), [], 'nothing left to propose');
  assert.throws(() => confirmPayment(b, book, inv.id, 'W1', ctx), /schon zugeordnet/);
});

test('paymentsNamingOpen: the payments whose text names an open invoice they are not linked to, for the year end (r9c-3)', () => {
  const inv = invoice('in_a', []);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [inv], sent: [] };
  const b = books(fromCamt([credit('B1', '2026-08-04', 500, 'Anzahlung Rechnung 2026-001', 'Hans Meier'), credit('B2', '2026-08-05', 963.72, undefined, 'Beispiel Bistro AG')]));
  b.journalEntries.push({ id: 'm', transactionRef: 'B1', date: '2026-08-04', accountDebit: '1021', accountCredit: '3300', amount: 500, vatCode: 'V81', origin: 'manual' });
  assert.deepEqual(paymentsNamingOpen(b.transactions, book.invoices, '2026-12-31').map((p) => [p.transactionRef, p.number, p.amount]), [['B1', '2026-001', 500]], 'B2 fits by amount and name only: not named');
  assert.deepEqual(paymentsNamingOpen(b.transactions, book.invoices, '2026-08-03'), [], 'a payment after the day does not count');
  const linked = { ...inv, payments: [{ transactionRef: 'B1', date: '2026-08-04', amount: 500, by: 'confirmed' as const }] };
  assert.deepEqual(paymentsNamingOpen(b.transactions, [linked], '2026-12-31'), [], 'linked: nothing to say');
});
