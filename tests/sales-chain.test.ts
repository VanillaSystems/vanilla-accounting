/**
 * Invoicing phase 2 (docs/specs/invoicing.md 4.4.1, 4.4.2, 4.4.4, 5 «Phase 2»): Angebot, Auftrag and
 * Lieferschein on the one record shape, their conversions with the quantities still open, the
 * statuses from facts, optional positions, the Belegkette, and a number series per kind. Checkpoints
 * P2.1, P2.2, P2.3, P2.6 and P2.8 are walked through the invoicing service on a temp workspace, its
 * PDFs printed by a stand-in printer (the sheet is checked as HTML).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import './support/jurisdiction.js';
import { tempWorkspace } from './support/workspace.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import {
  answerQuote, cancelInvoice, convertDocument, createCreditNote, createCustomer, createDraft, issueInvoice, recordSend, reopenDocument, updateDraft, type Printer,
} from '../src/invoices/service.js';
import { loadInvoices } from '../src/invoices/store.js';
import { InvoiceRuleError, issue, liveDocuments, liveInvoices, namedInvoice, optionsOf, totals } from '../src/invoices/rules.js';
import { chainOf, offered, positions } from '../src/invoices/chain.js';
import { deliveryStatus, orderStatus, quoteStatus } from '../src/invoices/lists.js';
import { issuedSheet } from '../src/invoices/documents.js';
import { qrBillData, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { DEFAULT_NUMBERING, LEGACY_NUMBERING, counterOf, formatNumber, nextNumberFor } from '../src/invoices/numbering.js';
import { formatFits, numberingFits, parseReference, qrReference, referenceFor, scorReference } from '../src/providers/qr-bill/reference.js';
import { docRef, eventRef, writeOffRef } from '../src/books/refs.js';
import { DEFAULT_LAYOUT, type Draft, type Invoice, type Issued } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';

const PDF = Buffer.from('%PDF-1.4 stand-in');
/** Prints nothing: every sheet is one page with the same bytes, the last sheet kept to look at. */
const seen: SheetData[] = [];
const printer: Printer = {
  pdf: async (d) => { seen.push(d); return { html: '', pages: 1, pdf: Buffer.concat([PDF, Buffer.from(` ${d.kind} ${d.number ?? ''} ${seen.length}`)]) }; },
  html: async () => ({ html: '', pages: 1 }),
};

const CUSTOMER = { name: 'Fassaden Muster AG', address: { street: 'Bahnhofstrasse', number: '1', postcode: '8001', town: 'Zürich', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };

/** A workspace with the demo's invoicing; `fresh`: as a new firm has it, without number formats (the defaults). */
function workspace(fresh = false): Workspace {
  const ws = tempWorkspace('sales-chain-');
  if (fresh) writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^ {2}numbering:\n( {4}.*\n)+/m, ''));
  return workspaceAt(ws.paths.root);
}

const item = (text: string, quantity: number, price: number, over: Record<string, unknown> = {}) => ({ text, quantity, price, vatRate: 8.1, unit: 'pcs', ...over });

async function issued(ws: Workspace, d: Draft, at: string): Promise<Issued> {
  return issueInvoice(ws, d.id, { now: at, printer });
}

const find = (ws: Workspace, id: string) => loadInvoices(ws).invoices.find((i) => i.id === id)!;

test('P2.1 an Angebot: its own number AN-…, a PDF, no payment reference, «Angenommen» by the person\'s click; nothing is booked or paid', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const draft = createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [item('Fassade reinigen', 120, 18, { unit: 'm2' })] }, '2026-11-02T08:00:00Z');
  assert.equal(draft.validUntil, '2026-12-02', 'an Angebot holds 30 days');
  const q = await issued(ws, draft, '2026-11-02T09:00:00Z');
  assert.equal(q.number, 'AN-2026-00001');
  assert.equal(q.reference, '', 'an Angebot is not paid');
  assert.equal(seen.at(-1)!.kind, 'quote');
  const html = sheetBlocks(issuedSheet(loadInvoices(ws), q)).map((b) => b.html).join('');
  assert.match(html, /Angebot AN-2026-00001/);
  assert.match(html, /gültig bis 02\.12\.2026/);
  assert.equal(quoteStatus(q, liveDocuments(loadInvoices(ws)), '2026-11-03'), 'open');
  await recordSend(ws, q.id, { to: 'download', now: '2026-11-02T10:00:00Z' });
  assert.equal(loadInvoices(ws).sent.at(-1)!.kind, 'quote');

  const yes = answerQuote(ws, q.id, 'accepted', 'Anna Muster', '2026-11-04');
  assert.deepEqual(yes.accepted, { date: '2026-11-04', by: 'Anna Muster' });
  assert.equal(quoteStatus(yes, liveDocuments(loadInvoices(ws)), '2027-01-10'), 'accepted', 'accepted stays accepted after its day');
  // A Rechnung of the book: never the Angebot; a payment naming its number pays nothing.
  assert.deepEqual(liveInvoices(loadInvoices(ws)).map((i) => i.id), []);
  assert.equal(namedInvoice({ description: 'Zahlung AN-2026-00001', reference: undefined, counterparty: '', parts: [] }, loadInvoices(ws).invoices), undefined);
  assert.throws(() => answerQuote(ws, (createDraft(ws, { customerId: c.id }) as Draft).id, 'accepted', 'x', '2026-11-04'), (e: Error) => e instanceof InvoiceRuleError && e.code === 'notQuote');
});

test('P2.2 Angebot → Auftrag → two Lieferscheine (6 and 4 of 10) → Rechnung: each step one conversion with what is open; Teilweise, then Erledigt; one chain from each document; the Lieferschein prints no prices; only the Rechnung is booked', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [{ kind: 'text', text: 'Fassade', style: 'title' }, item('Dämmplatten', 10, 45)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');

  const toOrder = offered(q, 'sales-order', liveDocuments(loadInvoices(ws)));
  assert.deepEqual(toOrder.map((o) => [o.line, o.open, o.ticked]), [[1, 10, true]]);
  const orderDraft = convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 1, quantity: 10 }] }, '2026-11-05T08:00:00Z');
  assert.deepEqual(orderDraft.from, { id: q.id, kind: 'quote' });
  assert.deepEqual(orderDraft.lines.map((l) => l.kind ?? 'item'), ['text', 'item'], 'the title comes along');
  assert.equal(quoteStatus(find(ws, q.id), liveDocuments(loadInvoices(ws)), '2026-11-05'), 'accepted', 'a conversion accepts the Angebot as a fact');
  const order = await issued(ws, orderDraft, '2026-11-05T09:00:00Z');
  assert.equal(order.number, 'AU-2026-00001');
  const docs = () => liveDocuments(loadInvoices(ws));
  assert.equal(orderStatus(order, docs()), 'open');

  const first = await issued(ws, convertDocument(ws, order.id, { to: 'delivery-note', lines: [{ line: 1, quantity: 6 }] }, '2026-11-10T08:00:00Z'), '2026-11-10T09:00:00Z');
  assert.equal(first.number, 'LS-2026-00001');
  assert.equal(orderStatus(find(ws, order.id), docs()), 'partly', 'Teilweise after the first Lieferschein');
  assert.deepEqual(offered(find(ws, order.id), 'delivery-note', docs()).map((o) => o.open), [4], 'the next Lieferschein offers the rest');
  const second = await issued(ws, convertDocument(ws, order.id, { to: 'delivery-note', lines: [{ line: 1, quantity: 4 }] }, '2026-11-12T08:00:00Z'), '2026-11-12T09:00:00Z');
  assert.equal(deliveryStatus(second), 'done');
  assert.deepEqual(positions(find(ws, order.id), docs()).map((p) => [p.delivered, p.invoiced]), [[10, 0]]);
  assert.equal(orderStatus(find(ws, order.id), docs()), 'partly', 'delivered, not yet invoiced');

  assert.deepEqual(offered(find(ws, order.id), 'invoice', docs()).map((o) => o.open), [10], 'what is open to invoice counts apart from what was delivered');
  const inv = await issued(ws, convertDocument(ws, order.id, { to: 'invoice', lines: [{ line: 1, quantity: 10 }] }, '2026-11-15T08:00:00Z'), '2026-11-15T09:00:00Z');
  assert.equal(inv.number, '2026-001', 'the invoice continues the series the demo had');
  assert.match(inv.reference, /^\d{27}$/);
  assert.equal(orderStatus(find(ws, order.id), docs()), 'done', 'Erledigt after the Rechnung');

  // The same chain from each document, the one looked at marked.
  const ids = (d: Invoice) => chainOf(d, docs()).map((s) => `${s.depth}:${s.doc.status === 'issued' ? s.doc.number : 'draft'}${s.current ? '*' : ''}`);
  assert.deepEqual(ids(find(ws, q.id)), ['0:AN-2026-00001*', '1:AU-2026-00001', '2:LS-2026-00001', '2:LS-2026-00002', '2:2026-001']);
  for (const d of [order, first, second, inv]) assert.deepEqual(chainOf(find(ws, d.id), docs()).map((s) => s.doc.id), chainOf(q, docs()).map((s) => s.doc.id));
  assert.ok(ids(find(ws, first.id)).includes('2:LS-2026-00001*'));

  // A Lieferschein prints what was delivered, never a price or a total.
  const ls = sheetBlocks(issuedSheet(loadInvoices(ws), find(ws, first.id) as Issued)).map((b) => b.html).join('');
  assert.match(ls, /Lieferschein LS-2026-00001/);
  assert.match(ls, /Dämmplatten/);
  assert.doesNotMatch(ls, /Preis|Betrag|Total|45\.00|270\.00/);
  // Only the Rechnung is a claim of the books.
  assert.deepEqual(liveInvoices(loadInvoices(ws)).map((i) => i.id), [inv.id]);

  // A Gutschrift of the Rechnung takes the quantities back: invoiced falls, the Auftrag is Teilweise again.
  const cn = await issued(ws, createCreditNote(ws, inv.id, { reason: 'Retour' }, '2026-11-18T08:00:00Z'), '2026-11-18T09:00:00Z');
  assert.equal(cn.number, '2026-002', 'credit notes share today\'s series');
  assert.deepEqual(positions(find(ws, order.id), docs()).map((p) => p.invoiced), [0]);
  assert.equal(orderStatus(find(ws, order.id), docs()), 'partly');
  assert.deepEqual(chainOf(find(ws, cn.id), docs()).map((s) => s.doc.id).at(-1), cn.id, 'the Gutschrift hangs in the chain by creditFor');
});

test('P2.3 an Angebot with two options, one taken: the Angebot\'s total leaves both out and names them; the conversion lists them unticked; the Rechnung\'s total and QR amount hold the one taken', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const lines = [item('Fassade', 1, 1000), item('Gerüst länger', 1, 200, { optional: true }), item('Graffitischutz', 1, 300, { optional: true })];
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  assert.equal(totals(q).net, 1000);
  assert.equal(totals(q).gross, 1081);
  assert.deepEqual(optionsOf(q), { n: 2, amount: 500 });
  const html = sheetBlocks(issuedSheet(loadInvoices(ws), q)).map((b) => b.html).join('');
  assert.match(html, /Nicht im Total: 2 Optionen über CHF 500\.00/);
  assert.equal((html.match(/class="lopt"/g) ?? []).length, 2, 'each option is marked');

  assert.deepEqual(offered(q, 'invoice', liveDocuments(loadInvoices(ws))).map((o) => [o.line, o.ticked]), [[0, true], [1, false], [2, false]]);
  const draft = convertDocument(ws, q.id, { to: 'invoice', lines: [{ line: 0, quantity: 1 }, { line: 2, quantity: 1 }] }, '2026-11-05T08:00:00Z');
  assert.ok(draft.lines.every((l) => !('optional' in l)), 'a ticked option becomes an ordinary position');
  const inv = await issued(ws, draft, '2026-11-05T09:00:00Z');
  assert.equal(totals(inv).gross, 1405.3);
  assert.equal(qrBillData(issuedSheet(loadInvoices(ws), inv), 'CH4431999123000889012').amount, 1405.3);
  // An option on a Rechnung is refused: it would print an amount the total leaves out.
  const bad = createDraft(ws, { customerId: c.id, lines: [item('A', 1, 10), item('B', 1, 5, { optional: true })] });
  await assert.rejects(issued(ws, bad, '2026-11-06T09:00:00Z'), (e: InvoiceRuleError) => e.code === 'incomplete' && !!e.missing?.some((m) => m.field === 'line.optional'));
});

test('P2.8 a conversion of an expired Angebot: a warning with the date and what follows; «Trotzdem erstellen» makes the draft, the Angebot is then accepted. More than open warns; nothing ticked makes nothing', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-09-01', validUntil: '2026-10-01', lines: [item('Fassade', 10, 50, { unit: 'm2' })] }, '2026-09-01T08:00:00Z'), '2026-09-01T09:00:00Z');
  assert.equal(quoteStatus(q, liveDocuments(loadInvoices(ws)), '2026-11-19'), 'expired');
  assert.throws(() => convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 0, quantity: 10 }] }, '2026-11-19T08:00:00Z'),
    (e: InvoiceRuleError) => e.code === 'expired' && e.params?.date === '2026-10-01' && /angenommen/.test(e.message));
  assert.equal(liveDocuments(loadInvoices(ws)).length, 1, 'refused: nothing made');
  const made = convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 0, quantity: 10 }], confirm: ['expired'] }, '2026-11-19T08:00:00Z');
  assert.equal(made.kind, 'sales-order');
  assert.equal(made.lines[0].kind ?? 'item', 'item');
  assert.equal(quoteStatus(find(ws, q.id), liveDocuments(loadInvoices(ws)), '2026-11-19'), 'accepted');

  const order = await issued(ws, made, '2026-11-19T09:00:00Z');
  assert.throws(() => convertDocument(ws, order.id, { to: 'invoice', lines: [{ line: 0, quantity: 12 }] }, '2026-11-19T10:00:00Z'),
    (e: InvoiceRuleError) => e.code === 'overOpen' && e.params?.quantity === 12 && e.params?.open === 10 && e.params?.unit === 'm2');
  assert.equal(convertDocument(ws, order.id, { to: 'invoice', lines: [{ line: 0, quantity: 12 }], confirm: ['overOpen'] }, '2026-11-19T10:00:00Z').lines.length, 1);
  assert.throws(() => convertDocument(ws, order.id, { to: 'invoice', lines: [] }), (e: InvoiceRuleError) => e.code === 'nothingTicked');
  assert.throws(() => convertDocument(ws, q.id, { to: 'delivery-note', lines: [{ line: 0, quantity: 1 }] }), (e: InvoiceRuleError) => e.code === 'convert', 'a Lieferschein only from an Auftrag');
  const declined = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-19', lines: [item('X', 1, 10)] }, '2026-11-19T08:00:00Z'), '2026-11-19T11:00:00Z');
  answerQuote(ws, declined.id, 'declined', 'Anna Muster', '2026-11-19');
  assert.throws(() => convertDocument(ws, declined.id, { to: 'invoice', lines: [{ line: 0, quantity: 1 }] }, '2026-11-19T12:00:00Z'), (e: InvoiceRuleError) => e.code === 'declined');
});

test('an Auftrag\'s Storno: refused while a Rechnung of it stands, warned while a Lieferschein does; an Angebot or Auftrag back to draft keeps its number and, once sent, asks first', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const order = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'sales-order', date: '2026-11-02', lines: [item('Platten', 10, 45)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  await issued(ws, convertDocument(ws, order.id, { to: 'delivery-note', lines: [{ line: 0, quantity: 5 }] }, '2026-11-03T08:00:00Z'), '2026-11-03T09:00:00Z');
  await assert.rejects(cancelInvoice(ws, order.id, { date: '2026-11-04', reason: 'x' }, { printer }), (e: InvoiceRuleError) => e.code === 'orderDelivered');
  const inv = await issued(ws, convertDocument(ws, order.id, { to: 'invoice', lines: [{ line: 0, quantity: 5 }] }, '2026-11-04T08:00:00Z'), '2026-11-04T09:00:00Z');
  await assert.rejects(cancelInvoice(ws, order.id, { date: '2026-11-04', reason: 'x', confirm: ['orderDelivered'] }, { printer }), (e: InvoiceRuleError) => e.code === 'orderInvoiced');
  await cancelInvoice(ws, inv.id, { date: '2026-11-05', reason: 'falsch' }, { printer });
  const done = await cancelInvoice(ws, order.id, { date: '2026-11-05', reason: 'Kunde verzichtet', confirm: ['orderDelivered'] }, { printer });
  assert.equal(orderStatus(done.invoice, liveDocuments(loadInvoices(ws))), 'cancelled');

  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-06', lines: [item('A', 1, 100)] }, '2026-11-06T08:00:00Z'), '2026-11-06T09:00:00Z');
  await recordSend(ws, q.id, { to: 'kunde@example.ch', now: '2026-11-06T10:00:00Z' });
  assert.throws(() => reopenDocument(ws, q.id, false), (e: InvoiceRuleError) => e.code === 'sentVersion' && e.params?.to === 'kunde@example.ch' && e.params?.date === '2026-11-06');
  const back = reopenDocument(ws, q.id, true);
  assert.equal(back.status, 'draft');
  assert.equal(back.number, q.number);
  updateDraft(ws, q.id, { lines: [item('A', 1, 120)] });
  const again = await issued(ws, find(ws, q.id) as Draft, '2026-11-07T09:00:00Z');
  assert.equal(again.number, q.number, 'issued again under its number');
  assert.notEqual(again.pdf.file, q.pdf.file, 'the version sent keeps its own PDF');
  assert.equal(loadInvoices(ws).sent[0].file, q.pdf.file, 'and stays in the sent log');
  assert.throws(() => reopenDocument(ws, inv.id, true), (e: InvoiceRuleError) => e.code === 'notReopenable', 'a Rechnung is not taken back here');
});

test('P2.6 an existing workspace keeps every number and continues its series; a new firm starts with AN-, AU-, LS-, RE-, GS-', async () => {
  const old = workspace();
  const c = createCustomer(old, CUSTOMER);
  const a = await issued(old, createDraft(old, { customerId: c.id, date: '2026-11-02', lines: [item('A', 1, 100)] }), '2026-11-02T09:00:00Z');
  const b = await issued(old, createDraft(old, { customerId: c.id, date: '2026-11-03', lines: [item('B', 1, 100)] }), '2026-11-03T09:00:00Z');
  const cn = await issued(old, createCreditNote(old, a.id, { reason: 'x' }), '2026-11-04T09:00:00Z');
  assert.deepEqual([a.number, b.number, cn.number], ['2026-001', '2026-002', '2026-003'], 'one series of invoices and credit notes, as before');
  assert.equal(eventRef(a, 'issue'), 'RE-2026-001', 'the refs of today stay');
  assert.equal(eventRef(cn, 'issue'), 'GS-2026-003');

  const fresh = workspace(true);
  const f = createCustomer(fresh, CUSTOMER);
  const got: string[] = [];
  for (const kind of ['quote', 'sales-order'] as const) got.push((await issued(fresh, createDraft(fresh, { customerId: f.id, kind, date: '2026-11-02', lines: [item('A', 1, 100)] }), '2026-11-02T09:00:00Z')).number);
  const order = liveDocuments(loadInvoices(fresh)).find((d) => d.kind === 'sales-order')!;
  got.push((await issued(fresh, convertDocument(fresh, order.id, { to: 'delivery-note', lines: [{ line: 0, quantity: 1 }] }, '2026-11-02T10:00:00Z'), '2026-11-02T11:00:00Z')).number);
  got.push((await issued(fresh, createDraft(fresh, { customerId: f.id, date: '2026-11-02', lines: [item('A', 1, 100)] }), '2026-11-02T12:00:00Z')).number);
  const inv = liveInvoices(loadInvoices(fresh))[0] as Issued;
  got.push((await issued(fresh, createCreditNote(fresh, inv.id, { reason: 'x' }), '2026-11-03T09:00:00Z')).number);
  assert.deepEqual(got, ['AN-2026-00001', 'AU-2026-00001', 'LS-2026-00001', 'RE-2026-00001', 'GS-2026-00001']);
  // A number with its own prefix is its own ref: never «RE-RE-…»; QRR and SCOR hold it and tell the two series apart.
  assert.equal(eventRef(inv, 'issue'), 'RE-2026-00001');
  assert.equal(eventRef(inv, 'storno'), 'RE-2026-00001-storno');
  assert.equal(writeOffRef(inv, 'wo-1'), 'RE-2026-00001-wo-1');
  assert.equal(docRef({ number: 'GS-2026-00001', kind: 'credit-note' }), 'GS-2026-00001');
  assert.notEqual(qrReference('RE-2026-00001'), qrReference('GS-2026-00001'));
  for (const n of ['RE-2026-00001', 'GS-2026-00001']) {
    assert.equal(parseReference(qrReference(n))?.kind, 'QRR');
    assert.equal(parseReference(scorReference(n))?.reference, scorReference(n));
  }
  assert.equal(qrReference('2026-007'), '000000000000000000020260073', 'a number without letters keeps its reference (tests/invoices.test.ts)');
  assert.equal(inv.reference, referenceFor('RE-2026-00001', inv.sender.payTo));
});

test('number formats: tokens, a shared counter, a yearly restart, a change from the next number, and a format no reference holds refused', () => {
  const nf = { format: 'RE-{JJJJ}-{NNNNN}', restartYearly: true };
  assert.equal(formatNumber(nf, '2026', 7), 'RE-2026-00007');
  assert.equal(counterOf(nf, 'RE-2026-00007', '2026'), 7);
  assert.equal(counterOf(nf, 'RE-2025-00007', '2026'), undefined, 'another year has its own count');
  const doc = (kind: Invoice['kind'], number: string, date = '2026-05-01') => ({ id: number, kind, status: 'issued', number, date, deleted: false }) as unknown as Invoice;
  const docs = [doc('invoice', '2026-001'), doc('credit-note', '2026-002'), doc('invoice', '2025-014', '2025-12-01')];
  assert.equal(nextNumberFor(docs, 'invoice', '2026-06-01', LEGACY_NUMBERING), '2026-003', 'invoices and credit notes count together');
  assert.equal(nextNumberFor(docs, 'credit-note', '2026-06-01', LEGACY_NUMBERING), '2026-003');
  assert.equal(nextNumberFor(docs, 'invoice', '2027-01-02', LEGACY_NUMBERING), '2027-001', 'a new year restarts');
  assert.equal(nextNumberFor(docs, 'invoice', '2026-06-01', DEFAULT_NUMBERING), 'RE-2026-00001', 'a new format starts its own series from the next number');
  const running = { ...DEFAULT_NUMBERING, quote: { format: 'OF{NNNN}', restartYearly: false } };
  assert.equal(nextNumberFor([doc('quote', 'OF0041', '2025-03-01')], 'quote', '2026-01-03', running), 'OF0042', 'no yearly restart: the count runs on');

  assert.equal(formatFits('invoice', { format: 'RE-{JJJJ}-{NNNNN}', restartYearly: true }), undefined);
  assert.equal(formatFits('invoice', { format: 'RECHNUNG-{JJJJ}-{NNNNNNNN}', restartYearly: true }), 'tooLongQrr', 'eight letters are 16 digits, with the year and eight more: 28');
  assert.equal(formatFits('invoice', { format: '{JJJJ}{NNNNNNNNN}0123456789', restartYearly: true }), 'tooLongScor');
  assert.equal(formatFits('quote', { format: 'ANGEBOTANGEBOT-{JJJJ}-{NNNNNNNNN}', restartYearly: true }), undefined, 'an Angebot carries no payment reference');
  assert.equal(formatFits('invoice', { format: 'RE-{NNNNN}', restartYearly: true }), 'restartWithoutYear');
  assert.equal(formatFits('invoice', { format: 'RE/{JJJJ}/{NNN}', restartYearly: true }), 'syntax', 'a slash would break a link and a file name');
});

test('issuing refuses a number whose booking ref another document already holds (a format switched to RE-{JJJJ}-{NNN} beside the old 2026-001)', () => {
  const customer: Customer = { id: 'cu_1', createdAt: '', origin: 'manual', deleted: false, ...CUSTOMER };
  const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1021', iban: 'CH6580808000000000001' } };
  const draft = (id: string): Draft => ({ id, createdAt: '', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-11-02', currency: 'CHF', language: 'de', lines: [item('A', 1, 100)], comments: [] });
  const first = { ...issue(draft('in_1'), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-11-02T09:00:00Z' }), pdf: { file: '', sha256: '' } };
  assert.equal(first.number, '2026-001');
  const switched = { ...LEGACY_NUMBERING, invoice: { format: 'RE-{JJJJ}-{NNN}', restartYearly: true } };
  assert.throws(() => issue(draft('in_2'), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [first], now: '2026-11-03T09:00:00Z', numbering: switched }), (e: InvoiceRuleError) => e.code === 'refTaken');
});

test('the tables of Angebote, Aufträge and Lieferscheine: a status per kind from facts, their tabs with «Nicht gesendet», geliefert and verrechnet as shares', async () => {
  const { docRows, tabCounts, viewOfKind, kindOfView } = await import('../src/app/areas/invoices/table.js');
  const { parsePeriod } = await import('../src/accounting/periods.js');
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [item('A', 10, 10), item('B', 10, 30)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-03', lines: [item('C', 1, 10)] });
  const order = await issued(ws, convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 0, quantity: 10 }, { line: 1, quantity: 10 }] }, '2026-11-04T08:00:00Z'), '2026-11-04T09:00:00Z');
  await issued(ws, convertDocument(ws, order.id, { to: 'delivery-note', lines: [{ line: 1, quantity: 10 }] }, '2026-11-05T08:00:00Z'), '2026-11-05T09:00:00Z');
  const book = loadInvoices(ws);
  const d = { today: '2026-11-19', invoices: liveDocuments(book), contacts: book.contacts, sent: book.sent };
  const year = parsePeriod('2026', '2026-11-19')!;
  const quotes = docRows(d, 'quote', year, undefined, '2026-11-19');
  assert.deepEqual(quotes.map((r) => r.status).sort(), ['accepted', 'draft']);
  assert.deepEqual(Object.fromEntries(tabCounts(quotes, 'quote').map((t) => [t.tab, t.n])), { all: 2, draft: 1, open: 0, accepted: 1, declined: 0, expired: 0, unsent: 1 });
  const orders = docRows(d, 'sales-order', year, undefined, '2026-11-19');
  assert.deepEqual(orders.map((r) => [r.id, r.status, r.delivered, r.invoiced]), [['AU-2026-00001', 'partly', 0.75, 0]], 'B is three quarters of the value');
  const notes = docRows(d, 'delivery-note', year, undefined, '2026-11-19');
  assert.deepEqual(notes.map((r) => [r.id, r.status, r.target?.number]), [['LS-2026-00001', 'done', 'AU-2026-00001']], 'a Lieferschein names its Auftrag');
  assert.deepEqual(docRows(d, 'invoice', year, undefined, '2026-11-19'), [], 'none of them is a Rechnung');
  assert.deepEqual(['quote', 'sales-order', 'delivery-note'].map((k) => viewOfKind(k as never)), ['quotes', 'orders', 'deliveries']);
  assert.equal(kindOfView('orders'), 'sales-order');
});

// ─── review of F1 (the probe's cases and the lead's list) ─────────────────────

test('a reopened Angebot keeps its number: another Angebot issued meanwhile takes the next, the draft is issued again under its own, never deleted, and its number still finds it', async () => {
  const { findInvoice, removeDraft } = await import('../src/invoices/service.js');
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const a = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [item('x', 1, 10)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  const back = reopenDocument(ws, a.id, false);
  assert.equal(findInvoice(loadInvoices(ws), a.number)?.id, a.id, 'the number\'s link opens the draft');
  const b = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-03', lines: [item('y', 1, 10)] }, '2026-11-03T08:00:00Z'), '2026-11-03T09:00:00Z');
  assert.equal(b.number, 'AN-2026-00002', 'the kept number is taken');
  assert.throws(() => removeDraft(ws, back.id), (e: InvoiceRuleError) => e.code === 'numbered');
  const again = await issued(ws, find(ws, a.id) as Draft, '2026-11-04T09:00:00Z');
  assert.equal(again.number, 'AN-2026-00001');
});

test('an Angebot, Auftrag or Lieferschein is never open money: openAmount 0, never overdue, status no more than issued', async () => {
  const { isOverdue, openAmount, openOn, status } = await import('../src/invoices/rules.js');
  const { customerOpen } = await import('../src/app/areas/invoices/model.js');
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [item('x', 1, 100)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  const o = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'sales-order', date: '2026-11-02', lines: [item('x', 1, 100)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  const book = loadInvoices(ws);
  const docs = liveDocuments(book);
  for (const d of [q, o]) {
    assert.deepEqual([openAmount(d, docs), openOn(d, docs, '2027-12-31'), isOverdue(d, docs, '2027-03-01'), status(d, docs)], [0, 0, false, 'issued']);
  }
  assert.equal(customerOpen({ today: '2027-03-01', invoices: docs, contacts: book.contacts, sent: book.sent }, c.id), 0);
});

test('an Auftrag\'s Storno: a Rechnung of it credited in full no longer holds it, credited in part still does; its drafts warn first and warn again at their issue; each «Trotzdem» confirms only its own warning', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const o = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'sales-order', date: '2026-11-02', lines: [item('x', 2, 10)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  const inv = await issued(ws, convertDocument(ws, o.id, { to: 'invoice', lines: [{ line: 0, quantity: 2 }] }, '2026-11-03T08:00:00Z'), '2026-11-03T09:00:00Z');
  await issued(ws, createCreditNote(ws, inv.id, { reason: 'Teil', amount: 5 }, '2026-11-04T08:00:00Z'), '2026-11-04T09:00:00Z');
  await assert.rejects(cancelInvoice(ws, o.id, { date: '2026-11-05', reason: 'x' }, { printer }), (e: InvoiceRuleError) => e.code === 'orderInvoiced', 'credited in part, the claim stands');
  await issued(ws, createCreditNote(ws, inv.id, { reason: 'Rest', amount: 16.62 }, '2026-11-05T08:00:00Z'), '2026-11-05T09:00:00Z');

  const later = convertDocument(ws, o.id, { to: 'delivery-note', lines: [{ line: 0, quantity: 1 }] }, '2026-11-06T08:00:00Z');
  await assert.rejects(cancelInvoice(ws, o.id, { date: '2026-11-06', reason: 'x', confirm: ['paid', 'orderDelivered'] }, { printer }), (e: InvoiceRuleError) => e.code === 'orderDrafts' && e.params?.n === 1, 'another warning\'s code passes nothing');
  const done = await cancelInvoice(ws, o.id, { date: '2026-11-06', reason: 'x', confirm: ['orderDrafts'] }, { printer });
  assert.ok(done.invoice.cancelled, 'credited in full, the Auftrag is cancelled');
  await assert.rejects(issued(ws, later, '2026-11-07T09:00:00Z'), (e: InvoiceRuleError) => e.code === 'sourceCancelled' && e.params?.number === o.number);
  assert.equal((await issueInvoice(ws, later.id, { now: '2026-11-07T09:00:00Z', printer, confirm: ['sourceCancelled'] })).kind, 'delivery-note');
});

test('payment references stay unique: 2026-001 and 2026001 make one QR reference, so the switch is refused at issue; formats that read as a draft link or a ref of the books, or a Rechnung sharing its series with an Angebot, are refused', () => {
  assert.equal(qrReference('2026-001'), qrReference('2026001'));
  assert.equal(scorReference('RE-2026-00001'), scorReference('RE202600001'));
  const customer: Customer = { id: 'cu_1', createdAt: '', origin: 'manual', deleted: false, ...CUSTOMER };
  const sender = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012' } };
  const draft = (id: string, date: string): Draft => ({ id, createdAt: '', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date, currency: 'CHF', language: 'de', lines: [item('A', 1, 100)], comments: [] });
  const first = { ...issue(draft('in_1', '2026-01-02'), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-01-02T09:00:00Z' }), pdf: { file: '', sha256: '' } };
  const switched = { ...LEGACY_NUMBERING, invoice: { format: '{JJJJ}{NNN}', restartYearly: true } };
  assert.equal(nextNumberFor([first], 'invoice', '2026-06-01', switched), '2026001');
  assert.throws(() => issue(draft('in_2', '2026-06-01'), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [first], now: '2026-06-01T09:00:00Z', numbering: switched }), (e: InvoiceRuleError) => e.code === 'referenceTaken' && e.params?.other === '2026-001');

  assert.equal(formatFits('invoice', { format: 'M{JJJJ}-{NNN}', restartYearly: true }), 'reserved', 'M2026-001 is a manual ref of the books');
  assert.equal(formatFits('invoice', { format: '{JJJJ}-{NNN}-storno', restartYearly: true }), 'reserved');
  assert.equal(formatFits('quote', { format: 'draft-{JJJJ}-{NNN}', restartYearly: true }), 'reserved', 'a draft\'s link');
  assert.deepEqual(numberingFits({ ...LEGACY_NUMBERING, quote: LEGACY_NUMBERING.invoice }), { kind: 'invoice', refusal: 'sharedKinds' });
  assert.equal(numberingFits(LEGACY_NUMBERING), undefined, 'invoices and credit notes may share');
  assert.equal(numberingFits(DEFAULT_NUMBERING), undefined);
});

test('the rules of the chain: no Lieferschein of its own, no negative quantity taken, no «abgelehnt» warning once accepted, and a Gutschrift needs an account to pay back as before', async () => {
  const { missingForIssue } = await import('../src/invoices/rules.js');
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  assert.throws(() => createDraft(ws, { customerId: c.id, kind: 'delivery-note' }), (e: InvoiceRuleError) => e.code === 'deliveryFromOrder');
  const q = await issued(ws, createDraft(ws, { customerId: c.id, kind: 'quote', date: '2026-11-02', lines: [item('x', 3, 10)] }, '2026-11-02T08:00:00Z'), '2026-11-02T09:00:00Z');
  assert.throws(() => convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 0, quantity: -1 }] }), (e: InvoiceRuleError) => e.code === 'incomplete');
  answerQuote(ws, q.id, 'declined', 'Anna Muster', '2026-11-03');
  convertDocument(ws, q.id, { to: 'sales-order', lines: [{ line: 0, quantity: 1 }], confirm: ['declined'] });
  assert.equal(convertDocument(ws, q.id, { to: 'invoice', lines: [{ line: 0, quantity: 1 }] }).kind, 'invoice', 'accepted as a fact: the decline warns no more');
  const noPay = { name: 'X', address: CUSTOMER.address, uid: 'CHE-123.456.789' };
  const missing = (kind: Draft['kind']) => missingForIssue({ ...find(ws, q.id), kind } as Draft, { customer: CUSTOMER, sender: noPay, invoices: [] }).map((m) => m.field);
  assert.ok(missing('credit-note').includes('payTo'));
  assert.ok(!missing('quote').includes('payTo'));
});
