/**
 * How each event of invoicing phase 1 is booked (docs/specs/invoicing.md 4.5), on the cash and the
 * agreed basis, effective, net tax rate and not registered: a Rechnung, its payment by the statement
 * and by hand, one payment over several Rechnungen (Ausziffern), the write-offs (Skonto, Rabatt,
 * Spesen, Rundung, Verlust), a Gutschrift applied to its Rechnung (Verrechnung), a Storno of a paid
 * Rechnung, and a Rechnung of a filed period corrected in the open one. Then the checkpoints P1.4 to
 * P1.8 and P1.12 of spec 5, and the four figures on every Rechnung of the demos. Every figure is
 * worked out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents } from '../src/invoices/events.js';
import {
  allocatePayment, allocationProposal, matchPayments, recordHandPayment, releasePayment, removeHandPayment, removeWriteOff, writeOffRest, PaymentError, type PaymentContext,
} from '../src/invoices/payments.js';
import { creditNoteStatus } from '../src/invoices/lists.js';
import { cancel, figures, issue, openAmount, skontoOf, status, totals, InvoiceRuleError } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Draft, type InvoiceBook, type Invoice, type Issued, type PaymentTerms } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';
import { matchStatementRows, mergeIndex } from '../src/books/bank-import.js';
import { chfAmount } from '../src/accounting/ledger.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const NET_CASH: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
const NET_AGREED: VatSetup = { ...NET_CASH, reporting: 'agreed' };
const KINDS: Array<[string, VatSetup, { agreed: boolean; code?: string; rate: number }]> = [
  ['cash, effective', EFFECTIVE_QUARTERLY, { agreed: false, code: 'V81', rate: 8.1 }],
  ['cash, net tax rate', NET_CASH, { agreed: false, code: 'F1', rate: 8.1 }],
  // A firm not registered has no basis to choose: it books no VAT event and no code either way.
  ['not registered', NOT_REGISTERED, { agreed: false, rate: 0 }],
  ['agreed, effective', AGREED, { agreed: true, code: 'V81', rate: 8.1 }],
  ['agreed, net tax rate', NET_AGREED, { agreed: true, code: 'F1', rate: 8.1 }],
];

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const SKONTO: PaymentTerms = { id: 'sk2', name: '10 Tage 2 %, 30 Tage netto', days: 30, skonto: { percent: 2, days: 10 } };

const ctx: PaymentContext = {
  bankAccounts: [
    { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' },
    { bank: 'Kasse', currency: 'CHF', account: '1000', label: 'Kasse', role: 'cash' },
    { bank: 'manual', currency: 'CHF', account: '2451', label: 'Inhaberin', role: 'owner' },
  ],
  revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};

const newBook = (): InvoiceBook => ({ schema: 3, contacts: [asContact(customer)], invoices: [], articles: [], sent: [] });
const books = (transactions: BankTransaction[] = [], closedThrough = '2026-06-30'): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough } });
const draft = (id: string, date: string, lines: Draft['lines'], over: Partial<Draft> = {}): Draft => ({
  id, createdAt: `${date}T08:00:00Z`, origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1',
  date, currency: 'CHF', language: 'de', comments: [], lines, ...over,
});
/** An issued document numbered after the book's, added to it. */
function issued(book: InvoiceBook, d: Draft, terms?: PaymentTerms[]): Issued {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z`, ...(terms ? { paymentTerms: terms } : {}) }), pdf: { file: `invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
}
const line = (net: number, rate: number, over: Record<string, unknown> = {}) => ({ text: 'Beratung', quantity: 1, unit: 'flat', price: net, vatRate: rate, ...over });
const paying = (ref: string, date: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: `Gutschrift ${ref}`, counterparty: 'BEISPIEL BISTRO AG', ...over });
const now = (book: InvoiceBook, id: string) => book.invoices.find((i) => i.id === id) as Issued;
const rows = (b: Books, ref: string) => b.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.accountCredit, e.vatCode, e.amount]);
const sum = (es: JournalEntry[]) => Math.round(es.reduce((s, e) => s + e.amount, 0) * 100) / 100;
const balance = (entries: JournalEntry[], account: string) => Math.round(entries.reduce((s, e) => s + (e.accountDebit === account ? chfAmount(e) : 0) - (e.accountCredit === account ? chfAmount(e) : 0), 0) * 100) / 100;
const minus = (code?: string) => (code ? `-${code}` : undefined);

for (const [name, setup, k] of KINDS) {
  test(`4.5 on the ${name} basis: issue, statement payment, write-offs (Spesen, Verlust), their undo and a Storno`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, k.rate)]));
    const g = totals(a).gross;
    const b = books([paying('P1', '2026-08-04', 500, { reference: a.reference })]);

    bookInvoiceEvents(b, book, ctx);
    assert.deepEqual(rows(b, 'RE-2026-001'), k.agreed ? [['1100', '3200', k.code, g]] : [], 'issued: the event on the agreed basis only');

    matchPayments(b, book, ctx);
    assert.deepEqual(rows(b, 'P1'), [k.agreed ? ['1021', '1100', undefined, 500] : ['1021', '3200', k.code, 500]], 'the payment: revenue on the cash basis, the receivable on the agreed');
    assert.equal(status(now(book, 'a'), book.invoices), 'partly-paid');

    // Rest ausbuchen as Spesen: nothing on the cash basis (decision 3), RE-…-wo-1 on the agreed with the minus code.
    const { writeOff } = writeOffRest(b, book, 'a', { date: '2026-08-10', amount: g - 500, reason: 'fee', by: 'person' }, ctx, { files: [] });
    assert.equal(writeOff.id, 'wo-1');
    assert.deepEqual(rows(b, 'RE-2026-001-wo-1'), k.agreed ? [['3800', '1100', minus(k.code), g - 500]] : []);
    assert.equal(status(now(book, 'a'), book.invoices), 'paid');
    const f = figures(now(book, 'a'), book.invoices);
    assert.deepEqual([f.amount, f.received, f.credited, f.writtenOff, f.open], [g, 500, 0, g - 500, 0], 'the Spesen are written off, not credited');
    if (k.agreed) assert.equal(balance(b.journalEntries, '1100'), 0, 'the receivable is settled by the payment and the write-off');

    // A loss of a whole Rechnung, taken back («Rückgängig»), then a Storno.
    const c = issued(book, draft('c', '2026-07-20', [line(200, k.rate)]));
    const gc = totals(c).gross;
    bookInvoiceEvents(b, book, ctx);
    writeOffRest(b, book, 'c', { date: '2026-09-01', amount: gc, reason: 'loss', by: 'person' }, ctx, { files: [] });
    assert.deepEqual(rows(b, 'RE-2026-002-wo-1'), k.agreed ? [['3805', '1100', minus(k.code), gc]] : []);
    assert.equal(status(now(book, 'c'), book.invoices), 'paid');
    removeWriteOff(b, book, 'c', 'wo-1');
    assert.deepEqual([rows(b, 'RE-2026-002-wo-1'), status(now(book, 'c'), book.invoices)], [[], 'issued']);
    // A loss of a part and then the Storno: on the agreed basis the Storno reverses the event and the write-off, so 1100 nets to zero.
    writeOffRest(b, book, 'c', { date: '2026-09-01', amount: 50, reason: 'loss', by: 'person' }, ctx, { files: [] });
    book.invoices[book.invoices.findIndex((i) => i.id === 'c')] = cancel(now(book, 'c'), { date: '2026-09-15', reason: 'Fehler' });
    bookInvoiceEvents(b, book, ctx);
    if (k.agreed) {
      assert.deepEqual(rows(b, 'RE-2026-002-storno'), [['3200', '1100', minus(k.code), gc], ['1100', '3805', k.code, 50]], 'the Storno reverses the event and the write-off, codes and all');
      assert.equal(balance(b.journalEntries, '1100'), 0);
    } else assert.deepEqual(rows(b, 'RE-2026-002-storno'), []);
  });

  test(`4.5 on the ${name} basis: a Gutschrift applied to its Rechnung (Verrechnung), then the payment of the rest`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, k.rate)]));
    const cn = issued(book, draft('cn', '2026-07-15', [line(-200, k.rate, { text: 'Rabatt' })], { kind: 'credit-note', creditFor: 'a' }));
    const g = totals(a).gross, gcn = -totals(cn).gross;
    assert.equal(creditNoteStatus(cn, book.invoices), 'settled', 'applied to its Rechnung at once: Abgerechnet');
    assert.equal(openAmount(now(book, 'a'), book.invoices), Math.round((g - gcn) * 100) / 100);
    const b = books([paying('P1', '2026-08-04', Math.round((g - gcn) * 100) / 100, { reference: a.reference })]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    if (k.agreed) {
      assert.deepEqual(rows(b, 'GS-2026-002'), [['3200', '1100', minus(k.code), gcn]], 'the Gutschrift is an event of its own');
      assert.deepEqual(rows(b, 'P1'), [['1021', '1100', undefined, g - gcn]], 'no entry for the Verrechnung: both on 1100');
      assert.equal(balance(b.journalEntries, '1100'), 0);
    } else {
      // The payment books the Rechnung's revenue with the sale code and the Gutschrift's with the minus code: 1081 − 216.20 = 864.80.
      assert.deepEqual(rows(b, 'P1'), [['1021', '3200', k.code, g], ['3200', '1021', minus(k.code), gcn]]);
    }
    assert.equal(status(now(book, 'a'), book.invoices), 'paid');
  });

  test(`4.5 on the ${name} basis: a Zahlungseingang by hand, then the statement row that carries it: one booking`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, k.rate)]));
    const g = totals(a).gross;
    const b = books();
    bookInvoiceEvents(b, book, ctx);
    const { transaction } = recordHandPayment(b, book, 'a', { date: '2026-08-05', account: '1021', amount: g }, ctx);
    assert.deepEqual([transaction.source, transaction.bank, transaction.direction], ['manual', 'Raiffeisen', 'CRDT']);
    assert.deepEqual(now(book, 'a').payments.map((p) => [p.source, p.amount]), [['hand', g]]);
    const booked = rows(b, transaction.ref);
    assert.deepEqual(booked, [k.agreed ? ['1021', '1100', undefined, g] : ['1021', '3200', k.code, g]]);

    // The statement comes: its row confirms the hand movement and is no new one; matching books nothing again.
    const row = paying('STMT-1', '2026-08-06', g, { reference: a.reference });
    const { index } = mergeIndex(b, { receipts: b.receipts, bankTransactions: [row], reads: [], bankStatements: [], camtBalances: [] });
    assert.equal(index.transactions.find((t) => t.ref === transaction.ref)?.statement, 'STMT-1', 'the hand movement names the row that confirms it');
    assert.equal(index.transactions.some((t) => t.ref === 'STMT-1'), false);
    const after = { ...b, ...index } as Books;
    matchPayments(after, book, ctx);
    assert.deepEqual(rows(after, transaction.ref), booked, 'one booking');
    assert.equal(now(book, 'a').payments.length, 1);
    assert.throws(() => removeHandPayment(after, book, 'a', transaction.ref, ctx), PaymentError, 'confirmed by a statement: released, not removed');
  });
}

test('a write-off of a Rechnung of a filed period is dated in the open one; the filed event stays, a filed date is refused', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  issued(book, draft('a', '2026-05-10', [line(1000, 8.1)]));
  const b = books([], '2026-03-31');
  bookInvoiceEvents(b, book, ctx);
  b.config.closedThrough = '2026-06-30';
  const filed = JSON.stringify(b.journalEntries);
  assert.throws(() => writeOffRest(b, book, 'a', { date: '2026-06-20', amount: 81, reason: 'discount', by: 'person' }, ctx, { files: [] }), PaymentError);
  writeOffRest(b, book, 'a', { date: '2026-07-15', amount: 108.1, reason: 'discount', by: 'person' }, ctx, { files: [] });
  assert.equal(JSON.stringify(b.journalEntries.filter((e) => e.transactionRef === 'RE-2026-001')), filed, 'the filed event is as filed');
  const wo = b.journalEntries.filter((e) => e.transactionRef === 'RE-2026-001-wo-1');
  assert.deepEqual(wo.map((e) => [e.date, e.accountDebit, e.vatCode, e.amount, e.corrects]), [['2026-07-15', '3800', '-V81', 108.1, undefined]], 'the tax goes down when the correction is booked (MWSTG Art. 41)');
  // A Gutschrift of the same Rechnung, dated open: its event on its own date.
  issued(book, draft('cn', '2026-07-20', [line(-100, 8.1)], { kind: 'credit-note', creditFor: 'a' }));
  bookInvoiceEvents(b, book, ctx);
  assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'GS-2026-002').map((e) => [e.date, e.vatCode, e.amount]), [['2026-07-20', '-V81', 108.1]]);
});

test('P1.4: a payment 2 % short within the Skonto days: Bezahlt, the Skonto written off by code; agreed: −V81 on 3800 of 2 % of the gross', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, AGREED]) {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
    assert.deepEqual(a.terms, { id: 'sk2', name: SKONTO.name, days: 30, skonto: { percent: 2, days: 10 }, text: SKONTO.name }, 'the terms frozen as printed');
    assert.equal(a.dueDate, '2026-08-09');
    // 2 % of 1081.00 is 21.62: the customer pays 1059.38 on day 6; another one rounds to 1059.40.
    const late = issued(book, draft('late', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
    const rounded = issued(book, draft('rounded', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
    const b = books([
      paying('P1', '2026-07-16', 1059.38, { reference: a.reference }),
      paying('P2', '2026-07-21', 1059.38, { reference: late.reference }),
      // By the number in the text, no reference: found as well.
      paying('P3', '2026-07-20', 1059.40, { description: `Rechnung ${rounded.number}` }),
    ]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    assert.deepEqual([status(now(book, 'a'), book.invoices), now(book, 'a').writeOffs?.map((w) => [w.reason, w.by, w.amount, w.transactionRef])], ['paid', [['skonto', 'code', 21.62, 'P1']]]);
    assert.deepEqual([status(now(book, 'rounded'), book.invoices), now(book, 'rounded').writeOffs?.map((w) => w.amount)], ['paid', [21.6]], 'within 5 Rappen of the Skonto');
    assert.deepEqual([status(now(book, 'late'), book.invoices), now(book, 'late').writeOffs ?? []], ['partly-paid', []], 'day 11: past the Skonto days, the rest stays open');
    const wo = rows(b, 'RE-2026-001-wo-1');
    assert.deepEqual(wo, setup === AGREED ? [['3800', '1100', '-V81', 21.62]] : [], 'agreed: 2 % of the gross on 3800 with −V81');
  }
});

test('Skonto: not taken beyond 5 Rappen off, before the invoice date, or after a first payment', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
  assert.equal(skontoOf(a, book.invoices, 1059.38, '2026-07-20'), 21.62, 'the last Skonto day');
  assert.equal(skontoOf(a, book.invoices, 1059.32, '2026-07-12'), undefined, '6 Rappen off');
  assert.equal(skontoOf(a, book.invoices, 1059.38, '2026-07-09'), undefined, 'before the invoice');
  assert.equal(skontoOf({ ...a, payments: [{ transactionRef: 'x', date: '2026-07-11', amount: 100, by: 'reference' }] }, book.invoices, 959.38, '2026-07-12'), undefined, 'a second payment');
  const net = issued(book, draft('n', '2026-07-10', [line(1000, 8.1)]), [SKONTO]);
  assert.equal(skontoOf(net, book.invoices, 1059.38, '2026-07-12'), undefined, 'net terms offer none');
});

test('P1.5: one payment of 3 180 for 1 620 and 1 580, 20 short: proposed over both, the rest of the second as Spesen; agreed: one -wo- entry', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, AGREED]) {
    setJurisdiction(ch, setup);
    const book = newBook();
    const gross = (n: number) => [{ text: 'Malerarbeiten', quantity: 1, unit: 'flat', price: n, vatRate: 8.1 }];
    issued(book, draft('a', '2026-07-01', gross(1620), { prices: 'gross' }));
    issued(book, draft('b', '2026-07-03', gross(1580), { prices: 'gross' }));
    const b = books([paying('P1', '2026-08-04', 3180, { description: 'Rechnungen 2026-001 und 2026-002' })]);
    bookInvoiceEvents(b, book, ctx);
    const proposal = allocationProposal(b, book, 'P1');
    assert.deepEqual(proposal.items.map((i) => [i.number, i.open, i.proposed]), [['2026-001', 1620, 1620], ['2026-002', 1580, 1560]]);
    assert.equal(proposal.left, 0);
    allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1620 }, { invoiceId: 'b', amount: 1560, rest: 'fee' }], ctx);
    assert.deepEqual([status(now(book, 'a'), book.invoices), status(now(book, 'b'), book.invoices)], ['paid', 'paid']);
    assert.equal(sum(b.journalEntries.filter((e) => e.transactionRef === 'P1')), 3180);
    const wo = b.journalEntries.filter((e) => /-wo-/.test(e.transactionRef));
    assert.deepEqual(wo.map((e) => [e.transactionRef, e.accountDebit, e.vatCode, e.amount]), setup === AGREED ? [['RE-2026-002-wo-1', '3800', '-V81', 20]] : []);
    assert.deepEqual(b.mappings.filter((m) => m.transactionRef === 'P1').map((m) => m.receiptId), ['r_2026-001', 'r_2026-002'], 'each invoice PDF is a receipt of the payment');
  }
});

test('Ausziffern refuses a surplus (it stays unallocated in phase 1), more than a Rechnung has open, and a payment allocated already', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-01', [line(1000, 8.1)]));
  const b = books([paying('P1', '2026-08-04', 1100)]);
  assert.throws(() => allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1081 }], ctx), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'surplus');
  assert.throws(() => allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1100 }], ctx), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'surplus');
  assert.deepEqual([b.journalEntries.length, now(book, 'a').payments.length], [0, 0], 'nothing booked');
  b.transactions[0].amount = 1000;
  allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1000 }], ctx);
  assert.equal(status(now(book, 'a'), book.invoices), 'partly-paid', 'the rest stays open');
  assert.throws(() => allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1000 }], ctx), PaymentError);
});

test('P1.6: a customer bankrupt, Rest ausbuchen as Verlust: cash no entry; agreed 3805 / 1100 with the minus code, the open quarter\'s return shows the reduction', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const cashBook = newBook();
  issued(cashBook, draft('a', '2026-07-10', [line(1000, 8.1)]));
  const cash = books();
  writeOffRest(cash, cashBook, 'a', { date: '2026-09-20', amount: 1081, reason: 'loss', by: 'person' }, ctx, { files: [] });
  assert.deepEqual([cash.journalEntries.length, status(now(cashBook, 'a'), cashBook.invoices)], [0, 'paid']);

  setJurisdiction(ch, AGREED);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
  const b = books();
  bookInvoiceEvents(b, book, ctx);
  const before = vat().figures(b.journalEntries, '2026-Q3', []).payable;
  assert.equal(before, 81);
  writeOffRest(b, book, 'a', { date: '2026-09-20', amount: 1081, reason: 'loss', by: 'person' }, ctx, { files: [] });
  assert.deepEqual(rows(b, 'RE-2026-001-wo-1'), [['3805', '1100', '-V81', 1081]]);
  assert.equal(vat().figures(b.journalEntries, '2026-Q3', []).payable, 0, 'the VAT on the loss comes off in the quarter it is written off');
  assert.equal(balance(b.journalEntries, '1100'), 0);
});

test('more than is open is a warning («Trotzdem ausbuchen»), never a silent credit', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(100, 8.1)]));
  const b = books();
  assert.throws(() => writeOffRest(b, book, 'a', { date: '2026-08-01', amount: 200, reason: 'rounding', by: 'person' }, ctx, { files: [] }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'aboveOpen');
  writeOffRest(b, book, 'a', { date: '2026-08-01', amount: 200, reason: 'rounding', by: 'person' }, ctx, { files: [] }, true);
  const f = figures(now(book, 'a'), book.invoices);
  assert.deepEqual([f.amount, f.credited, f.writtenOff, f.open], [108.1, 0, 200, -91.9], 'the figures show the credit; Betrag − erhalten − gutgeschrieben − ausgebucht = offen');
  assert.equal(openAmount(now(book, 'a'), book.invoices), 0);
});

test('P1.7: cash at the door on the cash box, Bezahlt, no statement ever; its undo takes the movement, bookings and allocation', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
  const b = books();
  const { transaction } = recordHandPayment(b, book, 'a', { date: '2026-07-12', account: '1000', amount: 1081 }, ctx);
  assert.deepEqual(rows(b, transaction.ref), [['1000', '3200', 'V81', 1081]]);
  assert.equal(status(now(book, 'a'), book.invoices), 'paid');
  assert.throws(() => recordHandPayment(b, book, 'a', { date: '2026-07-12', account: '2451', amount: 1 }, ctx), PaymentError, 'the owner\'s account is no bank or cash box');
  assert.throws(() => recordHandPayment(b, book, 'a', { date: '2026-07-12', account: '1000', amount: 1 }, ctx), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'surplus');
  removeHandPayment(b, book, 'a', transaction.ref, ctx);
  assert.deepEqual([b.transactions.length, b.journalEntries.length, b.mappings.length, now(book, 'a').payments.length, status(now(book, 'a'), book.invoices)], [0, 0, 0, 0, 'issued']);
});

test('P1.8: a Gutschrift of 2 of 10 m² on a Rechnung of two rates: applied at once, Abgerechnet; on the cash basis the payments book revenue less the Gutschrift with the minus code, per rate, to the Rappen', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-01', [
    { text: 'Wand streichen', quantity: 10, unit: 'm2', price: 50, vatRate: 8.1 },
    { text: 'Hausmischung', quantity: 20, unit: 'pcs', price: 25, vatRate: 2.6 },
  ]));
  const cn = issued(book, draft('cn', '2026-07-10', [{ text: 'Wand streichen', quantity: 2, unit: 'm2', price: -50, vatRate: 8.1 }], { kind: 'credit-note', creditFor: 'a' }));
  // 540.50 + 513.00 = 1053.50, less the Gutschrift 108.10: 945.40 open.
  assert.equal(creditNoteStatus(cn, book.invoices), 'settled');
  const f = figures(now(book, 'a'), book.invoices);
  assert.deepEqual([f.amount, f.received, f.credited, f.open, f.creditNotes.map((c) => c.number)], [1053.5, 0, 108.1, 945.4, ['2026-002']]);
  const b = books([paying('P1', '2026-07-20', 500), paying('P2', '2026-08-20', 445.4)]);
  allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 500 }], ctx);
  allocatePayment(b, book, 'P2', [{ invoiceId: 'a', amount: 445.4 }], ctx);
  for (const [ref, paid] of [['P1', 500], ['P2', 445.4]] as const) {
    const es = b.journalEntries.filter((e) => e.transactionRef === ref);
    assert.equal(Math.round((es.filter((e) => e.accountDebit === '1021').reduce((s, e) => s + e.amount, 0) - es.filter((e) => e.accountCredit === '1021').reduce((s, e) => s + e.amount, 0)) * 100) / 100, paid, `${ref}: the lines add up to the payment`);
  }
  const by = (code: string) => Math.round(b.journalEntries.filter((e) => e.vatCode === code).reduce((s, e) => s + e.amount, 0) * 100) / 100;
  // Paid in full: the Rechnung's revenue per rate with the sale codes, the Gutschrift's with the minus code, each within a Rappen.
  assert.ok(Math.abs(by('V81') - 540.5) <= 0.01 && Math.abs(by('V26') - 513) <= 0.01, `V81 ${by('V81')}, V26 ${by('V26')}`);
  assert.ok(Math.abs(by('-V81') - 108.1) <= 0.01, `-V81 ${by('-V81')}`);
  assert.equal(Math.round((by('V81') + by('V26') - by('-V81')) * 100) / 100, 945.4);
  assert.equal(status(now(book, 'a'), book.invoices), 'paid');
});

test('Gutschrift states: Offen while its refund waits, Teilweise once part is back, Abgerechnet when all is', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-01', [line(100, 8.1)]));
  book.invoices[0] = { ...a, payments: [{ transactionRef: 'P', date: '2026-07-05', amount: 108.1, by: 'reference' }] };
  const cn = issued(book, draft('cn', '2026-07-10', [line(-100, 8.1)], { kind: 'credit-note', creditFor: 'a' }));
  assert.equal(creditNoteStatus(cn, book.invoices), 'open', 'all of it is paid back, nothing yet');
  const part = { ...cn, payments: [{ transactionRef: 'R1', date: '2026-07-12', amount: 50, by: 'number' as const }] };
  assert.equal(creditNoteStatus(part, book.invoices), 'partly');
  assert.equal(creditNoteStatus({ ...cn, payments: [{ transactionRef: 'R1', date: '2026-07-12', amount: 108.1, by: 'number' }] }, book.invoices), 'settled');
});

test('P1.12: a Storno of a paid Rechnung is a warning naming the payment; «Trotzdem stornieren» releases it, the payment waits unmatched', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, AGREED]) {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-01', [line(1000, 8.1)]));
    const b = books([paying('P1', '2026-07-20', 1081, { reference: a.reference })]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    assert.throws(() => cancel(now(book, 'a'), { date: '2026-08-01', reason: 'Doppelt' }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'paid' && /1081\.00 vom 2026-07-20/.test(e.message));
    book.invoices[0] = cancel(now(book, 'a'), { date: '2026-08-01', reason: 'Doppelt', confirmed: true });
    releasePayment(b, book, 'a', 'P1', ctx);
    assert.deepEqual([rows(b, 'P1'), now(book, 'a').payments, status(now(book, 'a'), book.invoices)], [[], [], 'cancelled']);
    if (setup === AGREED) assert.deepEqual([rows(b, 'RE-2026-001-storno').length, balance(b.journalEntries, '1100'), balance(b.journalEntries, '3200')], [1, 0, 0], 'the Storno reverses the event; the receivable and the revenue are back at zero');
  }
});

test('a Skonto written off by code goes with its payment when the payment is released', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
  const b = books([paying('P1', '2026-07-16', 1059.38, { reference: a.reference })]);
  bookInvoiceEvents(b, book, ctx);
  matchPayments(b, book, ctx);
  assert.equal(rows(b, 'RE-2026-001-wo-1').length, 1);
  releasePayment(b, book, 'a', 'P1', ctx);
  assert.deepEqual([rows(b, 'RE-2026-001-wo-1'), now(book, 'a').writeOffs, status(now(book, 'a'), book.invoices)], [[], [], 'issued']);
});

test('the figures on every Rechnung of the demos: Betrag − erhalten − gutgeschrieben − ausgebucht = offen, and offen is what openAmount says', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  let seen = 0;
  for (const demo of ['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei']) {
    const file = join(APP_ROOT, demo, 'vanilla-accounting', 'invoices.json');
    if (!existsSync(file)) continue;
    const invoices = (JSON.parse(readFileSync(file, 'utf8')) as InvoiceBook).invoices.filter((i: Invoice) => !i.deleted);
    for (const inv of invoices) {
      if (inv.status !== 'issued' || inv.kind !== 'invoice' || inv.cancelled) continue;
      const f = figures(inv, invoices);
      // In Rappen: a sum that is zero in floating point may come out as -0.
      const rp = (n: number) => Math.round(n * 100);
      assert.equal((rp(f.amount) - rp(f.received) - rp(f.credited) - rp(f.writtenOff)) / 100, f.open, `${demo} ${inv.number}`);
      assert.equal(Math.max(0, f.open), openAmount(inv, invoices), `${demo} ${inv.number}: the same «offen» as the lists`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'the demos hold issued invoices');
});

test('«Lösen» of one invoice of an Ausziffern takes only its part; the other invoice keeps its allocation and bookings; so does «Trotzdem stornieren»', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, AGREED]) {
    for (const how of ['release', 'storno'] as const) {
      setJurisdiction(ch, setup);
      const book = newBook();
      issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
      issued(book, draft('b', '2026-07-11', [line(500, 8.1)]));
      const b = books([paying('P1', '2026-08-04', 1621.5, { description: 'Zahlung' })]);
      bookInvoiceEvents(b, book, ctx);
      allocatePayment(b, book, 'P1', [{ invoiceId: 'a', amount: 1081 }, { invoiceId: 'b', amount: 540.5 }], ctx);
      const ofB = JSON.stringify(b.journalEntries.filter((e) => e.transactionRef === 'P1' && /2026-002/.test(e.description ?? '')));
      if (how === 'storno') book.invoices[0] = cancel(now(book, 'a'), { date: '2026-08-10', reason: 'Doppelt', confirmed: true });
      releasePayment(b, book, 'a', 'P1', ctx);
      bookInvoiceEvents(b, book, ctx);
      assert.equal(JSON.stringify(b.journalEntries.filter((e) => e.transactionRef === 'P1')), ofB, `${how}: only invoice b's part stays, as it was`);
      assert.deepEqual([now(book, 'a').payments.length, now(book, 'b').payments.length, status(now(book, 'b'), book.invoices)], [0, 1, 'paid']);
      assert.deepEqual(b.mappings.filter((m) => m.transactionRef === 'P1').map((m) => m.receiptId), ['r_2026-002'], 'only b\'s PDF stays linked');
      if (setup === AGREED) assert.equal(balance(b.journalEntries, '1100'), how === 'release' ? 1081 : 0, 'a open again, or cancelled');
    }
  }
});

test('a write-off of a cancelled invoice stays: its «Rückgängig» is refused (the Storno reversed it)', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  issued(book, draft('c', '2026-07-20', [line(200, 8.1)]));
  const b = books();
  bookInvoiceEvents(b, book, ctx);
  writeOffRest(b, book, 'c', { date: '2026-09-01', amount: 50, reason: 'loss', by: 'person' }, ctx, { files: [] });
  book.invoices[0] = cancel(now(book, 'c'), { date: '2026-09-15', reason: 'Fehler' });
  bookInvoiceEvents(b, book, ctx);
  assert.throws(() => removeWriteOff(b, book, 'c', 'wo-1'), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'cancelled');
  assert.deepEqual([balance(b.journalEntries, '1100'), rows(b, 'RE-2026-001-wo-1').length], [0, 1]);
});

test('agreed basis: a write-off recorded while the event waits for its rate is booked with the event, at its rate; the event stays the gross', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  let rate: number | undefined;
  const eur = { ...ctx, fx: { daily: () => rate } };
  issued(book, draft('e', '2026-08-10', [line(100, 8.1)], { currency: 'EUR' }));
  const b = books();
  assert.deepEqual(bookInvoiceEvents(b, book, eur).skipped, [{ number: '2026-001', reason: 'rate' }]);
  const { entries } = writeOffRest(b, book, 'e', { date: '2026-08-12', amount: 10, reason: 'discount', by: 'person' }, eur, { files: [] });
  assert.equal(entries.length, 0, 'no event yet: nothing to write off against');
  rate = 0.95;
  bookInvoiceEvents(b, book, eur);
  assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'RE-2026-001').map((e) => [e.amount, e.exchangeRate]), [[108.1, 0.95]]);
  assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'RE-2026-001-wo-1').map((e) => [e.date, e.accountDebit, e.vatCode, e.amount, e.exchangeRate]), [['2026-08-12', '3800', '-V81', 10, 0.95]]);
  assert.equal(bookInvoiceEvents(b, book, eur).booked.length, 0, 'booked once');
  assert.equal(b.journalEntries.filter((e) => /-wo-/.test(e.transactionRef)).length, 1);
});

test('a hand payment names no counterparty: a statement row of another payer confirms it; the customer stays named in its text', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
  const b = books();
  const { transaction } = recordHandPayment(b, book, 'a', { date: '2026-08-04', account: '1021', amount: 1081 }, ctx);
  assert.equal(transaction.counterparty, undefined);
  assert.match(transaction.description, /2026-001 Beispiel Bistro AG/);
  const row = paying('S1', '2026-08-05', 1081, { counterparty: 'Treuhand Keller GmbH' });
  assert.deepEqual([...matchStatementRows([row], b.transactions, () => false)], [[transaction.ref, 'S1']]);
});

test('a write-off before the invoice\'s date is refused', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(100, 8.1)]));
  assert.throws(() => writeOffRest(books(), book, 'a', { date: '2026-07-09', amount: 10, reason: 'fee', by: 'person' }, ctx, { files: [] }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'beforeInvoice');
});

test('a Skonto written off by code on the agreed basis puts its account into the chart when it lacks it; the cash basis needs none', () => {
  for (const setup of [AGREED, EFFECTIVE_QUARTERLY]) {
    setJurisdiction(ch, setup);
    const added: string[] = [];
    const charting = { ...ctx, ensureAccount: (n: string) => { added.push(n); } };
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)], { termsId: 'sk2' }), [SKONTO]);
    const b = books([paying('P1', '2026-07-15', 1059.38, { reference: a.reference })]);
    bookInvoiceEvents(b, book, charting);
    matchPayments(b, book, charting);
    assert.deepEqual(added, setup === AGREED ? ['3800'] : []);
  }
});

test('a refusal of the money carries its code for the UI', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(100, 8.1)]));
  assert.throws(() => recordHandPayment(books(), book, 'a', { date: '2026-08-01', account: '2451', amount: 1 }, ctx), (e: unknown) => e instanceof PaymentError && e.code === 'moneyAccount');
  assert.throws(() => allocatePayment(books([paying('P1', '2026-08-01', 10)]), book, 'P1', [], ctx), (e: unknown) => e instanceof PaymentError && e.code === 'noParts');
});
