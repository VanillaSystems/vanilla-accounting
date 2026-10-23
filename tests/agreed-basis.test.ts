/**
 * VAT on the agreed consideration (MWSTG Art. 39 Abs. 1, Art. 40 Abs. 1): an invoice the app issues
 * is a VAT event on its date, a credit note and a cancellation on theirs (Art. 41), and the payment
 * only settles the receivable; a payment's coded line takes its document's date and the open item
 * (src/accounting/tax-point.ts); a foreign document converts at its own date's rate (MWSTV Art. 45);
 * the switch counts the open items in the first period after it (MWSTV Art. 106). The return reads
 * the same entries by date, so the cash basis is untouched. Every figure is worked out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents, eventRef } from '../src/invoices/events.js';
import { bookPayment, matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { cancel, creditNoteDraft, issue, totals } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { atTaxPoint, openDay, settlementLines, type TaxPointContext } from '../src/accounting/tax-point.js';
import { periodLock, type Books } from '../src/books/store.js';
import { ech0217Xml } from '../src/providers/ech0217/xml.js';
import { parseFiledReturn } from '../src/accounting/filed-return.js';
import { chfAmount } from '../src/accounting/ledger.js';
import type { BankTransaction, JournalEntry, QuarterKey, Receipt } from '../src/types/index.js';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';


const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const ITEMS = { receivable: '1100', payable: '2000', fxDifference: '6960' };
const RATES: Record<string, number> = { '2026-09-01': 0.94, '2026-09-28': 0.94, '2026-10-05': 0.95, '2026-10-15': 0.95 };

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const envelope = (id: string) => ({ id, createdAt: '2026-07-01T08:00:00Z', origin: 'manual' as const, deleted: false });

/** An issued document, numbered after `book`'s, added to it. */
function issued(book: InvoiceBook, d: Draft): Issued {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
}
const draft = (id: string, date: string, net: number, over: Partial<Draft> = {}): Draft => ({
  ...envelope(id), status: 'draft', kind: 'invoice', customerId: 'cu_1', date, currency: 'CHF', language: 'de', comments: [],
  lines: [{ text: 'Beratung', quantity: 1, unit: 'flat', price: net, vatRate: 8.1 }], ...over,
});

const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }, { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }],
  revenueAccount: '3200', openItems: ITEMS, fx: { daily: (c, d) => (c === 'EUR' ? RATES[d] : undefined) },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`,
};
const books = (closedThrough: string, transactions: BankTransaction[] = []): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough } });
const tx = (ref: string, date: string, amount: number, direction: 'CRDT' | 'DBIT', over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction, description: ref, ...over });
const figures = (entries: JournalEntry[], key: QuarterKey) => Object.fromEntries(Object.entries(vat().figures(entries, key, []).ziffern).filter(([, v]) => v !== 0));
const balance = (entries: JournalEntry[], account: string) => Math.round(entries.reduce((s, e) => s + (e.accountDebit === account ? chfAmount(e) : 0) - (e.accountCredit === account ? chfAmount(e) : 0), 0) * 100) / 100;

test('agreed basis: invoices are VAT events on their dates, payments settle the receivable, a credit note and a cancellation take it back when they are issued', () => {
  setJurisdiction(ch, AGREED);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [], sent: [] };
  const inv1 = issued(book, draft('i1', '2026-08-20', 1000));
  const inv2 = issued(book, draft('i2', '2026-09-25', 2000));
  const inv3 = issued(book, draft('i3', '2026-09-28', 500));
  const inv4 = issued(book, draft('i4', '2026-09-01', 1000, { currency: 'EUR', exemption: 'abroad', lines: [{ text: 'Workshop Wien', quantity: 1, unit: 'flat', price: 1000, vatRate: 0 }] }));
  const b = books('2026-06-30');

  const first = bookInvoiceEvents(b, book, ctx);
  assert.deepEqual(first.booked.map((x) => [x.number, x.kind, x.date]), [['2026-001', 'issue', '2026-08-20'], ['2026-002', 'issue', '2026-09-25'], ['2026-003', 'issue', '2026-09-28'], ['2026-004', 'issue', '2026-09-01']]);
  assert.deepEqual(bookInvoiceEvents(b, book, ctx).booked, [], 'booked once: the event refs are in the books');
  const e1 = b.journalEntries.filter((e) => e.transactionRef === eventRef(inv1, 'issue'));
  assert.deepEqual(e1.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [['2026-08-20', '1100', '3200', 1081, 'V81']]);
  const e4 = b.journalEntries.find((e) => e.transactionRef === eventRef(inv4, 'issue'))!;
  assert.deepEqual([e4.amount, e4.exchangeCurrency, e4.exchangeRate, e4.vatCode, chfAmount(e4)], [1000, 'EUR', 0.94, 'V0-E', 940], 'the export of a service at the rate of the invoice date (MWSTV Art. 45)');
  assert.deepEqual(b.mappings.find((m) => m.transactionRef === 'RE-2026-001'), { transactionRef: 'RE-2026-001', receiptId: 'r_2026-001', by: 'rule', rule: 'invoice-issue' }, 'the invoice PDF is the event\'s receipt');

  // Q3 by hand (gross figures, as the electronic return carries them): 1081 + 2162 + 540.50 at 8.1 % is 3783.50, its tax 3783.50 × 8.1 / 108.1 = 283.50; 940 abroad (221).
  assert.deepEqual(figures(b.journalEntries, '2026-Q3'), { 200: 4723.5, 221: 940, 289: 940, 299: 3783.5, 303: 3783.5, 399: 283.5, 500: 283.5 });

  // Q4: INV2 paid in full, INV3 cancelled, a credit note on INV2 refunded, INV4 paid in EUR at a higher rate.
  const cn = issued(book, { ...creditNoteDraft(inv2, { amount: 540.5, reason: 'Kulanz', settlement: 'refund' }, envelope('c1'), '2026-10-10'), sender } as Draft);
  book.invoices[book.invoices.indexOf(inv3)] = cancel(inv3, { date: '2026-10-02', reason: 'doppelt' });
  b.transactions.push(
    tx('p2', '2026-10-05', 2162, 'CRDT', { reference: inv2.reference }),
    tx('p4', '2026-10-15', 1000, 'CRDT', { bank: 'Wise', currency: 'EUR', reference: inv4.reference }),
    tx('r5', '2026-10-20', 540.5, 'DBIT', { description: `Rückzahlung Gutschrift ${cn.number}` }),
  );
  const second = bookInvoiceEvents(b, book, ctx);
  assert.deepEqual(second.booked.map((x) => [x.number, x.kind, x.date]), [['2026-003', 'storno', '2026-10-02'], ['2026-005', 'issue', '2026-10-10']]);
  const paid = matchPayments(b, book, ctx);
  assert.deepEqual(paid.paid.map((p) => [p.transactionRef, p.booked]), [['p2', true], ['p4', true], ['r5', true]]);
  const of = (ref: string) => b.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.exchangeRate ?? '']);
  assert.deepEqual(of('p2'), [['2026-10-05', '1021', '1100', 2162, '', '']], 'the payment settles the receivable without a code');
  assert.deepEqual(of('p4'), [['2026-10-15', '1023', '1100', 1000, '', 0.95], ['2026-10-15', '1100', '6960', 10, '', '']], 'EUR 1000 held at 940, paid at 950: a gain of 10 on the exchange');
  assert.deepEqual(of('r5'), [['2026-10-20', '1100', '1021', 540.5, '', '']], 'the refund settles the credit note\'s receivable');
  assert.deepEqual(of('RE-2026-003-storno'), [['2026-10-02', '3200', '1100', 540.5, '-V81', '']]);
  assert.deepEqual(of('GS-2026-005'), [['2026-10-10', '3200', '1100', 540.5, '-V81', '']]);

  // Q4 by hand: the payments declare nothing; the storno and the credit note take back 1081 at 8.1 %, a credit of 81 for the firm (510).
  assert.deepEqual(figures(b.journalEntries, '2026-Q4'), { 200: -1081, 299: -1081, 303: -1081, 399: -81, 510: 81 });
  assert.deepEqual(figures(b.journalEntries, '2026-Q3'), { 200: 4723.5, 221: 940, 289: 940, 299: 3783.5, 303: 3783.5, 399: 283.5, 500: 283.5 }, 'Q3 stays as it was');
  assert.equal(balance(b.journalEntries, '1100'), 1081, 'what is still open is INV1 alone');
  assert.equal(totals(inv1.lines).gross, 1081);
});

test('agreed basis: a payment\'s coded line takes its document\'s date and the open item; a filed period of the year is corrected, an earlier year stays on the payment', () => {
  setJurisdiction(ch, AGREED);
  let n = 0;
  const point = (closedThrough: string, dates: string[]): TaxPointContext => ({
    accounts: ITEMS, bankAccount: '1021', lock: periodLock(books(closedThrough)), rateOn: (c, d) => (c === 'EUR' ? RATES[d] : undefined),
    documents: dates.map((date) => ({ date, kind: 'invoice' as const })), length: 'quarter', newId: () => `n${++n}`,
  });
  const line = (over: Partial<JournalEntry>): JournalEntry => ({ id: 'e1', transactionRef: 'b1', date: '2026-10-05', accountDebit: '6500', accountCredit: '1021', amount: 108.1, vatCode: 'I81', description: 'Swisscom', origin: 'classify', ...over });
  const pay = { ref: 'b1', date: '2026-10-05', currency: 'CHF' };
  const rows = (es: JournalEntry[]) => es.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.corrects ?? '']);

  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2026-06-30', ['2026-09-28']))), [
    ['2026-09-28', '6500', '2000', 108.1, 'I81', ''],
    ['2026-10-05', '2000', '1021', 108.1, '', ''],
  ], 'the bill of September: its input tax in Q3, the payment of October settles the payable');
  assert.equal(figures(atTaxPoint(pay, [line({})], point('2026-06-30', ['2026-09-28'])), '2026-Q3')['405'], 8.1);
  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2026-09-30', ['2026-09-28']))), [['2026-10-05', '6500', '1021', 108.1, 'I81', '2026-Q3']], 'Q3 is filed: the input tax goes into its correction (form 0535)');
  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2025-12-31', ['2025-12-20']))), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']], 'a bill of the year before the switch: deducted when paid (MWSTV Art. 106 Abs. 1 lit. b)');
  assert.deepEqual(rows(atTaxPoint(pay, [line({ vatCode: undefined, accountDebit: '2850' })], point('2026-06-30', ['2026-09-28']))), [['2026-10-05', '2850', '1021', 108.1, '', '']], 'a line without a code keeps the payment\'s date');
  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2026-06-30', ['2026-10-05']))), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']], 'bill and payment on one day: nothing to settle');
  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2026-06-30', ['2027-01-04']))), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']], 'a document of a later year never moves a line out of its payment\'s year');


  const sale = line({ accountDebit: '1021', accountCredit: '3200', amount: 1081, vatCode: 'V81' });
  assert.deepEqual(rows(atTaxPoint({ ...pay, date: '2026-10-05' }, [sale], point('2026-06-30', ['2026-09-25', '2026-10-01']))), [
    ['2026-09-25', '1100', '3200', 1081, 'V81', ''],
    ['2026-10-05', '1021', '1100', 1081, '', ''],
  ], 'a sale by its earliest document: the tax is never declared late');

  const eur = line({ accountCredit: '1023', exchangeCurrency: 'EUR', exchangeRate: 0.95 });
  const moved = atTaxPoint({ ...pay, currency: 'EUR' }, [eur], { ...point('2026-06-30', ['2026-09-28']), bankAccount: '1023' });
  assert.deepEqual(moved.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.exchangeRate ?? '', chfAmount(e)]), [
    ['2026-09-28', '6500', '2000', 108.1, 0.94, 101.61],
    ['2026-10-05', '2000', '1023', 108.1, 0.95, 102.7],
    ['2026-10-05', '6960', '2000', 1.09, '', 1.09],
  ], 'EUR 108.10: 101.61 on the bill\'s day, 102.70 paid; the loss of 1.09 leaves the payable at zero');
  assert.equal(balance(moved, '2000'), 0);

  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.deepEqual(rows(atTaxPoint(pay, [line({})], point('2026-06-30', ['2026-09-28']))), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']], 'the cash basis keeps the payment\'s date');
});

test('the switch: open invoices of the year before count in the first open period; a document with its event is settled on either basis', () => {
  setJurisdiction(ch, AGREED);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [], sent: [] };
  const old = issued(book, draft('o1', '2025-12-10', 1000));
  old.payments.push({ transactionRef: 'p0', date: '2025-12-20', amount: 500, by: 'reference' });
  const b = books('2025-12-31');
  const out = bookInvoiceEvents(b, book, ctx);
  assert.deepEqual(out.booked, [{ number: '2025-001', kind: 'issue', date: '2026-01-01' }]);
  assert.deepEqual(b.journalEntries.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [['2026-01-01', '1100', '3200', 581, 'V81']], 'what was open on 31.12. (1081 less 500 paid), in Q1 (MWSTV Art. 106 Abs. 1 lit. a)');
  assert.equal(openDay(periodLock(b), '2025-12-10'), '2026-01-01');

  // Back on the cash basis, the payment of a document with its event still only settles the receivable (MWSTV Art. 106 Abs. 2).
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const p = tx('p1', '2026-02-03', 581, 'CRDT');
  b.transactions.push(p);
  const entries = bookPayment(b, p, old, { transactionRef: 'p1', date: '2026-02-03', amount: 581, by: 'confirmed' }, ctx, { files: [] });
  assert.deepEqual(entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']), [['1021', '1100', 581, '']]);
  assert.deepEqual(bookInvoiceEvents(b, book, ctx).booked, [], 'the cash basis books no events');
});

test('the classifier books a supplier\'s payment on the agreed basis: the bill\'s input tax on its date, the payment settles the payable', async () => {
  setJurisdiction(ch, AGREED);
  const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }], vat: AGREED };
  const answer: ClassifyDeps['ask'] = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '6500', accountCredit: '1021', amount: 108.1, vatCode: 'I81', description: 'Swisscom' }], reason: 'Telefon.' }])));
  };
  const run = async (billDate: string) => {
    const pay = tx('B1', '2026-10-17', 108.1, 'DBIT', { description: 'Swisscom' });
    const bill = { id: 'r1', filename: 'swisscom.pdf', originalFilename: 'swisscom.pdf', extractedText: 'Swisscom Rechnung', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: `${billDate}T08:00:00Z`, location: 'archived', date: billDate, amount: 108.1, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }] } as Receipt;
    const b = { ...books('2026-09-30', [pay]), receipts: [bill], mappings: [{ transactionRef: 'B1', receiptId: 'r1' }] };
    const out = await classifyTransactions(b, [pay], { ask: answer, fx: { daily: () => undefined, flat: () => undefined }, context });
    assert.deepEqual(out.classified, ['B1'], JSON.stringify(out.failed));
    return b.journalEntries.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.corrects ?? '']);
  };
  assert.deepEqual(await run('2026-10-02'), [['2026-10-02', '6500', '2000', 108.1, 'I81', ''], ['2026-10-17', '2000', '1021', 108.1, '', '']]);
  assert.deepEqual(await run('2026-09-20'), [['2026-10-17', '6500', '1021', 108.1, 'I81', '2026-Q3']], 'the bill of the filed Q3: its input tax into Q3\'s correction');
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
});

test('settlement lines: a debit left on the open item is a loss, a credit a gain; nothing in the books\' currency', () => {
  setJurisdiction(ch, AGREED);
  const s = { account: '1100', bank: '1023', currency: 'EUR', fxDifference: '6960' };
  assert.deepEqual(settlementLines({ ...s, amount: 100, rate: 0.9, booked: 95 }).map((l) => [l.accountDebit, l.accountCredit, l.amount]), [['1023', '1100', 100], ['6960', '1100', 5]]);
  assert.deepEqual(settlementLines({ ...s, amount: -100, rate: 0.9, booked: -95 }).map((l) => [l.accountDebit, l.accountCredit, l.amount]), [['1100', '1023', 100], ['1100', '6960', 5]]);
  assert.deepEqual(settlementLines({ ...s, bank: '1021', currency: 'CHF', amount: 100, booked: 100 }).map((l) => [l.accountDebit, l.accountCredit, l.amount]), [['1021', '1100', 100]]);
});

test('the electronic return on the agreed basis says so (formOfReporting 1) and reads back to the same figures', () => {
  setJurisdiction(ch, AGREED);
  const book: InvoiceBook = { schema: 1, customers: [customer], invoices: [], sent: [] };
  issued(book, draft('i1', '2026-08-20', 1000));
  const b = books('2026-06-30');
  bookInvoiceEvents(b, book, ctx);
  const f = vat().figures(b.journalEntries, '2026-Q3', []);
  const input = { uid: 'CHE-123.456.789', organisationName: 'Muster Kaffee GmbH', period: { key: '2026-Q3', from: '2026-07-01', to: '2026-09-30' }, ziffern: f.ziffern, payable: f.payable, form: vat().form, rateRows: vat().rateRows, generationTime: '2026-10-20T10:00:00' };
  const { xml } = ech0217Xml({ ...input, basis: 'agreed' });
  assert.match(xml, /<eCH-0217:formOfReporting>1<\/eCH-0217:formOfReporting>/);
  assert.match(ech0217Xml(input).xml, /<eCH-0217:formOfReporting>2<\/eCH-0217:formOfReporting>/, 'the cash basis as before');
  const back = parseFiledReturn(xml);
  assert.deepEqual([back.period, back.ziffern['200'], back.ziffern['303'], back.ziffern['399'], back.ziffern['500']], ['2026-Q3', 1081, 1081, 81, 81]);
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
});
