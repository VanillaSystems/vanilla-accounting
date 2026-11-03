/**
 * What the persona test «invoices» found, as rules: what is missing for «Ausstellen» and where it
 * is fixed (#3, #2, #5), the date of supply (#9), saving through the Save dialog (#11), an overdue
 * invoice of an earlier period still listed (#15), a reminder for an invoice never sent (#22), a
 * credit note's lines and subject (#19), the sender without address
 * (#4), a date before the last issued invoice (#26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePeriod } from '../src/accounting/periods.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { creditNoteDraft, issue, missingForIssue, revenueSplit, totals } from '../src/invoices/rules.js';
import { parseDraftPatch } from '../src/invoices/service.js';
import { assembleSheets, oneLine, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { fixFor, sheetEdit } from '../src/app/areas/invoices/edit.js';
import { issuedLater, rowsOf, wasSent } from '../src/app/areas/invoices/model.js';
import { saveFile, sameOrigin } from '../src/desktop/save-file.js';
import deLocale from '../src/app/i18n/locales/de.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Familie Keller', address: { street: 'Rosenweg', number: '5', postcode: '9500', town: 'Wil', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const sender = { name: 'Malerei AG', uid: 'CHE-123.456.789', address: { street: 'Hauptstrasse', number: '1', postcode: '9500', town: 'Wil', country: 'CH' }, payTo: { account: '1020', iban: 'CH6580808000000000001' } };
const env = (id: string) => ({ id, createdAt: '2026-10-01T08:00:00Z', origin: 'manual' as const, deleted: false });
const draft = (over: Partial<Draft> = {}): Draft => ({
  ...env('in_d'), status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-15', currency: 'CHF', language: 'de', comments: [],
  lines: [{ text: 'Malerarbeiten', quantity: 24, unit: 'h', price: 85, vatRate: 8.1 }], ...over,
});

test('«Ausstellen» with something missing: each item says it in words and leads where it is fixed', () => {
  const missing = missingForIssue(draft({ lines: [{ text: ' ', quantity: 1, price: 0, vatRate: 8.1 }] }), { customer, sender: { name: 'Malerei AG', uid: '' }, invoices: [] });
  assert.deepEqual(missing.map((m) => [m.field, fixFor(m)]), [
    ['sender.address', { company: 'profile' }],
    ['sender.uid', { company: 'profile' }],
    ['payTo', { company: 'invoice-layout' }],
    ['line.text', { field: 'l:0:text' }],
  ]);
  const words = Object.entries(deLocale.messages).filter(([k]) => k.startsWith('invoice.missing.')).map(([, v]) => String(v));
  assert.deepEqual(words.filter((w) => /[a-z]+\.[a-z]+[A-Z]/.test(w)), [], 'no config key (invoicing.payTo) in what a person reads');
  assert.match(String(deLocale.messages['invoice.missing.payTo']), /Firma › Rechnungslayout › Zahlungskonten/);
});

test('the date or period of the supply: typed on the sheet, stored, printed', () => {
  const ctx = { customers: [customer], defaultTexts: { intro: '', closing: '' } };
  const d = draft();
  assert.deepEqual(sheetEdit(d, 'supplied', '01.09. – 15.09.2026', ctx), { change: { supplied: { from: '2026-09-01', to: '2026-09-15' } } });
  assert.deepEqual(sheetEdit(d, 'supplied', '03.09.2026', ctx), { change: { supplied: { from: '2026-09-03' } } });
  assert.deepEqual(sheetEdit(d, 'supplied', '15.09.2026 – 01.09.2026', ctx), { refused: 'date' }, 'the end before the start');
  assert.deepEqual(sheetEdit({ ...d, supplied: { from: '2026-09-03' } }, 'supplied', '', ctx), { change: { supplied: null } });
  assert.equal(sheetEdit(d, 'supplied', '', ctx), undefined);

  const issued = issue({ ...d, supplied: { from: '2026-09-01', to: '2026-09-15' } }, { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' });
  assert.deepEqual(issued.supplied, { from: '2026-09-01', to: '2026-09-15' }, 'frozen with the invoice');
  const data: SheetData = { kind: 'invoice', language: 'de', number: issued.number, date: issued.date, supplied: issued.supplied, currency: 'CHF', customer, sender, lines: issued.lines, intro: '', closing: '', layout: DEFAULT_LAYOUT };
  assert.match(sheetBlocks(data).map((b) => b.html).join(''), /Leistung 1\. September 2026 – 15\. September 2026|Leistung 01\.09\.2026 – 15\.09\.2026/);
  assert.doesNotMatch(sheetBlocks({ ...data, supplied: undefined }).map((b) => b.html).join(''), /Leistung/, 'absent: the invoice date, nothing printed');
});

test('the Save dialog: cancelled, nothing written and nothing to record; saved, the file is there; only the page\'s own server', async () => {
  const written: string[] = [];
  const deps = (path?: string) => ({ ask: async () => path, read: async () => new Uint8Array([37, 80]), write: async (p: string) => { written.push(p); } });
  assert.equal(await saveFile('/invoices/2026-001.pdf', '2026-001.pdf', deps(undefined)), false);
  assert.deepEqual(written, []);
  assert.equal(await saveFile('/invoices/2026-001.pdf', '2026-001.pdf', deps('/Users/x/Downloads/2026-001.pdf')), true);
  assert.deepEqual(written, ['/Users/x/Downloads/2026-001.pdf']);
  assert.equal(sameOrigin('/api/documents/invoices/2026-001.pdf', 'http://127.0.0.1:3456/invoices/2026-001'), 'http://127.0.0.1:3456/api/documents/invoices/2026-001.pdf');
  assert.equal(sameOrigin('https://example.com/x.pdf', 'http://127.0.0.1:3456/'), undefined);
});

test('an invoice of an earlier period still open is listed in the current one, and counted as open', () => {
  const book = JSON.parse(readFileSync(join(DEMO_ROOT, 'invoices.json'), 'utf8')) as InvoiceBook;
  const d = { today: '2026-12-01', invoices: book.invoices, customers: book.customers, sent: book.sent };
  const q4 = rowsOf(d, parsePeriod('2026-Q4', '2026-12-01')!, undefined, '2026-12-01');
  const earlier = q4.filter((r) => r.inv.date < '2026-10-01');
  assert.ok(earlier.length > 0, 'the demo has open invoices dated before Q4');
  assert.ok(earlier.every((r) => r.state === 'open' || r.state === 'overdue'), 'only the open ones; paid ones stay in their quarter');
});

test('a reminder for an invoice never sent; a draft dated before the last issued invoice', () => {
  const inv = { ...issue(draft(), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' }), pdf: { file: 'x', sha256: 'x' } } as Issued;
  const sent = (kind: 'invoice' | 'reminder') => ({ ...env('s'), invoiceId: inv.id, kind, title: '', file: '', sha256: '', sentAt: '2026-10-16T08:00:00Z', to: 'download' });
  assert.equal(wasSent([], inv), false);
  assert.equal(wasSent([sent('reminder')], inv), false, 'a reminder is not the invoice');
  assert.equal(wasSent([sent('invoice')], inv), true);
  assert.equal(issuedLater([inv], { date: '2026-08-20' })?.id, inv.id);
  assert.equal(issuedLater([inv], { date: '2026-10-15' }), undefined);
  assert.equal(issuedLater([inv], { date: '2025-08-20' }), undefined, 'another year has its own numbers');
});

test('a credit note for part of an invoice reads «1 × −200.00» VAT included, titled for the invoice it credits', () => {
  const inv = { ...issue(draft({ lines: [{ text: 'Malerarbeiten', quantity: 1, price: 2352.5, vatRate: 8.1 }] }), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' }), pdf: { file: 'x', sha256: 'x' } } as Issued;
  const cn = creditNoteDraft(inv, { amount: 200, reason: 'Kratzer im Parkett, Kulanz' }, env('cn'), '2026-10-15');
  assert.deepEqual(cn.lines.map((l) => [l.quantity, l.unit, l.price, l.vatIncluded]), [[1, undefined, -200, true]]);
  assert.equal(totals(cn.lines).gross, -200);
  assert.equal(cn.subject, 'zu Rechnung 2026-001');
  const whole = creditNoteDraft(inv, { reason: '' }, env('cn2'), '2026-10-15');
  assert.deepEqual(whole.lines.map((l) => [l.quantity, l.price]), [[1, -2352.5]]);
});

test('«CHF 500 inkl. MWST» stays 500.00: the VAT is derived from the gross, the sheet, the QR-bill and the booking carry the same figures (F04)', () => {
  const inv = { ...issue(draft({ lines: [{ text: 'Workshop Strategie', quantity: 1, price: 3000, vatRate: 8.1 }] }), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' }), pdf: { file: 'x', sha256: 'x' } } as Issued;
  const cn = creditNoteDraft(inv, { amount: 500, reason: 'Workshop Oktober' }, env('cn'), '2026-11-02');
  const t = totals(cn.lines);
  assert.deepEqual([t.gross, t.vat, t.net], [-500, -37.47, -462.53], 'no net price at 8.1 % gives 500.00; the gross does');
  assert.deepEqual(revenueSplit(cn, -500, '3200'), [{ account: '3200', vatCode: 'V81', amount: -500 }], 'the booking takes the same gross');
  const data: SheetData = { kind: 'credit-note', language: 'de', date: cn.date, currency: 'CHF', customer, sender, lines: cn.lines, intro: '', closing: '', layout: DEFAULT_LAYOUT };
  const html = sheetBlocks(data).map((b) => b.html).join('');
  assert.match(html, /8.1 % inkl\./, 'the line says its price has the VAT in it');
  assert.match(html, /Total CHF<\/span><span>−500\.00/);
  assert.match(html, /MWST 8.1 % auf −462\.53<\/span><span>−37\.47/);
  // A net-priced line is computed as before: VAT on the net.
  assert.deepEqual([totals(inv.lines).gross, totals(inv.lines).vat], [3243, 243]);
  // Editing keeps the line priced with its VAT in it; the rate pick switches it.
  const d = { ...cn, lines: cn.lines } as Draft;
  const ctx = { customers: [customer], defaultTexts: { intro: '', closing: '' } };
  assert.deepEqual(sheetEdit(d, 'l:0:price', '−450', ctx), { change: { lines: [{ ...cn.lines[0], price: -450 }] } }, 'a typed minus (U+2212) stays a minus');
  assert.deepEqual(sheetEdit(d, 'l:0:vatRate', '8.1', ctx), { change: { lines: [{ text: cn.lines[0].text, quantity: 1, price: -500, vatRate: 8.1 }] } }, 'net again');
  assert.equal(sheetEdit(d, 'l:0:vatRate', 'incl:8.1', ctx), undefined);
  assert.deepEqual(sheetEdit(draft(), 'l:0:vatRate', 'incl:8.1', ctx), { change: { lines: [{ ...draft().lines[0], vatIncluded: true }] } });
  assert.deepEqual(sheetEdit(draft(), 'l:0:vatRate', 'incl:0', ctx), { refused: 'value' });
  const book: InvoiceBook = { schema: 2, customers: [customer], invoices: [], sent: [] };
  assert.deepEqual(parseDraftPatch({ lines: cn.lines }, book).lines, cn.lines, 'the API keeps the line priced with its VAT in it');
});

test('a company without its address yet: no dangling commas on the sheet', () => {
  const bare = { ...sender, address: { postcode: '', town: '', country: 'CH' } };
  assert.equal(oneLine(bare.address), '');
  const data: SheetData = { kind: 'invoice', language: 'de', date: '2026-10-15', currency: 'CHF', customer, sender: bare, lines: draft().lines, intro: '', closing: '', layout: DEFAULT_LAYOUT };
  const blocks = sheetBlocks(data);
  const html = assembleSheets(data, blocks, { pages: [blocks.map((_, i) => i)], qrOwnPage: false });
  assert.doesNotMatch(html, /Malerei AG · ,|<span>,|, <\/span>|Malerei AG ,/);
});
