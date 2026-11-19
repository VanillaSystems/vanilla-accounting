/**
 * Invoices of a firm not registered for VAT (persona round 5, r5f-10): no VAT on the sheet, no
 * rate to pick, no «MWST» after the UID, no reason needed for a line without VAT; on the net tax
 * rate method a sale is booked with the firm's code. VAT shown on an invoice is owed (Art. 27 Abs. 2
 * MWSTG), so a firm that charges none must print none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { invoiceActivities, invoiceRates, setJurisdiction, vat } from '../src/engines/index.js';
import { creditNoteDraft, issue, missingForIssue, revenueSplit, revenueVatCode } from '../src/invoices/rules.js';
import { assembleSheets, paginate, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { DEFAULT_LAYOUT } from '../src/invoices/model.js';
import type { Draft, InvoiceBook, InvoiceLine, Issued, Sender } from '../src/invoices/model.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { bookInvoiceEvents } from '../src/invoices/events.js';
import { parseDraftPatch } from '../src/invoices/service.js';
import { InvoiceRuleError } from '../src/invoices/rules.js';
import { sheetEdit } from '../src/app/areas/invoices/edit.js';
import type { Books } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };

const sender: Sender = {
  name: 'Salon Beispiel', uid: 'CHE-975.310.864',
  address: { street: 'Dorfstrasse', number: '3', postcode: '8000', town: 'Zürich', country: 'CH' },
  payTo: { account: '1020', iban: 'CH6580808000000000001', bank: 'Raiffeisen' },
};
const customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual' as const, deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' },
  language: 'de' as const, paymentTermsDays: 30,
};
const line = (price: number, vatRate: InvoiceLine['vatRate']): InvoiceLine => ({ text: 'Haarschnitt', quantity: 1, price, vatRate });
const draft = (lines: InvoiceLine[], over: Partial<Draft> = {}): Draft => ({
  id: 'in_d', createdAt: '2026-10-01T09:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-05', currency: 'CHF', language: 'de', lines, comments: [], ...over,
});
const WORDS = { newCustomer: '+', chooseCustomer: 'Kunde', addLine: '+', removeLine: '×', intro: 'Einleitung', closing: 'Schluss', desc: 'Text', noExemption: 'Grund für 0 % wählen …', supplied: 'Leistung' };
const html = (lines: InvoiceLine[], draft = false): string => {
  const d: SheetData = {
    kind: 'invoice', language: 'de', ...(draft ? {} : { number: '2026-001' }), date: '2026-10-05', dueDate: '2026-11-04', currency: 'CHF', customer, sender, lines, intro: '', closing: 'Danke', layout: DEFAULT_LAYOUT,
    ...(draft ? { screen: { qrPlaceholder: 'QR', edit: { scope: 'draft' as const, customers: [{ id: customer.id, name: customer.name }], customerId: customer.id, words: WORDS } } } : {}),
  };
  const blocks = sheetBlocks(d);
  return assembleSheets(d, blocks, paginate(blocks, blocks.map(() => 10), { footer: true, qrBill: false }));
};

test('not registered: the only rate is 0, a line at 0 needs no exemption, the sheet prints no VAT and no «MWST» after the UID', () => {
  setJurisdiction(ch, NOT_REGISTERED);
  assert.deepEqual(invoiceRates(), [0]);
  assert.deepEqual(missingForIssue(draft([line(50, 0)]), { customer, sender, invoices: [] }), [], 'no reason asked for a line without VAT');
  assert.equal(revenueVatCode(0, undefined), undefined);
  const out = html([line(50, 0)]);
  assert.ok(out.includes('CHE-975.310.864'), 'the UID stays');
  assert.ok(!out.includes('CHE-975.310.864 MWST'), 'no VAT number');
  assert.ok(!/MWST-Nr\./.test(out), 'no VAT number label');
  assert.ok(!/MWST \d/.test(out), 'no VAT line');
  assert.ok(!/<th class="r">MWST<\/th>/.test(out), 'no VAT column');
  const editing = html([line(50, 0)], true);
  assert.ok(!editing.includes('data-ed="exemption"'), 'a draft asks no reason for 0 %');
  assert.ok(!editing.includes('data-ed="l:0:vatRate"'), 'a draft offers no rate to pick');
});

test('registered: the jurisdiction\'s rates, the VAT number and the VAT line as before; the net tax rate method books a sale with F1', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.deepEqual(invoiceRates(), [8.1, 2.6, 3.8, 0]);
  assert.deepEqual(missingForIssue(draft([line(50, 0)]), { customer, sender, invoices: [] }).map((m) => m.field), ['exemption']);
  const out = html([line(50, 8.1)]);
  assert.ok(out.includes('CHE-975.310.864 MWST'));
  assert.ok(/MWST 8.1 % auf/.test(out));
  assert.ok(html([line(50, 0)], true).includes('data-ed="exemption"'), 'a registered firm\'s draft asks the reason for 0 %');
  assert.equal(revenueVatCode(8.1, undefined), 'V81');
  setJurisdiction(ch, NET_RATE);
  assert.equal(revenueVatCode(8.1, undefined), 'F1');
});

test('a firm without a UID (#452): the sheet prints no UID label and no empty UID, in the letterhead nor in the footer', () => {
  setJurisdiction(ch, NOT_REGISTERED);
  // As src/invoices/documents.ts builds the sender of a firm without one: an empty UID.
  const bare = { ...sender, uid: '' };
  const d: SheetData = { kind: 'invoice', language: 'de', number: '2026-001', date: '2026-10-05', dueDate: '2026-11-04', currency: 'CHF', customer, sender: bare, lines: [line(50, 0)], intro: '', closing: 'Danke', layout: DEFAULT_LAYOUT };
  const blocks = sheetBlocks(d);
  const out = assembleSheets(d, blocks, paginate(blocks, blocks.map(() => 10), { footer: true, qrBill: false }));
  assert.match(out, /class="foot"/, 'the footer is there');
  assert.doesNotMatch(out, /<span>UID<br>/, 'no UID label');
  assert.doesNotMatch(out, /undefined/);
  assert.match(html([line(50, 0)]), /<span>UID<br>CHE-975\.310\.864<\/span>/, 'with a UID the footer names it');
});

// ─── two approved net tax rates (#504, spec invoicing.md F3, P1.9) ────────────

const TWO_RATES: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }, { rate: 6.2, label: 'Handel', activityId: '99902' }] };
const TWO_AGREED: VatSetup = { ...TWO_RATES, reporting: 'agreed' } as VatSetup;
const work = (price: number, activity?: 1 | 2): InvoiceLine => ({ text: 'Schreinerarbeit', quantity: 1, price, vatRate: 8.1, ...(activity ? { activity } : {}) });
const payCtx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }],
  revenueAccount: '3400', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};
const emptyBooks = (): Books => ({ receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } });
const issuedTwo = (book: InvoiceBook, d: Draft): Issued => {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
};
const boxesOf = (entries: JournalEntry[], key: string) => Object.fromEntries(vat().report(entries, key, []).ziffern.filter((z) => z.amount !== 0).map((z) => [z.number, z.amount]));
const coded = (entries: JournalEntry[]) => entries.filter((e) => e.vatCode).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]);

test('two net rates: a position of the second activity books F2, one of the first (or without) F1; the split groups by account and activity', () => {
  setJurisdiction(ch, TWO_RATES);
  assert.deepEqual(invoiceActivities().map((r) => r.rate), [4.5, 6.2]);
  assert.equal(revenueVatCode(8.1, undefined), 'F1');
  assert.equal(revenueVatCode(8.1, undefined, 2), 'F2');
  assert.equal(revenueVatCode(0, 'abroad', 2), 'V0-E', 'a supply abroad keeps its own code');
  assert.deepEqual(revenueSplit({ lines: [work(1000), work(500, 2), work(200, 1)] }, 1837.7, '3400'), [
    { account: '3400', vatCode: 'F1', amount: 1297.2 }, { account: '3400', vatCode: 'F2', amount: 540.5 },
  ]);
  setJurisdiction(ch, NET_RATE);
  assert.deepEqual(invoiceActivities(), [], 'one approved rate: no activity to choose');
});

test('two net rates on the cash basis: the payment books F1 and F2, and the half year\'s form shows each in its own rate\'s row (323, 333)', () => {
  setJurisdiction(ch, TWO_RATES);
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] } as InvoiceBook;
  const inv = issuedTwo(book, draft([work(1000, 1), work(500, 2)]));
  const b = emptyBooks();
  b.transactions.push({ ref: 'p1', bank: 'Raiffeisen', date: '2026-11-20', amount: 1621.5, currency: 'CHF', direction: 'CRDT', description: 'Zahlung', reference: inv.reference });
  const paid = matchPayments(b, book, payCtx);
  assert.deepEqual(paid.paid.map((p) => [p.transactionRef, p.booked]), [['p1', true]]);
  assert.deepEqual(coded(b.journalEntries), [['2026-11-20', '1020', '3400', 1081, 'F1'], ['2026-11-20', '1020', '3400', 540.5, 'F2']]);
  // By hand: 1081 × 4.5 % = 48.65 (323), 540.50 × 6.2 % = 33.51 (333), 82.16 owed.
  assert.deepEqual(boxesOf(b.journalEntries, '2026-H2'), { 200: 1621.5, 299: 1621.5, 323: 1081, 333: 540.5, 399: 82.16, 500: 82.16 });
});

test('two net rates on the agreed basis: the invoice\'s event books F1 and F2 on its date, a credit note of the second activity takes F2 back', () => {
  setJurisdiction(ch, TWO_AGREED);
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] } as InvoiceBook;
  const inv = issuedTwo(book, draft([work(1000, 1), work(500, 2)]));
  const b = emptyBooks();
  bookInvoiceEvents(b, book, payCtx);
  assert.deepEqual(coded(b.journalEntries), [['2026-10-05', '1100', '3400', 1081, 'F1'], ['2026-10-05', '1100', '3400', 540.5, 'F2']]);
  assert.deepEqual(boxesOf(b.journalEntries, '2026-H2'), { 200: 1621.5, 299: 1621.5, 323: 1081, 333: 540.5, 399: 82.16, 500: 82.16 });
  // A part of the total credited: it splits over both activities by their share, each back at its own code.
  const cn = issuedTwo(book, { ...creditNoteDraft(inv, { amount: 162.15, reason: 'Kulanz' }, { id: 'c1', createdAt: '2026-10-10T08:00:00Z', origin: 'manual', deleted: false }, '2026-10-10') } as Draft);
  assert.deepEqual(cn.lines.map((l) => [l.price, l.activity ?? 1]), [[-108.1, 1], [-54.05, 2]]);
  bookInvoiceEvents(b, book, payCtx);
  assert.deepEqual(coded(b.journalEntries).slice(2), [['2026-10-10', '3400', '1100', 108.1, '-F1'], ['2026-10-10', '3400', '1100', 54.05, '-F2']]);
});

test('the activity is checked where a draft comes in: 1 or 2; a 2 on a firm with one net rate (a draft from before it went back) is dropped, so the line stays editable and books the first', () => {
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] } as InvoiceBook;
  const refusal = (body: unknown) => { try { parseDraftPatch(body, book); } catch (e) { return [(e as InvoiceRuleError).code, (e as InvoiceRuleError).missing?.[0]?.field]; } return undefined; };
  setJurisdiction(ch, TWO_RATES);
  assert.deepEqual(parseDraftPatch({ lines: [work(10, 2), work(10, 1)] }, book).lines!.map((l) => l.activity), [2, undefined], 'the first is the default and not kept');
  assert.deepEqual(refusal({ lines: [{ ...work(10), activity: 3 }] }), ['incomplete', 'line.activity']);
  assert.equal(parseDraftPatch({ lines: [{ ...work(10, 2), vatRate: 0 }] }, book).lines![0].activity, undefined, 'a line at 0 % has no activity');
  setJurisdiction(ch, NET_RATE);
  // The draft kept a 2 from when the firm had two rates: the next save of any field drops it.
  const stale = draft([work(10, 2), work(20)]);
  assert.deepEqual(missingForIssue(stale, { customer, sender, invoices: [] }), [], 'it can be issued');
  assert.deepEqual(parseDraftPatch({ lines: stale.lines.map((l, k) => (k === 1 ? { ...l, price: 25 } : l)) }, book).lines!.map((l) => [l.price, l.activity]), [[10, undefined], [25, undefined]]);
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.equal(parseDraftPatch({ lines: [work(10, 2)] }, book).lines![0].activity, undefined);
});

test('a payment read in after the firm went back to one net rate, for an invoice issued with a second activity: booked at the first, never a stop of the import', () => {
  setJurisdiction(ch, TWO_RATES);
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] } as InvoiceBook;
  const inv = issuedTwo(book, draft([work(1000, 1), work(500, 2)]));
  setJurisdiction(ch, NET_RATE);
  assert.equal(revenueVatCode(8.1, undefined, 2), 'F1');
  const b = emptyBooks();
  b.transactions.push({ ref: 'p1', bank: 'Raiffeisen', date: '2027-01-20', amount: 1621.5, currency: 'CHF', direction: 'CRDT', description: 'Zahlung', reference: inv.reference });
  const paid = matchPayments(b, book, payCtx);
  assert.deepEqual(paid.paid.map((p) => [p.transactionRef, p.booked]), [['p1', true]]);
  assert.deepEqual(coded(b.journalEntries), [['2027-01-20', '1020', '3400', 1081, 'F1'], ['2027-01-20', '1020', '3400', 540.5, 'F1']]);
});

test('a credit note for part of the total: on a firm with one rate one line per rate, whatever the lines\' activity; with two, one per activity, named by its first position', () => {
  setJurisdiction(ch, TWO_RATES);
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] } as InvoiceBook;
  const inv = issuedTwo(book, draft([work(1000, 1), { ...work(500, 2), text: 'Beschläge' }, { ...work(100), vatRate: 0 }], { exemption: 'abroad' }));
  const env = { id: 'c1', createdAt: '2026-10-10T08:00:00Z', origin: 'manual' as const, deleted: false };
  const two = creditNoteDraft(inv, { amount: 172.15, reason: 'Kulanz' }, env, '2026-10-10').lines;
  assert.deepEqual(two.map((l) => [l.text, l.vatRate, l.activity ?? 1]), [['Kulanz (8.1 %, Schreinerarbeit)', 8.1, 1], ['Kulanz (8.1 %, Beschläge)', 8.1, 2], ['Kulanz (0 %)', 0, 1]]);
  setJurisdiction(ch, NET_RATE);
  const one = creditNoteDraft(inv, { amount: 172.15, reason: 'Kulanz' }, env, '2026-10-10').lines;
  assert.deepEqual(one.map((l) => [l.text, l.vatRate, l.activity]), [['Kulanz (8.1 %)', 8.1, undefined], ['Kulanz (0 %)', 0, undefined]], 'the same code: one line per rate');
});

test('the activity picker: on screen beside the rate, labelled with the firm\'s rates, only with two rates; never on paper (MWSTG Art. 37 Abs. 2)', () => {
  setJurisdiction(ch, TWO_RATES);
  const editing = html([work(1000), work(500, 2)], true);
  assert.match(editing, /<select class="ed edsel" data-ed="l:0:activity"><option value="1" selected>Schreinerei 4.5 %<\/option><option value="2">Handel 6.2 %<\/option><\/select>/);
  assert.match(editing, /data-ed="l:1:activity"><option value="1">Schreinerei 4.5 %<\/option><option value="2" selected>/);
  const paper = html([work(1000), work(500, 2)]);
  assert.doesNotMatch(paper, /activity|Schreinerei|Handel|4\.5 %|6\.2 %/, 'the issued sheet names the statutory rate only');
  assert.match(paper, /8\.1 %/);
  // The edit the picker reports: 2 kept on the line, 1 removes it.
  const d = draft([work(1000), work(500, 2)]);
  const ctx = { customers: [customer], defaultTexts: { intro: '', closing: '' } };
  assert.deepEqual(sheetEdit(d, 'l:0:activity', '2', ctx), { change: { lines: [work(1000, 2), work(500, 2)] } });
  assert.deepEqual(sheetEdit(d, 'l:1:activity', '1', ctx), { change: { lines: [work(1000), work(500)] } });
  assert.deepEqual(sheetEdit(d, 'l:0:activity', '3', ctx), { refused: 'value' });
  setJurisdiction(ch, NET_RATE);
  assert.doesNotMatch(html([work(1000)], true), /:activity/, 'one approved rate: no picker');
});
