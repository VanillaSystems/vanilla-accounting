/**
 * «Zurück zum Entwurf» and «Konten ändern» (docs/specs/invoicing.md 4.4.2, 4.5, 4.11; checkpoint
 * P2.7), on the cash and the agreed basis: when the way back is offered and refused (a sent document
 * above all, MWSTG Art. 27 Abs. 2), that the draft keeps its number and the next one skips it, that
 * the event and the receipt its PDF became leave the books, and that a change of accounts moves only
 * revenue between accounts, in place in an open period and by a reclassification without a code in
 * the open period for a booking of a filed one, nothing in the filed quarter changed. Every figure
 * is worked out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { chart, setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents } from '../src/invoices/events.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { asDraft, backToDraftRefusal, deleteDraft, issue, nextNumber, totals, InvoiceRuleError } from '../src/invoices/rules.js';
import { applyAccountChange, planAccountChange, takeBackEvent, withAccounts, type AccountContext } from '../src/invoices/revise.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type InvoiceBook, type Issued, type SentDocument } from '../src/invoices/model.js';
import { PERSON, update, type Books } from '../src/books/store.js';
import { closedPart } from '../src/books/seal.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { backToDraft, createCustomer, createDraft, fileReceipts, issueInvoice, paymentContext, recordSend, replacedPdf, type Printer } from '../src/invoices/service.js';
import { loadInvoices } from '../src/invoices/store.js';
import { loadBooks, receiptFile, saveBooks } from '../src/books/store.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const BASES: Array<[string, VatSetup, boolean]> = [['cash', EFFECTIVE_QUARTERLY, false], ['agreed', AGREED, true]];

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-04-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }],
  revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};
const acc = (): AccountContext => ({ revenueAccount: '3200', isRevenue: (a) => chart().typeOf(a) === 'revenue', base: 'CHF' });

const newBook = (): InvoiceBook => ({ schema: 3, customers: [customer], invoices: [], sent: [] });
const books = (transactions: BankTransaction[] = [], closedThrough = '2026-06-30'): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough } });
const draft = (id: string, date: string, lines: Draft['lines'], over: Partial<Draft> = {}): Draft => ({
  id, createdAt: `${date}T08:00:00Z`, origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date, currency: 'CHF', language: 'de', comments: [], lines, ...over,
});
function issued(book: InvoiceBook, d: Draft): Issued {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `transactional-data/2026/invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
}
const line = (net: number, rate: number, account?: string) => ({ text: 'Beratung', quantity: 1, unit: 'flat', price: net, vatRate: rate, ...(account ? { account } : {}) });
const paying = (ref: string, date: string, amount: number, reference: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: `Zahlung ${ref}`, counterparty: 'BEISPIEL BISTRO AG', reference });
const rows = (b: Books, ref: string) => b.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.accountCredit, e.vatCode, e.amount]);
const byCode = (es: JournalEntry[]) => {
  const m: Record<string, number> = {};
  for (const e of es) if (e.vatCode) m[e.vatCode] = Math.round(((m[e.vatCode] ?? 0) + (e.accountCredit.startsWith('3') ? e.amount : -e.amount)) * 100) / 100;
  return m;
};
const sentDoc = (invoiceId: string, to = 'download'): SentDocument => ({ id: 'sd_1', createdAt: '2026-07-11T08:00:00Z', origin: 'manual', deleted: false, invoiceId, kind: 'invoice', title: 'Rechnung', file: 'x.pdf', sha256: 'x', sentAt: '2026-07-11T08:00:00Z', to, channel: 'download' });

// ─── back to draft ─────────────────────────────────────────────────────────────

test('back to draft is offered only while never sent, nothing settled, not cancelled; a credit note only while no payment of its invoice took it', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
  assert.equal(backToDraftRefusal(a, book.invoices, []), undefined, 'issued, never sent: offered');
  assert.equal(backToDraftRefusal(a, book.invoices, [sentDoc('a')]), 'sent', 'downloaded: the sent log has it, the customer may hold it');
  assert.equal(backToDraftRefusal(a, book.invoices, [sentDoc('a', 'kunde@bistro.example')]), 'sent');
  assert.equal(backToDraftRefusal({ ...a, payments: [{ transactionRef: 'P', date: '2026-07-20', amount: 10, by: 'confirmed' }] }, book.invoices, []), 'settled');
  assert.equal(backToDraftRefusal({ ...a, writeOffs: [{ id: 'wo-1', date: '2026-07-20', amount: 1, reason: 'fee', by: 'person' }] }, book.invoices, []), 'settled');
  assert.equal(backToDraftRefusal({ ...a, cancelled: { date: '2026-07-20', reason: 'x' } }, book.invoices, []), 'cancelled');
  const cn = issued(book, draft('c', '2026-07-15', [line(-100, 8.1)], { kind: 'credit-note', creditFor: 'a' }));
  assert.equal(backToDraftRefusal(book.invoices[0], book.invoices, []), 'settled', 'a credit note issued for it: credited');
  assert.equal(backToDraftRefusal(cn, book.invoices, []), undefined, 'the credit note itself, nothing took it yet');
  book.invoices[0] = { ...a, payments: [{ transactionRef: 'P', date: '2026-07-20', amount: 972.9, by: 'confirmed' }] };
  assert.equal(backToDraftRefusal(cn, book.invoices, []), 'applied', 'a payment after it booked the credit\'s minus lines');
  assert.equal(backToDraftRefusal(draft('d', '2026-07-01', []), book.invoices, []), 'notIssued');
});

test('back to draft keeps the number: the next document skips it, issuing again takes it, deleting the draft is refused', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
  const b = issued(book, draft('b', '2026-07-12', [line(500, 8.1)], { intro: 'Grüezi\n\nWir danken für den Auftrag.' }));
  const back = asDraft(b, { file: 'transactional-data/2026/invoices/2026-002.replaced-1.pdf', sha256: 'b', issuedAt: b.issuedAt, replacedAt: '2026-07-13T09:00:00Z' }, 'Grüezi');
  book.invoices[1] = back;
  assert.deepEqual([back.status, back.number, back.replaced?.length, back.intro, back.dueDate], ['draft', '2026-002', 1, 'Wir danken für den Auftrag.', undefined],
    'its number kept, its PDF named as replaced, the greeting issuing put above the intro taken off, the due date its terms gave dropped');
  assert.equal(nextNumber(book.invoices, '2026-08-01'), '2026-003', 'the kept number stays taken');
  const c = issued(book, draft('c', '2026-07-20', [line(200, 8.1)]));
  assert.equal(c.number, '2026-003');
  const again = issue({ ...back, lines: [line(450, 8.1)] }, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: '2026-07-14T10:00:00Z' });
  assert.deepEqual([again.number, again.reference, again.replaced?.length], ['2026-002', b.reference, 1], 'issued again under its number and reference, the replaced PDF still named');
  assert.throws(() => deleteDraft(back), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'numbered');
});

for (const [name, setup, agreed] of BASES) {
  test(`P2.7 on the ${name} basis: back to draft takes the event and its receipt off the books (agreed), refused while the event lies in a filed period`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
    const b = books();
    bookInvoiceEvents(b, book, ctx);
    assert.equal(rows(b, 'RE-2026-001').length, agreed ? 1 : 0);
    const out = update(b, PERSON, (x) => takeBackEvent(x, a, 'r_2026-001'));
    assert.deepEqual([rows(b, 'RE-2026-001'), b.mappings.filter((m) => m.transactionRef === 'RE-2026-001'), b.receipts.length], [[], [], 0], 'RE-2026-001 gone from the open quarter, with its link and its receipt');
    assert.equal(out.receipts.length, agreed ? 1 : 0, 'the receipt whose file the caller removes');

    // An invoice of the filed quarter whose event was booked then: it stays issued.
    if (!agreed) return;
    const old = issued(book, draft('o', '2026-06-10', [line(100, 8.1)]));
    const filed = books([], '2026-05-31');
    bookInvoiceEvents(filed, book, ctx);
    filed.config.closedThrough = '2026-06-30';
    const before = closedPart(filed, '2026-06-30');
    assert.throws(() => update(filed, PERSON, (x) => takeBackEvent(x, old, 'r_2026-002')), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'closed');
    assert.deepEqual(closedPart(filed, '2026-06-30'), before, 'nothing of the filed quarter changed');
  });

  test(`Konten ändern on the ${name} basis, open period: the booking's revenue moves to the new accounts, each code's total to the Rappen`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(600, 8.1), line(400, 8.1), line(100, 2.6)]));
    const g = totals(a).gross;
    const b = books([paying('P1', '2026-08-04', g, a.reference)]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    const inv = book.invoices[0] as Issued;
    const booked = agreed ? 'RE-2026-001' : 'P1';
    const codes = byCode(b.journalEntries.filter((e) => e.transactionRef === booked));
    assert.deepEqual(codes, { V81: 1081, V26: 102.6 }, 'by hand: 1000 + 8.1 % and 100 + 2.6 %');

    const next = withAccounts(inv, [{ line: 1, account: '3400' }], acc());
    const plan = planAccountChange(b, inv, next, '2026-09-01', acc());
    assert.deepEqual(plan.lines, [{ line: 1, from: '3200', to: '3400' }]);
    assert.deepEqual(plan.rebook.map((r) => [r.ref, r.filed, r.moves]), [[booked, false, [{ from: '3200', to: '3400', amount: 432.4 }]]], '400 of the 1000 at 8.1 %: 432.40 of 1081');
    assert.equal(plan.reclass, undefined, 'an open booking changes in place');
    update(b, PERSON, (x) => applyAccountChange(x, inv, plan, acc()));
    assert.deepEqual(rows(b, booked).map((r) => r.slice(1)).sort(), [['3200', 'V26', 102.6], ['3200', 'V81', 648.6], ['3400', 'V81', 432.4]]);
    assert.deepEqual(byCode(b.journalEntries.filter((e) => e.transactionRef === booked)), codes, 'no code\'s total moved');
    if (agreed) assert.deepEqual(rows(b, 'P1'), [['1021', '1100', undefined, g]], 'the payment settles the receivable: nothing to change');
  });

  test(`Konten ändern on the ${name} basis, filed period: a reclassification without a code in the open period, the filed booking as filed`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-05-10', [line(1000, 8.1)]));
    const b = books([paying('P1', '2026-06-04', 1081, a.reference)], '2026-03-31');
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    b.config.closedThrough = '2026-06-30';
    const inv = book.invoices[0] as Issued;
    const filed = closedPart(b, '2026-06-30');
    const booked = agreed ? 'RE-2026-001' : 'P1';
    const plan = planAccountChange(b, inv, withAccounts(inv, [{ line: 0, account: '3400' }], acc()), '2026-08-15', acc());
    assert.deepEqual(plan.rebook.map((r) => [r.ref, r.filed]), [[booked, true]]);
    assert.deepEqual(plan.reclass, { ref: 'RE-2026-001-kk-1', date: '2026-08-15', moves: [{ from: '3200', to: '3400', amount: 1081 }] });
    update(b, PERSON, (x) => applyAccountChange(x, inv, plan, acc()));
    assert.deepEqual(closedPart(b, '2026-06-30'), filed, 'nothing of the filed quarter changed');
    assert.deepEqual(rows(b, 'RE-2026-001-kk-1'), [['3200', '3400', undefined, 1081]], 'revenue moved without a code, so no return figure moves');
    assert.equal(b.journalEntries.find((e) => e.transactionRef === 'RE-2026-001-kk-1')?.date, '2026-08-15');
    // A second change numbers its own.
    const again = planAccountChange(b, { ...inv, lines: [line(1000, 8.1, '3400')] }, { ...inv, lines: [line(1000, 8.1, '3600')] }, '2026-08-20', acc());
    assert.equal(again.reclass?.ref, 'RE-2026-001-kk-2');
  });
}

test('Konten ändern refuses an account outside the revenue accounts, a text position, a credit note and a cancelled invoice', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [{ kind: 'text', text: 'Titel' }, line(1000, 8.1)]));
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as InvoiceRuleError).code; } };
  assert.equal(code(() => withAccounts(a, [{ line: 1, account: '6500' }], acc())), 'account', 'an expense account');
  assert.equal(code(() => withAccounts(a, [{ line: 0, account: '3400' }], acc())), 'account', 'a text has no account');
  assert.equal(code(() => withAccounts({ ...a, cancelled: { date: '2026-07-20', reason: 'x' } }, [{ line: 1, account: '3400' }], acc())), 'cancelled');
  assert.equal(code(() => withAccounts({ ...a, kind: 'credit-note' }, [{ line: 1, account: '3400' }], acc())), 'creditNote');
  assert.equal(code(() => withAccounts(a, [{ line: 1, account: '3400' }], acc())), 'ok');
  const unbooked = planAccountChange(books(), a, withAccounts(a, [{ line: 1, account: '3400' }], acc()), '2026-08-01', acc());
  assert.deepEqual([unbooked.lines.length, unbooked.rebook, unbooked.reclass], [1, [], undefined], 'nothing booked yet on the cash basis: only the position changes');
});

test('P2.7 through the service, agreed basis: issued by mistake, back to draft under its number, its PDF kept as replaced, RE- gone; issued again under the same number; once sent, refused', async () => {
  const ws = tempWorkspace('belege-back-');
  // Opening the workspace sets its own (the demo's cash basis): the agreed basis after it.
  setJurisdiction(ch, AGREED);
  writeIndex(ws, { journalEntries: [], config: { closedThrough: '2026-06-30' } });
  let printed = 0;
  const printer: Printer = { pdf: async () => ({ html: '', pages: 1, pdf: Buffer.from(`%PDF-1.4 print ${++printed}`) }), html: async () => ({ html: '', pages: 1 }) };
  const pay = paymentContext(ws)!;
  const bookEvents = () => { const b = loadBooks(ws); update(b, PERSON, (x) => fileReceipts(ws, x, bookInvoiceEvents(x, loadInvoices(ws), pay).files)); saveBooks(ws, b); };
  const c = createCustomer(ws, { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' });
  const d = createDraft(ws, { customerId: c.id, date: '2026-07-10', lines: [line(1000, 8.1)] }, '2026-07-10T08:00:00Z');
  const first = await issueInvoice(ws, d.id, { now: '2026-07-10T09:00:00Z', printer });
  bookEvents();
  const receipt = loadBooks(ws).receipts.find((r) => r.kind === 'sales-record')!;
  const receiptPath = receiptFile(ws, loadBooks(ws), receipt);
  assert.ok(existsSync(receiptPath) && rows(loadBooks(ws), 'RE-2026-001').length === 1, 'issued: RE-2026-001 and its receipt');

  const back = await backToDraft(ws, d.id, { now: '2026-07-10T10:00:00Z', books: (inv) => {
    const b = loadBooks(ws);
    const paths = update(b, PERSON, (x) => takeBackEvent(x, inv, pay.receiptId(pay.pdfOf(inv))).receipts.map((r) => receiptFile(ws, x, r)));
    saveBooks(ws, b);
    return paths;
  } });
  assert.deepEqual([back.status, back.number], ['draft', '2026-001']);
  const kept = back.replaced![0];
  assert.equal(kept.file, 'transactional-data/2026/invoices/2026-001.replaced-1.pdf');
  assert.equal(readFileSync(join(ws.paths.root, kept.file)).toString(), '%PDF-1.4 print 1', 'the PDF as issued, byte for byte, under its replaced name');
  assert.equal(kept.sha256, first.pdf.sha256);
  assert.equal(existsSync(join(ws.paths.root, first.pdf.file)), false, 'the number\'s file is free for the new PDF');
  const books1 = loadBooks(ws);
  assert.deepEqual([rows(books1, 'RE-2026-001'), books1.receipts.length, existsSync(receiptPath)], [[], 0, false], 'RE-2026-001 gone from the open quarter, with its receipt and file');

  const other = createDraft(ws, { customerId: c.id, date: '2026-07-11', lines: [line(50, 8.1)] }, '2026-07-11T08:00:00Z');
  assert.equal((await issueInvoice(ws, other.id, { now: '2026-07-11T09:00:00Z', printer })).number, '2026-002', 'the next one skips the kept number');
  const again = await issueInvoice(ws, d.id, { now: '2026-07-12T09:00:00Z', printer });
  assert.deepEqual([again.number, again.pdf.file, again.replaced?.length], ['2026-001', first.pdf.file, 1]);
  assert.equal(readFileSync(join(ws.paths.root, again.pdf.file)).toString(), '%PDF-1.4 print 3');
  assert.equal(replacedPdf(ws, d.id, 1).toString(), '%PDF-1.4 print 1', 'the replaced PDF is still served');
  bookEvents();
  assert.equal(rows(loadBooks(ws), 'RE-2026-001').length, 1, 'booked afresh with the new PDF');

  await recordSend(ws, d.id, { to: 'download', now: '2026-07-12T10:00:00Z' });
  await assert.rejects(backToDraft(ws, d.id), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'sent', 'sent: not offered, refused by the API with `sent`');
});
