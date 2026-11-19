/**
 * Offene Posten on the agreed basis (docs/specs/invoicing.md 4.4.12, P1.10): an issued invoice is on the
 * receivable from its event, its payments and credit notes take it off, so on 31.12. the list equals
 * what the app's invoices hold on the receivable account in the books, invoice by invoice. (On the cash
 * basis the year end proposes the same amounts instead: tests/invoices-area.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents, eventRef } from '../src/invoices/events.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { creditNoteDraft, issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';
import { openItemGroups, openItems } from '../src/invoices/lists.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { chfAmount } from '../src/accounting/ledger.js';

const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const envelope = (id: string) => ({ id, createdAt: '2026-07-01T08:00:00Z', origin: 'manual' as const, deleted: false });
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }],
  revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};
const draft = (id: string, date: string, net: number): Draft => ({
  ...envelope(id), status: 'draft', kind: 'invoice', customerId: 'cu_1', date, currency: 'CHF', language: 'de', comments: [],
  lines: [{ text: 'Beratung', quantity: 1, unit: 'flat', price: net, vatRate: 8.1 }],
});
function issued(book: InvoiceBook, d: Draft): Issued {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
}
const tx = (ref: string, date: string, amount: number, reference: string): BankTransaction => ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: ref, reference });
/** What the entries of `refs` hold on 1100 up to `date`. */
const onReceivable = (entries: JournalEntry[], refs: readonly string[], date: string) =>
  Math.round(entries.filter((e) => refs.includes(e.transactionRef ?? '') && e.date <= date).reduce((s, e) => s + (e.accountDebit === '1100' ? chfAmount(e) : 0) - (e.accountCredit === '1100' ? chfAmount(e) : 0), 0) * 100) / 100;

test('agreed basis: Offene Posten on 31.12. equals what each app invoice holds on the receivable, its event less its payments and credit notes up to that day', () => {
  setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction, AGREED);
  const book: InvoiceBook = { schema: 2, contacts: [asContact(customer)], invoices: [], articles: [], sent: [] };
  const a = issued(book, draft('a', '2026-11-02', 1000)); // 1081, unpaid
  const b = issued(book, draft('b', '2026-11-20', 2000)); // 2162: 1000 paid in December, the rest in January
  const c = issued(book, draft('c', '2026-12-01', 500)); // 540.50, a credit note of 108.10 in December
  const paidAll = issued(book, draft('d', '2026-10-01', 100)); // 108.10, paid in November
  const cn = issued(book, { ...creditNoteDraft(c, { amount: 108.1, reason: 'Kulanz', settlement: 'refund' }, envelope('n'), '2026-12-10'), sender } as Draft);
  const books: Books = {
    receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
    transactions: [tx('p-d', '2026-11-15', 108.1, paidAll.reference), tx('p-b1', '2026-12-15', 1000, b.reference), tx('p-b2', '2027-01-10', 1162, b.reference)],
  };
  bookInvoiceEvents(books, book, ctx);
  matchPayments(books, book, ctx);
  assert.deepEqual(book.invoices.filter((i): i is Issued => i.status === 'issued').map((i) => [i.number, i.payments.map((p) => p.amount)]),
    [[a.number, []], [b.number, [1000, 1162]], [c.number, []], [paidAll.number, [108.1]], [cn.number, []]], 'the payments are allocated as the bank shows them');

  const end = '2026-12-31';
  const items = openItems(book.invoices, end);
  assert.deepEqual(items.map((x) => [x.inv.number, x.open]), [[a.number, 1081], [b.number, 1162], [c.number, 432.4]]);
  const refsOf = (inv: Issued) => {
    const now = book.invoices.find((i): i is Issued => i.id === inv.id && i.status === 'issued')!;
    const credits = book.invoices.filter((i): i is Issued => i.status === 'issued' && i.creditFor === inv.id);
    return [eventRef(inv, 'issue'), ...now.payments.map((p) => p.transactionRef), ...credits.map((x) => eventRef(x, 'issue'))];
  };
  for (const x of items) assert.equal(onReceivable(books.journalEntries, refsOf(x.inv), end), x.open, `${x.inv.number}: the list is the receivable`);
  assert.equal(onReceivable(books.journalEntries, refsOf(paidAll), end), 0, 'a paid invoice is neither on the list nor on the receivable');
  const all = book.invoices.filter((i): i is Issued => i.status === 'issued').flatMap(refsOf);
  assert.equal(openItemGroups(items).totals[0].total, onReceivable(books.journalEntries, all, end), 'and in total, to the cent');
  assert.equal(onReceivable(books.journalEntries, refsOf(b), '2027-01-31'), 0, 'paid in January: off the receivable then, still open on 31.12.');
});
