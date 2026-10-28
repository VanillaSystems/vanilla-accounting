/**
 * «Ist das dieselbe Zahlung?» answered yes on a movement read from a PDF that paid an invoice (#254),
 * with invented data, on the cash and the agreed basis: the invoice's payment goes with the bank's
 * movement, so the invoice is paid once by a movement the books hold and its revenue is declared once.
 * - The same amount: the allocation and its entries move to the bank's ref and day.
 * - Another amount (a fee, a rounding): the allocation is released and the invoice is matched to the
 *   bank's movement afresh, never left paid by a vanished ref while the run books the bank's again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents } from '../src/invoices/events.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Customer, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { sameAs } from '../src/server/twin-answer.js';
import { twinsOf } from '../src/books/twins.js';
import { periodLock, type Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }],
  revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};

/** One invoice of 1000 net at 8.1 % (1081), paid by the read movement `P` before the bank's file came with `B` for `bankAmount`. */
function paidByRead(setup: VatSetup, bankAmount: number) {
  setJurisdiction(ch, setup);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [], sent: [] };
  const inv = { ...issue({ id: 'i1', createdAt: '2026-10-01T08:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-01', currency: 'CHF', language: 'de', comments: [], lines: [{ text: 'Beratung', quantity: 1, unit: 'flat', price: 1000, vatRate: 8.1 }] }, { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-01T10:00:00Z' }), pdf: { file: 'invoices/i1.pdf', sha256: 'i1' } } as Issued;
  book.invoices.push(inv);
  const tx = (ref: string, date: string, amount: number, o: Partial<BankTransaction> = {}): BankTransaction =>
    ({ ref, bank: 'Raiffeisen', currency: 'CHF', date, amount, direction: 'CRDT', description: 'Gutschrift Beispiel Bistro AG', counterparty: 'Beispiel Bistro AG', reference: inv.reference, ...o });
  const books: Books = { receipts: [{ id: 'r_2026-001', filename: 'RE-2026-001.pdf', indexedAt: '2026-10-01T18:00:00Z' } as Books['receipts'][number]], transactions: [tx('P', '2026-10-10', 1081, { source: 'manual' })], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' } };
  bookInvoiceEvents(books, book, ctx);
  matchPayments(books, book, ctx);
  assert.deepEqual(book.invoices[0].status === 'issued' && book.invoices[0].payments.map((p) => p.transactionRef), ['P'], 'the read movement paid the invoice');
  // The bank's file came: the read movement is a question, the bank's movement held.
  books.transactions[0].unmatched = { since: '2026-10-28', by: 'Raiffeisen/bank.xml' };
  books.transactions.push(tx('B', '2026-10-12', bankAmount));
  const option = twinsOf(books.transactions, new Set(books.journalEntries.map((e) => e.transactionRef)), periodLock(books).isClosed, new Set()).questions.get('P')![0];
  assert.deepEqual(option, { pdf: ['P'], bank: ['B'] });
  return { book, books, option };
}

const sale = (books: Books) => books.journalEntries.filter((e) => e.vatCode === 'V81').map((e) => [e.transactionRef, e.date, e.amount]);
const refs = (books: Books) => new Set(books.transactions.map((t) => t.ref));
const allocations = (book: InvoiceBook) => book.invoices.flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => [p.transactionRef, p.date, p.amount]) : []));

for (const [basis, setup] of [['cash', EFFECTIVE_QUARTERLY], ['agreed', AGREED]] as const) {
  test(`${basis} basis: «Ja, dieselbe» for the same amount moves the invoice's payment and its entries to the bank's movement and day`, () => {
    const { book, books, option } = paidByRead(setup, 1081);
    const sold = sale(books);
    assert.equal(sold.length, 1, 'one sale booked before the answer');
    sameAs(books, option, () => undefined, { book, ctx });
    assert.deepEqual(allocations(book), [['B', '2026-10-12', 1081]], 'the invoice is paid by the bank\'s movement');
    assert.ok(books.journalEntries.every((e) => refs(books).has(e.transactionRef) || /^RE-/.test(e.transactionRef)), 'no entry on a vanished ref');
    assert.deepEqual(sale(books).map(([, , amount]) => amount), sold.map(([, , amount]) => amount), 'the revenue is declared once, as before');
    assert.deepEqual(matchPayments(books, book, ctx).paid, [], 'the next match books nothing again');
  });

  test(`${basis} basis: «Ja, dieselbe» for another amount releases the read movement's payment and matches the invoice to the bank's movement`, () => {
    const { book, books, option } = paidByRead(setup, 1080.5);
    sameAs(books, option, () => undefined, { book, ctx });
    assert.deepEqual(allocations(book).map(([ref, date]) => [ref, date]), [['B', '2026-10-12']], 'paid by the bank\'s movement, not by the vanished read one');
    assert.ok(books.journalEntries.every((e) => refs(books).has(e.transactionRef) || /^RE-/.test(e.transactionRef)), 'no entry on a vanished ref');
    assert.ok(books.journalEntries.some((e) => e.transactionRef === 'B'), 'the bank\'s movement is booked as the invoice\'s payment');
    const v81 = sale(books);
    assert.equal(v81.length, 1, `the revenue is declared once (${JSON.stringify(v81)})`);
    assert.equal(v81[0][0], basis === 'agreed' ? 'RE-2026-001' : 'B', basis === 'agreed' ? 'on the agreed basis by the invoice\'s event; the payment only settles' : 'on the cash basis by the payment');
    assert.deepEqual(matchPayments(books, book, ctx).paid, [], 'the next match books nothing again');
  });
}
