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
import { matchPayments, releasePayment, type PaymentContext } from '../src/invoices/payments.js';
import { asDraft, backToDraftRefusal, cancel, creditNoteDraft, deleteDraft, issue, nextNumber, totals, warningsForIssue, InvoiceRuleError } from '../src/invoices/rules.js';
import { chfAmount } from '../src/accounting/ledger.js';
import { applyAccountChange, planAccountChange, takeBackEvent, withAccounts, type AccountContext } from '../src/invoices/revise.js';
import { DEFAULT_LAYOUT, type Draft, type InvoiceBook, type Issued, type SentDocument } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';
import { PERSON, update, type Books } from '../src/books/store.js';
import { closedPart } from '../src/books/seal.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { addComment, backToDraft, changeAccounts, createCustomer, createDraft, fileReceipts, issueInvoice, paymentContext, recordSend, replacedPdf, updateDraft, type Printer } from '../src/invoices/service.js';
import { loadInvoices, saveInvoices } from '../src/invoices/store.js';
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

const newBook = (): InvoiceBook => ({ schema: 3, contacts: [asContact(customer)], invoices: [], articles: [], sent: [] });
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
    assert.deepEqual(plan.reclass, [], 'an open booking changes in place');
    update(b, PERSON, (x) => applyAccountChange(x, [inv], plan, acc()));
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
    assert.deepEqual(plan.reclass, [{ ref: 'RE-2026-001-kk-1', number: '2026-001', date: '2026-08-15', moves: [{ from: '3200', to: '3400', amount: 1081 }] }]);
    update(b, PERSON, (x) => applyAccountChange(x, [inv], plan, acc()));
    assert.deepEqual(closedPart(b, '2026-06-30'), filed, 'nothing of the filed quarter changed');
    assert.deepEqual(rows(b, 'RE-2026-001-kk-1'), [['3200', '3400', undefined, 1081]], 'revenue moved without a code, so no return figure moves');
    assert.equal(b.journalEntries.find((e) => e.transactionRef === 'RE-2026-001-kk-1')?.date, '2026-08-15');
    // A second change numbers its own.
    const again = planAccountChange(b, { ...inv, lines: [line(1000, 8.1, '3400')] }, { ...inv, lines: [line(1000, 8.1, '3600')] }, '2026-08-20', acc());
    assert.equal(again.reclass[0]?.ref, 'RE-2026-001-kk-2');
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
  assert.deepEqual([unbooked.lines.length, unbooked.rebook, unbooked.reclass], [1, [], []], 'nothing booked yet on the cash basis: only the position changes');
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

// ─── review of slice F2 ────────────────────────────────────────────────────────

/** An account's revenue in the books' currency: credits less debits. */
const balance = (b: Books, account: string) => Math.round(b.journalEntries.reduce((s, e) => s + (e.accountCredit === account ? chfAmount(e) : 0) - (e.accountDebit === account ? chfAmount(e) : 0), 0) * 100) / 100;
const balances = (b: Books) => Object.fromEntries(['3200', '3400', '3600'].map((a) => [a, balance(b, a)]));

for (const [name, setup] of BASES) {
  test(`Konten ändern on the ${name} basis, filed: change, change, change back plans from where the revenue stands now (earlier -kk- included)`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-05-10', [line(1000, 8.1)]));
    const b = books([paying('P1', '2026-06-04', 1081, a.reference)], '2026-03-31');
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    b.config.closedThrough = '2026-06-30';
    const filed = closedPart(b, '2026-06-30');
    let inv = book.invoices[0] as Issued;
    const step = (to: string, date: string) => {
      const next = withAccounts(inv, [{ line: 0, account: to }], acc());
      update(b, PERSON, (x) => applyAccountChange(x, [inv], planAccountChange(x, inv, next, date, acc()), acc()));
      inv = next;
    };
    step('3400', '2026-08-15');
    assert.deepEqual(balances(b), { 3200: 0, 3400: 1081, 3600: 0 });
    step('3600', '2026-08-20');
    assert.deepEqual(balances(b), { 3200: 0, 3400: 0, 3600: 1081 }, 'the second moves 3400 → 3600, not 3200 → 3600 again');
    step('3200', '2026-08-25');
    assert.deepEqual(balances(b), { 3200: 1081, 3400: 0, 3600: 0 }, 'back where it was filed');
    assert.deepEqual(rows(b, 'RE-2026-001-kk-3'), [['3600', '3200', undefined, 1081]]);
    assert.deepEqual(closedPart(b, '2026-06-30'), filed);
  });

  test(`Konten ändern on the ${name} basis: a credit note of the invoice follows, its own booking and its applied part`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const a = issued(book, draft('a', '2026-07-10', [line(1000, 8.1)]));
    const cn = issued(book, { ...creditNoteDraft(a, { reason: 'Rabatt', amount: 108.1 }, { id: 'c', createdAt: '2026-07-12T08:00:00Z', origin: 'manual', deleted: false }, '2026-07-12') });
    const b = books([paying('P1', '2026-08-04', 972.9, a.reference)]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    const before = balances(b);
    assert.equal(before[3200], 972.9, 'by hand: 1081 less the credit of 108.10');
    const inv = book.invoices[0] as Issued;
    const plan = planAccountChange(b, inv, withAccounts(inv, [{ line: 0, account: '3400' }], acc()), '2026-08-20', acc(), book.invoices);
    assert.deepEqual(plan.notes.map((n) => [n.number, n.lines]), [[cn.number, [{ line: 0, from: '3200', to: '3400' }]]]);
    update(b, PERSON, (x) => applyAccountChange(x, [inv, cn], plan, acc()));
    assert.deepEqual(balances(b), { 3200: 0, 3400: 972.9, 3600: 0 }, 'the credit\'s revenue moved with the invoice\'s');
    if (setup === AGREED) assert.deepEqual(rows(b, `GS-${cn.number}`), [['3400', '1100', '-V81', 108.1]]);
    else assert.deepEqual(rows(b, 'P1').filter((r) => r[2] === '-V81'), [['3400', '1021', '-V81', 108.1]]);
  });
}

test('a credit note on an account the change splits over two: refused with `credited`', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(600, 8.1), line(400, 8.1)]));
  issued(book, { ...creditNoteDraft(a, { reason: 'Teil', amount: 108.1 }, { id: 'c', createdAt: '2026-07-12T08:00:00Z', origin: 'manual', deleted: false }, '2026-07-12') });
  assert.throws(() => planAccountChange(books(), a, withAccounts(a, [{ line: 1, account: '3400' }], acc()), '2026-08-01', acc(), book.invoices), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'credited');
  // A credit of the whole invoice holds its positions one by one: each follows its own.
  const whole = newBook();
  const w = issued(whole, draft('a', '2026-07-10', [line(600, 8.1), line(400, 8.1)]));
  const all = issued(whole, { ...creditNoteDraft(w, { reason: 'Storno' }, { id: 'c', createdAt: '2026-07-12T08:00:00Z', origin: 'manual', deleted: false }, '2026-07-12') });
  const plan = planAccountChange(books(), w, withAccounts(w, [{ line: 1, account: '3400' }], acc()), '2026-08-01', acc(), whole.invoices);
  assert.deepEqual(plan.notes, [{ id: all.id, number: all.number, lines: [{ line: 1, from: '3200', to: '3400' }] }]);
});

test('a Storno after a reclassification reverses the -kk- entries too: no revenue account keeps a part of it (agreed basis)', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  issued(book, draft('a', '2026-05-10', [line(1000, 8.1)]));
  const b = books([], '2026-03-31');
  bookInvoiceEvents(b, book, ctx);
  b.config.closedThrough = '2026-06-30';
  const inv = book.invoices[0] as Issued;
  const next = withAccounts(inv, [{ line: 0, account: '3400' }], acc());
  update(b, PERSON, (x) => applyAccountChange(x, [inv], planAccountChange(x, inv, next, '2026-08-15', acc()), acc()));
  book.invoices[0] = cancel(next, { date: '2026-09-01', reason: 'Fehler' });
  update(b, PERSON, (x) => bookInvoiceEvents(x, book, ctx));
  assert.deepEqual(balances(b), { 3200: 0, 3400: 0, 3600: 0 });
  assert.equal(balance(b, '1100'), 0);
});

test('a booking a person partly changed: only the lines code owns are spread, over the accounts of their positions', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(600, 8.1, '3200'), line(400, 8.1, '3400')]));
  const b = books([paying('P1', '2026-08-04', 1081, a.reference)]);
  matchPayments(b, book, ctx);
  // She moved the 3400 line to 3600 by hand: it is hers now.
  const hers = b.journalEntries.find((e) => e.transactionRef === 'P1' && e.accountCredit === '3400')!;
  Object.assign(hers, { accountCredit: '3600', origin: 'manual' });
  const inv = book.invoices[0] as Issued;
  const plan = planAccountChange(b, inv, withAccounts(inv, [{ line: 0, account: '3000' }], acc()), '2026-08-20', acc());
  update(b, PERSON, (x) => applyAccountChange(x, [inv], plan, acc()));
  assert.deepEqual(rows(b, 'P1').map((r) => r.slice(1)).sort(), [['3000', 'V81', 648.6], ['3600', 'V81', 432.4]], 'her line as she left it; ours whole on the new account, none of it on 3400');
});

test('a foreign currency: every line keeps the official rate; the cent the split moves is named in the plan', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const eur: PaymentContext = { ...ctx, bankAccounts: [...ctx.bankAccounts, { bank: 'Raiffeisen', currency: 'EUR', account: '1022', label: 'Bank EUR', role: 'bank' }], fx: { daily: () => 0.9337 } };
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [line(100.15, 8.1), line(10.15, 8.1)], { currency: 'EUR' }));
  const g = totals(a).gross;
  const b = books([{ ...paying('P1', '2026-08-04', g, a.reference), currency: 'EUR' }]);
  matchPayments(b, book, eur);
  const cents = (es: JournalEntry[]) => es.reduce((s, e) => s + Math.round(chfAmount(e) * 100), 0);
  const chfBefore = cents(b.journalEntries.filter((e) => e.vatCode === 'V81'));
  const inv = book.invoices[0] as Issued;
  const plan = planAccountChange(b, inv, withAccounts(inv, [{ line: 1, account: '3400' }], acc()), '2026-08-20', acc());
  update(b, PERSON, (x) => applyAccountChange(x, [inv], plan, acc()));
  const after = b.journalEntries.filter((e) => e.vatCode === 'V81');
  assert.equal(after.length, 2);
  assert.ok(after.every((e) => e.exchangeRate === 0.9337 && e.exchangeCurrency === 'EUR'), 'the official rate on every line, never one of our own');
  assert.equal(Math.round(after.reduce((s, e) => s + e.amount, 0) * 100), Math.round(g * 100), 'the code\'s EUR as it was');
  const moved = cents(after) - chfBefore;
  assert.notEqual(moved, 0, 'the case: line by line the code moves a cent');
  assert.equal(Math.round((plan.rebook[0].rounding ?? 0) * 100), moved, 'and the plan names that cent, for the dialog to say');
});

test('a draft that keeps its number, dated into another year: a warning, issued only with «Trotzdem ausstellen»', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const b = issued(book, draft('b', '2026-12-20', [line(500, 8.1)]));
  const back = { ...asDraft(b, { file: 'x', sha256: 'b', issuedAt: b.issuedAt, replacedAt: '2026-12-21T09:00:00Z' }), date: '2027-01-05' };
  assert.deepEqual(warningsForIssue(back), [{ field: 'numberYear' }]);
  const ctxIssue = { customer, sender, layout: DEFAULT_LAYOUT, invoices: [back], now: '2027-01-05T10:00:00Z' };
  assert.throws(() => issue(back, ctxIssue), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'unconfirmed' && /Nummer 2026-001 im Jahr 2027/.test(e.message));
  assert.equal(issue(back, { ...ctxIssue, confirmed: true }).number, '2026-001');
});

test('cash basis: a payment matched and released, back to draft: its receipt goes; issued again and paid, the new receipt is the new PDF under a name of its own', async () => {
  const ws = tempWorkspace('belege-orphan-');
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  writeIndex(ws, { journalEntries: [], config: { closedThrough: '2026-06-30' } });
  let printed = 0;
  const printer: Printer = { pdf: async () => ({ html: '', pages: 1, pdf: Buffer.from(`%PDF-1.4 print ${++printed}`) }), html: async () => ({ html: '', pages: 1 }) };
  const pay = paymentContext(ws)!;
  const c = createCustomer(ws, { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' });
  const d = createDraft(ws, { customerId: c.id, date: '2026-07-10', lines: [line(1000, 8.1)] }, '2026-07-10T08:00:00Z');
  const first = await issueInvoice(ws, d.id, { now: '2026-07-10T09:00:00Z', printer });
  const run = (fn: (x: Books, book: InvoiceBook) => void) => { const x = loadBooks(ws); const book = loadInvoices(ws); update(x, PERSON, (y) => fn(y, book)); saveBooks(ws, x); saveInvoices(ws, book); };
  run((x, book) => { x.transactions.push(paying('P1', '2026-07-15', 1081, first.reference)); fileReceipts(ws, x, matchPayments(x, book, pay).files); });
  run((x, book) => fileReceipts(ws, x, releasePayment(x, book, d.id, 'P1', pay).files));
  const old = loadBooks(ws).receipts.find((r) => r.kind === 'sales-record')!;
  const oldFile = receiptFile(ws, loadBooks(ws), old);
  assert.ok(existsSync(oldFile), 'released: the receipt stays, linked to nothing');
  await backToDraft(ws, d.id, { now: '2026-07-16T10:00:00Z', books: (inv) => {
    const x = loadBooks(ws);
    const files = update(x, PERSON, (y) => takeBackEvent(y, inv, pay.receiptId(pay.pdfOf(inv))).receipts.map((r) => receiptFile(ws, y, r)));
    saveBooks(ws, x);
    return files;
  } });
  assert.deepEqual([loadBooks(ws).receipts.length, existsSync(oldFile)], [0, false], 'the old receipt and its file went with the document');
  updateDraft(ws, d.id, { lines: [line(500, 8.1)] });
  const again = await issueInvoice(ws, d.id, { now: '2026-07-17T09:00:00Z', printer });
  run((x, book) => { x.transactions.push(paying('P2', '2026-07-20', 540.5, again.reference)); fileReceipts(ws, x, matchPayments(x, book, pay).files); });
  const books2 = loadBooks(ws);
  const now = books2.receipts.find((r) => r.kind === 'sales-record')!;
  assert.notEqual(now.filename, old.filename, 'a name of its own');
  assert.equal(readFileSync(receiptFile(ws, books2, now)).toString(), '%PDF-1.4 print 2', 'the receipt is the PDF it was paid on');
  assert.ok(books2.mappings.some((m) => m.transactionRef === 'P2' && m.receiptId === now.id));
});

test('Konten ändern through the service: the books first; documents changed meanwhile: booked back, refused `changed`', async () => {
  const ws = tempWorkspace('belege-accounts-');
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  writeIndex(ws, { journalEntries: [], config: { closedThrough: '2026-06-30' } });
  const printer: Printer = { pdf: async () => ({ html: '', pages: 1, pdf: Buffer.from('%PDF-1.4 x') }), html: async () => ({ html: '', pages: 1 }) };
  const pay = paymentContext(ws)!;
  const c = createCustomer(ws, { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' });
  const d = createDraft(ws, { customerId: c.id, date: '2026-07-10', lines: [line(1000, 8.1)] }, '2026-07-10T08:00:00Z');
  const inv = await issueInvoice(ws, d.id, { now: '2026-07-10T09:00:00Z', printer });
  const x0 = loadBooks(ws); const book0 = loadInvoices(ws);
  update(x0, PERSON, (y) => { y.transactions.push(paying('P1', '2026-07-15', 1081, inv.reference)); fileReceipts(ws, y, matchPayments(y, book0, pay).files); });
  saveBooks(ws, x0); saveInvoices(ws, book0);
  const account = (ref: string) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref && e.vatCode === 'V81').map((e) => e.accountCredit);
  const revenue = (pay.revenueAccount);
  const a = { revenueAccount: revenue, isRevenue: (n: string) => chart().typeOf(n) === 'revenue', base: 'CHF' };
  const via = (meanwhile?: () => void) => changeAccounts(ws, d.id, [{ line: 0, account: '3400' }], a, {
    books: (from, to, invoices) => {
      const x = loadBooks(ws);
      const plan = update(x, PERSON, (y) => { const p = planAccountChange(y, from, to, '2026-08-01', a, invoices); applyAccountChange(y, [from], p, a); return p; });
      saveBooks(ws, x);
      meanwhile?.();
      return plan;
    },
    undo: (_plan, now, before, invoices) => {
      const x = loadBooks(ws);
      update(x, PERSON, (y) => applyAccountChange(y, [now], planAccountChange(y, now, before, '2026-08-01', a, invoices), a));
      saveBooks(ws, x);
    },
  });
  await assert.rejects(via(() => addComment(ws, d.id, 'zwischendurch', 'Anna')), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'changed');
  assert.deepEqual(account('P1'), [revenue], 'booked back');
  assert.equal(((loadInvoices(ws).invoices.find((i) => i.id === d.id) as Issued).lines[0] as { account?: string }).account, undefined);
  await via();
  assert.deepEqual(account('P1'), ['3400']);
  const after = loadInvoices(ws).invoices.find((i) => i.id === d.id) as Issued;
  assert.deepEqual([(after.lines[0] as { account?: string }).account, after.accountChanges?.[0]?.refs], ['3400', ['P1']]);
});
