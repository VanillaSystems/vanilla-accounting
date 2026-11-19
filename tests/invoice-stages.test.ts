/**
 * Teilrechnungen, Akonto, Schlussrechnung and Rückbehalt (docs/specs/invoicing.md 4.4.9, 4.5, P3.1 to
 * P3.3): a plan of 30 % / 40 % / rest on an Auftrag with two rates, its two Teilrechnungen and the
 * Schlussrechnung that lists the whole work less both; on the agreed basis three events whose sum is
 * the whole, on the cash basis three payments whose revenue is the whole, for each VAT setup; a
 * Schlussrechnung while an Akonto is unpaid; a retention of 5 % with its QR amount, the fact on its
 * day, the instalment notice and its payment matched by the same reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';
import { bookInvoiceEvents } from '../src/invoices/events.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { backToDraftRefusal, cancel, creditNoteDraft, dueFor, instalmentDue, isOverdue, issue, missingForIssue, openAmount, payableAtIssue, retentionDue, retentionOf, skontoOf, skontoOffer, status, totals, InvoiceRuleError } from '../src/invoices/rules.js';
import { checkDeductions, checkPlan, deductible, finalDraft, planGap, stageDraft, stageStates, withDeductions } from '../src/invoices/stages.js';
import { doneShare } from '../src/invoices/chain.js';
import { DEFAULT_DUNNING, draftReminder, overdueOn } from '../src/invoices/dunning.js';
import { openItems, orderStatus } from '../src/invoices/lists.js';
import { instalmentSheet, issuedSheet, reminderSheet } from '../src/invoices/documents.js';
import { qrBillData, sheetBlocks } from '../src/invoices/sheet.js';
import { DEFAULT_LAYOUT, isItem, type Draft, type InvoiceBook, type Issued, type Stage } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import { tempWorkspace } from './support/workspace.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { addDeductions, createCustomer, createDraft, createStageInvoice, issueInvoice, reopenDocument, sendInstalment, setStages, updateDraft, type Printer } from '../src/invoices/service.js';
import { loadInvoices } from '../src/invoices/store.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const NET_CASH: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
const NET_AGREED: VatSetup = { ...NET_CASH, reporting: 'agreed' };
const KINDS: Array<[string, VatSetup, { agreed: boolean; rates: number[] }]> = [
  ['cash, effective', EFFECTIVE_QUARTERLY, { agreed: false, rates: [8.1, 2.6] }],
  ['cash, net tax rate', NET_CASH, { agreed: false, rates: [8.1, 2.6] }],
  ['not registered', NOT_REGISTERED, { agreed: false, rates: [0, 0] }],
  ['agreed, effective', AGREED, { agreed: true, rates: [8.1, 2.6] }],
  ['agreed, net tax rate', NET_AGREED, { agreed: true, rates: [8.1, 2.6] }],
];

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Bauherrschaft Muster', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const payTo = { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' };
const sender = { name: 'Muster Schreinerei GmbH', uid: 'CHE-123.456.789', address: { street: 'Werkstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo };
const ctx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }],
  revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: (inv) => Buffer.from(`%PDF ${inv.number}`), receiptId: (pdf) => `r_${pdf.toString().slice(5)}`, indexedAt: (at) => `${at.date}T18:00:00Z`, held: () => new Set(),
};

const newBook = (): InvoiceBook => ({ schema: 5, contacts: [asContact(customer)], articles: [], invoices: [], sent: [] });
const books = (transactions: BankTransaction[] = []): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } });
const env = (id: string, date: string) => ({ id, createdAt: `${date}T08:00:00Z`, origin: 'manual' as const, deleted: false });
const draft = (id: string, date: string, lines: Draft['lines'], over: Partial<Draft> = {}): Draft => ({
  ...env(id, date), status: 'draft', kind: 'invoice', customerId: 'cu_1', date, currency: 'CHF', language: 'de', comments: [], lines, ...over,
});
function issued(book: InvoiceBook, d: Draft): Issued {
  const inv = { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices: book.invoices, now: `${d.date}T10:00:00Z` }), pdf: { file: `invoices/${d.id}.pdf`, sha256: d.id } };
  book.invoices.push(inv);
  return inv;
}
const paying = (ref: string, date: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: `Zahlung ${ref}`, counterparty: 'BAUHERRSCHAFT MUSTER', ...over });
const r2 = (n: number) => Math.round(n * 100) / 100;
const PLAN: Stage[] = [{ label: '30 % bei Auftrag', percent: 30, date: '2026-07-10' }, { label: '40 % nach Rohbau', percent: 40, date: '2026-08-20' }, { label: 'Rest' }];

/** An issued Auftrag of two positions at two rates, odd amounts, with the plan 30 % / 40 % / rest. */
function order(book: InvoiceBook, rates: number[], prices: 'net' | 'gross' = 'net'): Issued {
  return issued(book, draft('au', '2026-07-01', [
    { text: 'Küche nach Mass', quantity: 1, price: 12345.65, vatRate: rates[0], account: '3200' },
    { text: 'Montagematerial', quantity: 3, price: 333.35, vatRate: rates[1], account: '3200' },
  ], { kind: 'sales-order', prices, stages: PLAN }));
}

test('the plan adds up to the total: a gap or a surplus is named, the rest stage takes what is left', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const o = order(newBook(), [8.1, 2.6]);
  assert.equal(planGap(o, PLAN), 0);
  assert.equal(planGap(o, [{ label: 'a', percent: 30 }, { label: 'b', percent: 40 }]), Math.round(1334570 * 0.3), 'a 30 % gap of 13 345.70 net');
  assert.throws(() => checkPlan(o, [{ label: 'a', percent: 30 }, { label: 'b', percent: 80 }]), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stagesSum' && /zu viel/.test(e.message));
  assert.throws(() => checkPlan(o, [{ label: 'a', percent: 30 }, { label: 'b', amount: 5000 }]), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stagesSum' && /fehlen CHF 4’341\.99/.test(e.message));
  assert.throws(() => checkPlan(o, [{ label: 'a' }, { label: 'b', percent: 30 }]), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stages', 'only the last stage is the rest');
  assert.throws(() => checkPlan(o, [{ label: 'a', percent: 120 }, { label: 'Rest' }]), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stages');
  assert.throws(() => checkPlan(o, [{ label: 'a', amount: 20000 }, { label: 'Rest' }]), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stagesSum', 'a rest below zero is too much');
});

test('a Teilrechnung: «Akonto n gemäss Auftrag AU-…», one position per rate in proportion, to the Rappen, net or gross as the Auftrag', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  for (const prices of ['net', 'gross'] as const) {
    const book = newBook();
    const o = order(book, [8.1, 2.6], prices);
    const d = stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10');
    assert.equal(d.role, 'partial');
    assert.equal(d.stage, 0);
    assert.deepEqual(d.from, { id: 'au', kind: 'sales-order' });
    assert.equal(d.prices, prices);
    const items = d.lines.filter(isItem);
    assert.deepEqual(items.map((l) => [l.text, l.vatRate]), [[`Akonto 1 gemäss Auftrag ${o.number}: 30 % bei Auftrag (8.1 %)`, 8.1], [`Akonto 1 gemäss Auftrag ${o.number}: 30 % bei Auftrag (2.6 %)`, 2.6]]);
    // 30 % of 13 345.70 in the Auftrag's prices, split 12 345.65 : 1 000.05.
    assert.equal(r2(items.reduce((s, l) => s + l.price, 0)), 4003.71);
    assert.deepEqual(items.map((l) => l.price), [3703.70, 300.01]);
    assert.throws(() => stageDraft(o, 0, [...book.invoices, d], env('p1b', '2026-07-10'), '2026-07-10'), (e: Error) => e instanceof InvoiceRuleError && e.code === 'stageInvoiced', 'a stage is invoiced once');
  }
});

for (const [name, setup, k] of KINDS) {
  test(`P3.1 on the ${name} basis: 30 % / 40 % / rest, the Schlussrechnung lists the whole less both; the documents add up to the whole`, () => {
    setJurisdiction(ch, setup);
    const book = newBook();
    const o = order(book, k.rates);
    const whole = totals(o);
    const p1 = issued(book, stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10'));
    assert.equal(orderStatus(o, book.invoices), 'partly', 'a Teilrechnung makes the Auftrag Teilweise');
    assert.equal(Math.round(doneShare(o, book.invoices, 'invoiced') * 100), 30, '«verrechnet» counts the Akonto by value');
    const p2 = issued(book, stageDraft(o, 1, book.invoices, env('p2', '2026-08-20'), '2026-08-20'));
    const fd = finalDraft(o, book.invoices, env('fi', '2026-09-30'), '2026-09-30');
    assert.equal(fd.role, 'final');
    assert.deepEqual(fd.lines.filter(isItem).filter((l) => !l.deducts).map((l) => [l.text, l.quantity, l.ofLine]), [['Küche nach Mass', 1, 0], ['Montagematerial', 3, 1]], 'every position of the Auftrag');
    assert.deepEqual(fd.lines.filter(isItem).filter((l) => l.deducts).map((l) => l.deducts), k.rates[0] === k.rates[1] ? ['p1', 'p2'] : ['p1', 'p1', 'p2', 'p2'], 'one deduction per Teilrechnung and rate');
    const fi = issued(book, fd);
    assert.equal(orderStatus(o, book.invoices), 'done', 'the Schlussrechnung invoices every position: Erledigt');
    assert.equal(Math.round(doneShare(o, book.invoices, 'invoiced') * 100), 100);
    // Each rate: the three documents' gross and VAT are the whole's, to the Rappen.
    for (const r of whole.byRate) {
      const of = (inv: Issued) => totals(inv).byRate.find((x) => x.rate === r.rate) ?? { gross: 0, vat: 0 };
      assert.equal(r2(of(p1).gross + of(p2).gross + of(fi).gross), r.gross, `gross at ${r.rate} %`);
      assert.equal(r2(of(p1).vat + of(p2).vat + of(fi).vat), r.vat, `VAT at ${r.rate} %`);
    }
    // Its QR-bill asks for the rest.
    assert.equal(qrBillData(issuedSheet(book, fi), payTo.qrIban).amount, r2(whole.gross - totals(p1).gross - totals(p2).gross));
    assert.match(sheetBlocks(issuedSheet(book, fi)).map((b) => b.html).join(''), new RegExp(`Schlussrechnung ${fi.number}.*abzüglich Teilrechnung ${p1.number} vom 10\\.07\\.2026`));

    const b = books([
      paying('P1', '2026-07-20', totals(p1).gross, { reference: p1.reference }),
      paying('P2', '2026-08-30', totals(p2).gross, { reference: p2.reference }),
      paying('P3', '2026-10-15', totals(fi).gross, { reference: fi.reference }),
    ]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    assert.deepEqual([p1, p2, fi].map((i) => status(book.invoices.find((x) => x.id === i.id)!, book.invoices)), ['paid', 'paid', 'paid']);
    // The revenue by code: the three events on the agreed basis, the three payments on the cash basis.
    const revenue = new Map<string, number>();
    for (const e of b.journalEntries.filter((x) => x.accountCredit === '3200')) revenue.set(e.vatCode ?? '', r2((revenue.get(e.vatCode ?? '') ?? 0) + e.amount));
    const refs = new Set(b.journalEntries.filter((x) => x.accountCredit === '3200').map((e) => e.transactionRef));
    assert.deepEqual([...refs].sort(), k.agreed ? [p1.number, p2.number, fi.number].map((n) => `RE-${n.replace(/^RE-/, '')}`).sort() : ['P1', 'P2', 'P3']);
    const byCode = [...revenue.values()].reduce((s, x) => s + x, 0);
    assert.equal(r2(byCode), whole.gross, 'the revenue is the whole');
    // On the net tax rate method both rates book F1 (the statutory rates print, the firm's rate is owed): one code.
    if (setup.registered && setup.method === 'effective') assert.deepEqual([...revenue.values()].sort((x, y) => y - x), whole.byRate.map((r) => r.gross).sort((x, y) => y - x), 'per rate, to the Rappen');
  });
}

test('P3.2 a Schlussrechnung while an Akonto is unpaid: it deducts what was invoiced, the Akonto stays open on its own, nothing is counted twice', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  const o = order(book, [8.1, 8.1]);
  const whole = totals(o).gross;
  const p1 = issued(book, stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10'));
  const p2 = issued(book, stageDraft(o, 1, book.invoices, env('p2', '2026-08-20'), '2026-08-20'));
  const b = books([paying('P1', '2026-07-20', totals(p1).gross, { reference: p1.reference })]);
  bookInvoiceEvents(b, book, ctx);
  matchPayments(b, book, ctx);
  const fi = issued(book, finalDraft(o, book.invoices, env('fi', '2026-09-30'), '2026-09-30'));
  assert.equal(totals(fi).gross, r2(whole - totals(p1).gross - totals(p2).gross), 'the unpaid Akonto is deducted too: what was invoiced');
  assert.equal(openAmount(book.invoices.find((x) => x.id === 'p2')!, book.invoices), totals(p2).gross, 'the unpaid Teilrechnung stays open on its own');
  const open = openItems(book.invoices, '2026-10-01');
  assert.deepEqual(open.map((x) => x.inv.id), ['p2', 'fi']);
  assert.equal(r2(open.reduce((s, x) => s + x.open, 0)), r2(whole - totals(p1).gross), 'what is open is the whole less what was paid, once');
  bookInvoiceEvents(b, book, ctx);
  const receivable = b.journalEntries.reduce((s, e) => s + (e.accountDebit === '1100' ? e.amount : 0) - (e.accountCredit === '1100' ? e.amount : 0), 0);
  assert.equal(r2(receivable), r2(whole - totals(p1).gross), 'the books hold the same receivable');
  // A second Schlussrechnung is refused; «Akontos abziehen» offers nothing a Schlussrechnung deducts already.
  assert.throws(() => finalDraft(o, book.invoices, env('fi2', '2026-10-01'), '2026-10-01'), (e: Error) => e instanceof InvoiceRuleError && e.code === 'finalExists');
  assert.deepEqual(deductible(draft('x', '2026-10-01', [], { role: 'final' }), book.invoices), []);
});

test('a Teilrechnung without an Auftrag: an ordinary Rechnung marked partial, deducted by «Akontos abziehen» on a final draft of the contact', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [{ text: 'Anzahlung Umbau', quantity: 1, price: 5000, vatRate: 8.1 }], { role: 'partial' }));
  const fin = draft('f', '2026-09-30', [{ text: 'Umbau', quantity: 1, price: 20000, vatRate: 8.1 }], { role: 'final' });
  assert.deepEqual(deductible(fin, book.invoices).map((x) => x.id), ['a']);
  assert.throws(() => withDeductions({ ...fin, role: undefined }, ['a'], book.invoices), (e: Error) => e instanceof InvoiceRuleError && e.code === 'notFinal');
  const done = withDeductions(fin, ['a'], book.invoices);
  const t = totals(done);
  assert.equal(t.gross, r2(21620 - 5405));
  assert.equal(t.vat, r2(1620 - 405), 'the VAT is the whole\'s less the Akonto\'s');
  assert.deepEqual(deductible(done, [...book.invoices, done]), [], 'deducted once');
});

test('P3.3 Rückbehalt 5 %: the QR-bill asks for 95 %, the payment of 95 % is matched, the retention is a fact on its day, the instalment notice pays the rest by the same reference', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const inv = issued(book, draft('r', '2026-07-10', [{ text: 'Schlussrechnung Küche', quantity: 1, price: 20000, vatRate: 8.1 }], { schedule: { retention: { percent: 5, until: '2027-06-30' } } }));
  const gross = totals(inv).gross;
  assert.equal(retentionOf(inv), 1081);
  assert.equal(payableAtIssue(inv), 20539);
  assert.equal(qrBillData(issuedSheet(book, inv), payTo.qrIban).amount, 20539, 'the QR-bill asks for the total less the retention');
  assert.match(sheetBlocks(issuedSheet(book, inv)).map((b) => b.html).join(''), /Rückbehalt 5 % bis 30\.06\.2027.*−1’081\.00.*Zu zahlen CHF.*20’539\.00/);
  // The payment of what the QR-bill asked, by the number without its reference: matched as the Rechnung's.
  const b = books([paying('P1', '2026-08-05', 20539, { description: `Rechnung ${inv.number}` })]);
  matchPayments(b, book, ctx);
  const after = book.invoices.find((x) => x.id === 'r') as Issued;
  assert.deepEqual(after.payments.map((p) => [p.amount, p.by]), [[20539, 'number']]);
  assert.equal(openAmount(after, book.invoices), 1081);
  assert.equal(isOverdue(after, book.invoices, '2026-12-01'), false, 'past its due date only the retention is open: not overdue before its day');
  assert.equal(overdueOn(after, book.invoices, '2026-12-01'), false, 'nor in the Mahnlauf');
  assert.equal(dueFor(after, 1081), '2027-06-30');
  assert.equal(retentionDue(after, book.invoices, '2027-06-29'), undefined);
  assert.deepEqual(retentionDue(after, book.invoices, '2027-07-02'), { until: '2027-06-30', open: 1081 }, '«Rückbehalt fällig seit 30.06.2027»');
  assert.equal(isOverdue(after, book.invoices, '2027-07-02'), true);
  const item = openItems(book.invoices, '2027-07-02')[0];
  assert.deepEqual([item.due, item.overdue, item.band], ['2027-06-30', 2, '1-30'], 'Offene Posten counts from the retention\'s day');
  // The instalment notice: its own QR-bill for what is open, the same reference.
  const sheet = instalmentSheet(book, after, { date: '2027-07-02' });
  assert.equal(sheet.reference, inv.reference);
  assert.equal(qrBillData(sheet, payTo.qrIban).amount, 1081);
  assert.match(sheetBlocks(sheet).map((x) => x.html).join(''), new RegExp(`Zahlungsaufforderung · Rechnung ${inv.number}`));
  b.transactions.push(paying('P2', '2027-07-10', 1081, { reference: inv.reference }));
  matchPayments(b, book, ctx);
  const paid = book.invoices.find((x) => x.id === 'r') as Issued;
  assert.equal(status(paid, book.invoices), 'paid');
  assert.equal(r2(paid.payments.reduce((s, p) => s + p.amount, 0)), gross);
});

test('the plan as the Auftrag shows it: each stage with what it planned and what its document invoiced', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const o = order(book, [8.1, 8.1]);
  issued(book, stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10'));
  const s = stageStates(o, book.invoices);
  assert.deepEqual(s.map((x) => [x.planned, x.doc?.id, x.invoiced, x.last]), [[4003.71, 'p1', r2(4003.71 * 1.081), false], [5338.28, undefined, 0, false], [4003.71, undefined, 0, true]]);
});

// ─── the workflow on a workspace (src/invoices/service.ts) ───────────────────

const PDF = Buffer.from('%PDF-1.4 stand-in');
const printer: Printer = {
  pdf: async (d) => ({ html: '', pages: 1, pdf: Buffer.concat([PDF, Buffer.from(` ${d.kind} ${d.number ?? ''} ${d.instalment ? 'instalment' : ''} ${Math.random()}`)]) }),
  html: async () => ({ html: '', pages: 1 }),
};
const CUSTOMER = { name: 'Bauherrschaft Muster', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
const refusal = (code: string) => (e: Error) => e instanceof InvoiceRuleError && e.code === code;

test('the plan on a workspace: kept on the issued Auftrag, each stage a Teilrechnung draft, the last the Schlussrechnung; a changed total warns while Teilrechnungen stand', async () => {
  const ws = workspaceAt(tempWorkspace('stages-').paths.root);
  const c = createCustomer(ws, CUSTOMER);
  const d = createDraft(ws, { customerId: c.id, kind: 'sales-order', date: '2026-11-02', lines: [{ text: 'Küche', quantity: 1, price: 30000, vatRate: 8.1 }] }, '2026-11-02T08:00:00Z');
  const o = await issueInvoice(ws, d.id, { now: '2026-11-02T09:00:00Z', printer });
  assert.throws(() => setStages(ws, o.id, [{ label: '30 %', percent: 30 }, { label: '40 %', percent: 40 }]), refusal('stagesSum'));
  setStages(ws, o.id, PLAN);
  assert.deepEqual(loadInvoices(ws).invoices.find((x) => x.id === o.id)!.stages, PLAN, 'kept on the issued Auftrag');
  const p1 = createStageInvoice(ws, o.id, 0, [], '2026-11-03T08:00:00Z');
  assert.equal(p1.role, 'partial');
  // The final stage while a Teilrechnung is a draft: a warning, it would not be deducted.
  assert.throws(() => createStageInvoice(ws, o.id, 2, [], '2026-11-03T08:00:00Z'), refusal('partialDrafts'));
  const i1 = await issueInvoice(ws, p1.id, { now: '2026-11-03T09:00:00Z', printer });
  assert.equal(loadInvoices(ws).sent.length, 0);
  // An invoiced stage stays as it is; a later one may change.
  assert.throws(() => setStages(ws, o.id, [{ label: '20 %', percent: 20 }, { label: '50 %', percent: 50 }, { label: 'Rest' }]), refusal('stageInvoiced'));
  setStages(ws, o.id, [PLAN[0], { label: '50 % nach Rohbau', percent: 50 }, { label: 'Rest' }]);
  // Back to draft with a Teilrechnung standing; its total changes only with «Trotzdem ändern».
  const back = reopenDocument(ws, o.id, true);
  assert.equal(back.status, 'draft');
  assert.throws(() => updateDraft(ws, o.id, { lines: [{ text: 'Küche', quantity: 1, price: 32000, vatRate: 8.1 }] }), (e: Error) => refusal('stagesInvoiced')(e) && e.message.includes(`Eine Teilrechnung über CHF 9’729.00 ausgestellt (${i1.number})`));
  updateDraft(ws, o.id, { subject: 'Küche Muster' });
  updateDraft(ws, o.id, { lines: [{ text: 'Küche', quantity: 1, price: 32000, vatRate: 8.1 }] }, ['stagesInvoiced']);
  const o2 = await issueInvoice(ws, o.id, { now: '2026-11-04T09:00:00Z', printer });
  assert.equal(o2.number, o.number, 'its number kept');
  const fin = createStageInvoice(ws, o.id, 'final', [], '2026-11-20T08:00:00Z');
  assert.equal(fin.role, 'final');
  const f = await issueInvoice(ws, fin.id, { now: '2026-11-20T09:00:00Z', printer });
  assert.equal(totals(f).gross, r2(32000 * 1.081 - 9729), 'the new total less what was invoiced');
  assert.throws(() => createStageInvoice(ws, o.id, 'final', [], '2026-11-21T08:00:00Z'), refusal('finalExists'));
});

test('«Akontos abziehen» and the Zahlungsaufforderung on a workspace: the instalment goes to the sent log, nothing more', async () => {
  const ws = workspaceAt(tempWorkspace('stages-').paths.root);
  const c = createCustomer(ws, CUSTOMER);
  const a = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-11-02', role: 'partial', lines: [{ text: 'Anzahlung', quantity: 1, price: 1000, vatRate: 8.1 }] }, '2026-11-02T08:00:00Z').id, { now: '2026-11-02T09:00:00Z', printer });
  const fin = createDraft(ws, { customerId: c.id, date: '2026-11-10', role: 'final', schedule: { retention: { percent: 5, until: '2027-06-30' } }, lines: [{ text: 'Umbau', quantity: 1, price: 4000, vatRate: 8.1 }] }, '2026-11-10T08:00:00Z');
  const withA = addDeductions(ws, fin.id, [a.id]);
  assert.deepEqual(withA.lines.filter(isItem).map((l) => [l.price, l.deducts, l.deductedVat]), [[4000, undefined, undefined], [-1000, a.id, 81]]);
  assert.throws(() => addDeductions(ws, fin.id, [a.id]), refusal('incomplete'), 'deducted once');
  const f = await issueInvoice(ws, fin.id, { now: '2026-11-10T09:00:00Z', printer });
  assert.equal(totals(f).gross, 3243);
  assert.equal(retentionOf(f), 162.15);
  await assert.rejects(sendInstalment(ws, a.id, {}, { printer }), refusal('noRetention'));
  const sent = await sendInstalment(ws, f.id, { date: '2027-07-01', to: 'download' }, { now: '2027-07-01T08:00:00Z', printer });
  assert.equal(sent.kind, 'instalment');
  assert.equal(sent.title, `Zahlungsaufforderung · Schlussrechnung ${f.number}`);
  assert.deepEqual(loadInvoices(ws).sent.map((x) => x.kind), ['instalment']);
});

// ─── the review of #613: each probe a test ───────────────────────────────────

test('percent plans that add up to 100 add up to the total to the cent, whatever the total', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  for (const [price, plan] of [[100.01, [50, 50]], [1000.01, [50, 50]], [100.01, [33.33, 33.33, 33.34]], [999.99, [25, 25, 25, 25]], [1234.55, [30, 30, 40]], [100.03, Array(10).fill(10)]] as Array<[number, number[]]>) {
    const o = { kind: 'sales-order' as const, currency: 'CHF' as const, lines: [{ text: 'x', quantity: 1, price, vatRate: 8.1 }] };
    const stages = plan.map((p, k) => ({ label: `s${k}`, percent: p }));
    assert.doesNotThrow(() => checkPlan(o, stages), `${plan.join('/')} on ${price}`);
    assert.equal(planGap(o, stages), 0);
  }
});

test('a deducted Akonto stands: no Storno, no back to draft; credited in full it is not deductible, credited in part it deducts what is left', () => {
  setJurisdiction(ch, AGREED);
  const book = newBook();
  const o = issued(book, draft('au', '2026-07-01', [{ text: 'Arbeit', quantity: 1, price: 10000, vatRate: 8.1 }], { kind: 'sales-order', stages: [{ label: 'a', percent: 50 }, { label: 'Rest' }] }));
  const p1 = issued(book, stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10'));
  // A Gutschrift of 1000 net on the Akonto: the Schlussrechnung deducts 4000 net and its VAT.
  issued(book, draft('cn', '2026-07-20', [{ text: 'Teilgutschrift', quantity: 1, price: -1000, vatRate: 8.1 }], { kind: 'credit-note', creditFor: 'p1' }));
  const fd = finalDraft(o, book.invoices, env('fi', '2026-09-30'), '2026-09-30');
  assert.equal(totals({ lines: fd.lines.filter((l) => isItem(l) && !!l.deducts), prices: fd.prices }).gross, -4324, 'invoiced less credited');
  const fi = issued(book, fd);
  assert.equal(totals(fi).gross, r2(10810 - 4324));
  assert.throws(() => cancel(p1, { date: '2026-10-05', reason: 'x', invoices: book.invoices }), (e: Error) => e instanceof InvoiceRuleError && e.code === 'deducted');
  assert.equal(backToDraftRefusal(p1, book.invoices, []), 'settled', 'credited: settled already');
  const p2 = issued(book, draft('p2', '2026-07-11', [{ text: 'Anzahlung', quantity: 1, price: 2000, vatRate: 8.1 }], { role: 'partial' }));
  const f2 = issued(book, withDeductions(draft('f2', '2026-09-30', [{ text: 'Umbau', quantity: 1, price: 9000, vatRate: 8.1 }], { role: 'final' }), [p2.id], book.invoices));
  assert.equal(backToDraftRefusal(p2, book.invoices, []), 'deducted');
  // The Schlussrechnung credited in full frees its Akonto, and its credit note deducts nothing.
  issued(book, creditNoteDraft(f2, { reason: 'falsch' }, env('cn2', '2026-10-01'), '2026-10-01'));
  assert.deepEqual(deductible(draft('x', '2026-10-06', [], { role: 'final' }), book.invoices).map((x) => x.id), ['p2']);
  assert.doesNotThrow(() => cancel(p2, { date: '2026-10-07', reason: 'x', invoices: book.invoices }));
  // An Akonto credited in full is not deductible.
  issued(book, creditNoteDraft(p2, { reason: 'zurück' }, env('cn3', '2026-10-08'), '2026-10-08'));
  assert.deepEqual(deductible(draft('y', '2026-10-09', [], { role: 'final' }), book.invoices).map((x) => x.id), []);
});

test('at issue every deduction is checked: a made-up one, a copy and a second deduction of an Akonto are refused (`deduction`)', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const a = issued(book, draft('a', '2026-07-10', [{ text: 'Anzahlung', quantity: 1, price: 5000, vatRate: 8.1 }], { role: 'partial' }));
  const fin = withDeductions(draft('f', '2026-09-30', [{ text: 'Umbau', quantity: 1, price: 20000, vatRate: 8.1 }], { role: 'final' }), ['a'], book.invoices);
  assert.doesNotThrow(() => checkDeductions(fin, book.invoices));
  const isDeduction = (e: Error) => e instanceof InvoiceRuleError && e.code === 'deduction';
  assert.throws(() => checkDeductions({ ...fin, lines: fin.lines.map((l) => (isItem(l) && l.deducts ? { ...l, deductedVat: 1620 } : l)) }, book.invoices), isDeduction, 'a VAT not the Akonto\'s');
  assert.throws(() => checkDeductions({ ...fin, lines: [...fin.lines, { text: 'abzgl.', quantity: 1, price: -1, vatRate: 8.1, deducts: 'nope', deductedVat: 0 }] }, book.invoices), isDeduction, 'a Teilrechnung that is not there');
  assert.throws(() => checkDeductions({ ...fin, role: undefined }, book.invoices), isDeduction, 'a copy without the role');
  issued(book, fin);
  assert.throws(() => checkDeductions({ ...fin, id: 'f3' }, book.invoices), isDeduction, 'another Schlussrechnung deducts it');
  void a;
});

test('a Schlussrechnung with a rate below zero books no negative amount: the minus code the other way round, on both bases; the per-code figures are the documents\'', () => {
  for (const setup of [AGREED, EFFECTIVE_QUARTERLY]) {
    setJurisdiction(ch, setup);
    const book = newBook();
    const o = issued(book, draft('au', '2026-07-01', [{ text: 'Arbeit', quantity: 1, price: 10000, vatRate: 8.1 }, { text: 'Bücher', quantity: 1, price: 1000, vatRate: 2.6 }], { kind: 'sales-order', stages: [{ label: 'a', percent: 50 }, { label: 'Rest' }] }));
    const p1 = issued(book, stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10'));
    const fd = finalDraft(o, book.invoices, env('fi', '2026-09-30'), '2026-09-30');
    fd.lines = fd.lines.map((l) => (isItem(l) && l.text === 'Bücher' ? { ...l, price: 300 } : l));
    const fi = issued(book, fd);
    const at26 = totals(fi).byRate.find((r) => r.rate === 2.6)!;
    assert.ok(at26.gross < 0, 'the books were delivered for less than the Akonto asked');
    const b = books([paying('P1', '2026-07-20', totals(p1).gross, { reference: p1.reference }), paying('P3', '2026-10-15', totals(fi).gross, { reference: fi.reference })]);
    bookInvoiceEvents(b, book, ctx);
    matchPayments(b, book, ctx);
    assert.ok(b.journalEntries.every((e) => e.amount > 0), 'no negative amount');
    // The revenue at 2.6 % of both documents, signed by its code: what they invoiced together.
    const v26 = b.journalEntries.filter((e) => /V26/.test(e.vatCode ?? '')).reduce((t, e) => t + (e.vatCode!.startsWith('-') ? -e.amount : e.amount), 0);
    assert.equal(r2(v26), r2(totals(p1).byRate.find((r) => r.rate === 2.6)!.gross + at26.gross), `${setup.registered ? setup.reporting : "none"}: per code`);
  }
});

test('a Skonto never takes the retention; the Skonto line pays what the payment slip asks less the Skonto', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const inv = { ...issued(book, draft('r', '2026-07-10', [{ text: 'Küche', quantity: 1, price: 20000, vatRate: 8.1 }], { schedule: { retention: { percent: 2, until: '2027-06-30' } } })), terms: { id: 't', name: '2 % 10 Tage', days: 30, skonto: { percent: 2, days: 10 }, text: '2 % 10 Tage' } };
  book.invoices[book.invoices.length - 1] = inv;
  const qr = payableAtIssue(inv);
  assert.equal(qr, 21187.6);
  assert.equal(skontoOffer(inv)!.pays, r2(qr - r2(qr * 0.02)), '«pays» is the slip less its Skonto');
  assert.equal(skontoOf(inv, book.invoices, qr, '2026-07-15'), undefined, 'the slip paid is the retention case, not Skonto');
  assert.equal(skontoOf(inv, book.invoices, skontoOffer(inv)!.pays, '2026-07-15'), r2(qr * 0.02), 'the Skonto of what is due now');
  const b = books([paying('P1', '2026-07-15', qr, { reference: inv.reference })]);
  matchPayments(b, book, ctx);
  const after = book.invoices.find((x) => x.id === 'r') as Issued;
  assert.deepEqual([after.writeOffs ?? [], openAmount(after, book.invoices)], [[], 432.4], 'the retention stays open, nothing written off');
});

test('before its day a reminder asks for what is due and names the retention; the Zahlungsaufforderung only from its day, for the retention, naming the rest', async () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const book = newBook();
  const inv = issued(book, draft('r', '2026-07-10', [{ text: 'Küche', quantity: 1, price: 20000, vatRate: 8.1 }], { schedule: { retention: { percent: 5, until: '2027-06-30' } } }));
  const sheet = reminderSheet(book, inv, draftReminder(inv, book.invoices, '2026-09-01', DEFAULT_DUNNING));
  assert.equal(qrBillData(sheet, payTo.qrIban).amount, 20539, 'a reminder asks what the slip asked');
  assert.match(sheetBlocks(sheet).map((x) => x.html).join(''), /Rückbehalt 5 % bis 30\.06\.2027/);
  assert.equal(instalmentDue(inv, book.invoices, '2027-06-29'), undefined, 'not before its day');
  assert.deepEqual(instalmentDue(inv, book.invoices, '2027-06-30'), { amount: 1081, until: '2027-06-30', more: 20539 });
  const ins = instalmentSheet(book, inv, { date: '2027-07-01' });
  assert.equal(qrBillData(ins, payTo.qrIban).amount, 1081, 'the retention, not all that is open');
  assert.match(ins.intro, /Ausserdem sind aus der Rechnung noch CHF 20’539\.00 offen/);
  const ws = workspaceAt(tempWorkspace('stages-').paths.root);
  const c = createCustomer(ws, CUSTOMER);
  const r = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-11-02', schedule: { retention: { percent: 5, until: '2027-06-30' } }, lines: [{ text: 'Küche', quantity: 1, price: 1000, vatRate: 8.1 }] }, '2026-11-02T08:00:00Z').id, { now: '2026-11-02T09:00:00Z', printer });
  await assert.rejects(sendInstalment(ws, r.id, { date: '2026-12-01' }, { printer }), refusal('retentionNotDue'));
});

test('a retention needs its day after the invoice date; a Schlussrechnung the Teilrechnungen exceed is refused with its own words; a split keeps a take-back negative', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const fields = (d: Draft) => missingForIssue(d, { customer, sender, invoices: [] }).map((m) => m.field);
  assert.ok(fields(draft('r', '2026-07-10', [{ text: 'x', quantity: 1, price: 100, vatRate: 8.1 }], { schedule: { retention: { percent: 5, until: '2026-07-10' } } })).includes('retention.until'));
  assert.ok(fields(draft('f', '2026-07-10', [{ text: 'x', quantity: 1, price: 100, vatRate: 8.1 }, { text: 'abzgl.', quantity: 1, price: -200, vatRate: 8.1, deducts: 'p', deductedVat: 16.2 }], { role: 'final' })).includes('final.total'));
  const book = newBook();
  const o = issued(book, draft('au', '2026-07-01', [{ text: 'Arbeit', quantity: 1, price: 1000, vatRate: 8.1 }, { text: 'Rücknahme Altgerät', quantity: 1, price: -100, vatRate: 0 }], { kind: 'sales-order', exemption: 'export', stages: [{ label: 'a', percent: 50 }, { label: 'Rest' }] }));
  assert.deepEqual(stageDraft(o, 0, book.invoices, env('p1', '2026-07-10'), '2026-07-10').lines.filter(isItem).map((l) => [l.price, l.vatRate]), [[500, 8.1], [-50, 0]]);
});

test('a reduced fuzz: Akonto, Akonto, Schluss in every setup add up per rate to the cent and book no negative amount', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const NET2: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'A', activityId: '1' }, { rate: 2.1, label: 'B', activityId: '2' }] };
  const setups: Array<[VatSetup, number[]]> = [[EFFECTIVE_QUARTERLY, [8.1, 2.6, 3.8, 0]], [AGREED, [8.1, 2.6, 3.8, 0]], [NET2, [8.1, 2.6]], [{ ...NET2, reporting: 'agreed' }, [8.1, 2.6]], [NOT_REGISTERED, [0]]];
  let n = 0;
  for (const [setup, rates] of setups) {
    setJurisdiction(ch, setup);
    for (let i = 0; i < 40; i++) {
      const book = newBook();
      const lines: Draft['lines'] = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => ({
        text: `P${k}`, quantity: pick([1, 2, 0.5, 7.25]), price: r2(5 + rnd() * 3000), vatRate: pick(rates),
        ...(rnd() < 0.3 ? { account: '3400' } : {}), ...(setup.registered && setup.method === 'net-rate' && rnd() < 0.4 ? { activity: 2 as const } : {}),
      }));
      if (rnd() < 0.4) lines.push({ kind: 'discount', text: 'Rabatt', percent: pick([3, 12.5]) });
      const stages: Stage[] = pick([[{ label: 'a', percent: 30 }, { label: 'b', percent: 40 }, { label: 'Rest' }], [{ label: 'a', percent: 33.33 }, { label: 'b', percent: 66.67 }], [{ label: 'a', percent: 17.5 }, { label: 'Rest' }]]);
      const o = issued(book, draft('au', '2026-07-01', lines, { kind: 'sales-order', prices: pick(['net', 'gross'] as const), stages, ...(lines.some((l) => isItem(l) && l.vatRate === 0) && setup.registered ? { exemption: 'export' as const } : {}) }));
      const docs: Issued[] = [];
      for (let k = 0; k < stages.length - 1; k++) docs.push(issued(book, stageDraft(o, k, book.invoices, env(`p${k}`, `2026-07-1${k}`), `2026-07-1${k}`)));
      docs.push(issued(book, finalDraft(o, book.invoices, env('fi', '2026-09-30'), '2026-09-30')));
      for (const r of totals(o).byRate) {
        const of = (x: Issued) => totals(x).byRate.find((y) => y.rate === r.rate) ?? { gross: 0, vat: 0 };
        assert.deepEqual([r2(docs.reduce((t, x) => t + of(x).gross, 0)), r2(docs.reduce((t, x) => t + of(x).vat, 0))], [r.gross, r.vat]);
      }
      const b = books(docs.map((x, k) => paying(`T${k}`, `2026-10-1${k}`, totals(x).gross, { reference: x.reference })));
      bookInvoiceEvents(b, book, ctx);
      matchPayments(b, book, ctx);
      assert.ok(b.journalEntries.every((e) => e.amount > 0));
      n++;
    }
  }
  assert.equal(n, 200);
});
