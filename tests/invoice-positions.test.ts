/**
 * Positions of a document (spec docs/specs/invoicing.md 4.4.3, 4.5 «Rabatt position»): text,
 * Zwischentotal, Rabatt or Zuschlag on the total, Seitenumbruch, a discount per position; prices
 * net or gross per document; the firm's units. Checkpoints P1.2 (painter by m²) and P1.3 (webshop,
 * two rates, prices incl. VAT, Rabatt, agreed basis), every figure worked out by hand; and the
 * invoices.json step 2 → 3, which keeps every issued figure of every demo and of a mixed file.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';
import { apportion, creditNoteDraft, issue, lineAmounts, missingForIssue, revenueSplit, revenueVatCode, totals, warningsForIssue, writeOffAccounts, type Totals } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, DEFAULT_UNITS, type Customer, type Draft, type InvoiceBook, type InvoiceLine, type Issued, type ItemLine, type VatRate } from '../src/invoices/model.js';
import { INVOICES_MIGRATIONS, INVOICES_SCHEMA, climb, pricesOfDocument } from '../src/workspace/schema.js';
import { bookInvoiceEvents, eventRef } from '../src/invoices/events.js';
import type { PaymentContext } from '../src/invoices/payments.js';
import type { Books } from '../src/books/store.js';
import { paginate, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { parseDraftPatch } from '../src/invoices/service.js';
import { moveLine, repriced, sheetEdit } from '../src/app/areas/invoices/edit.js';
import { closeBrowser, renderPdf } from '../src/invoices/pdf.js';
import { fromRappen, roundCHF, toRappen } from '../src/accounting/rappen.js';
import { browserPath } from './support/browser.js';
import { POSITION_WORDS } from './support/sheet-words.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
setJurisdiction(ch, EFFECTIVE_QUARTERLY);
after(() => closeBrowser());

const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Familie Keller', address: { street: 'Seeweg', number: '12', postcode: '9500', town: 'Wil', country: 'CH' }, language: 'de', paymentTermsDays: 30,
};
const sender = { name: 'Malerei Huber GmbH', uid: 'CHE-123.456.789', address: { street: 'Hauptstrasse', number: '1', postcode: '9500', town: 'Wil', country: 'CH' }, payTo: { account: '1020', iban: 'CH6580808000000000001' } };
const env = (id: string) => ({ id, createdAt: '2026-10-01T08:00:00Z', origin: 'manual' as const, deleted: false });
const draft = (lines: InvoiceLine[], over: Partial<Draft> = {}): Draft => ({ ...env('in_d'), status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-15', currency: 'CHF', language: 'de', comments: [], prices: 'net', lines, ...over });
const item = (text: string, quantity: number, unit: string, price: number, vatRate: VatRate, over: Partial<ItemLine> = {}): ItemLine => ({ text, quantity, unit, price, vatRate, ...over });
const rates = (t: Totals) => t.byRate.map((r) => [r.rate, r.net, r.vat, r.gross]);
const sheetOf = (d: Draft): SheetData => ({ kind: d.kind, language: d.language, date: d.date, currency: d.currency, customer, sender, lines: d.lines, ...(d.prices ? { prices: d.prices } : {}), units: DEFAULT_UNITS, intro: '', closing: '', layout: DEFAULT_LAYOUT });
const sum = (xs: Array<{ amount: number }>) => fromRappen(xs.reduce((s, x) => s + toRappen(x.amount), 0));

// ─── P1.2: the painter ───────────────────────────────────────────────────────

/** Two rooms, each with a title and a Zwischentotal, the covering material on its own account, 3 % off the total. */
const painter = (): InvoiceLine[] => [
  { kind: 'text', text: 'Wohnzimmer', style: 'title' },
  item('Wände streichen, 2 Anstriche', 42, 'm2', 18.5, 8.1),
  item('Decke streichen', 20, 'm2', 22, 8.1),
  { kind: 'subtotal', text: 'Total Wohnzimmer' },
  { kind: 'text', text: 'Küche', style: 'title' },
  item('Wände streichen, 2 Anstriche', 18, 'm2', 18.5, 8.1),
  item('Abdecken und Material', 1, 'flat', 120, 8.1, { account: '3400' }),
  { kind: 'subtotal', text: 'Total Küche' },
  { kind: 'discount', text: 'Rabatt', percent: 3 },
];

test('P1.2 painter: m², a title and a Zwischentotal per room, 3 % Rabatt split over the accounts above it; the totals per rate, the booking and the Art. 26 check', () => {
  const inv = draft(painter());
  // By hand: 42 × 18.50 = 777.00, 20 × 22 = 440.00 (room 1217.00); 18 × 18.50 = 333.00, 120.00 (room 453.00); 1670.00, 3 % = 50.10.
  assert.deepEqual(lineAmounts(inv), [undefined, 777, 440, 1217, undefined, 333, 120, 453, -50.1]);
  // Net 1619.90, VAT 8.1 % = 131.2119 → 131.21, gross 1751.11. The Zwischentotale count nowhere.
  const t = totals(inv);
  assert.deepEqual(rates(t), [[8.1, 1619.9, 131.21, 1751.11]]);
  assert.deepEqual([t.net, t.vat, t.gross], [1619.9, 131.21, 1751.11]);
  // The Rabatt by the accounts above it: 1550 of 1670 on 3200 takes 46.50, 120 on 3400 takes 3.60 (exactly, no rest).
  // The rate's VAT by their net: 131.21 × 1503.50 / 1619.90 = 121.78 on 3200, 9.43 on 3400.
  assert.deepEqual(revenueSplit(inv, 1751.11, '3200'), [
    { account: '3200', vatCode: 'V81', amount: 1625.28 },
    { account: '3400', vatCode: 'V81', amount: 125.83 },
  ]);
  const part = revenueSplit(inv, 1000, '3200');
  assert.equal(sum(part), 1000, 'a part payment books the same mix, to the Rappen');
  assert.deepEqual(missingForIssue(inv, { customer, sender, invoices: [] }), [], 'Art. 26: nothing missing');
  assert.deepEqual(warningsForIssue(inv), [], 'a text, a Zwischentotal and a Rabatt need no quantity or price');

  // On the sheet: each room's title, its Zwischentotal, the Rabatt with its percent, m² in the document's language.
  const html = sheetBlocks(sheetOf(inv)).map((b) => b.html).join('');
  assert.match(html, /<tr class="ltext title"><td colspan="5">Wohnzimmer<\/td>/);
  assert.match(html, /<tr class="lsub"><td colspan="4">Total Wohnzimmer<\/td><td class="r">1’217\.00<\/td>/);
  assert.match(html, /<tr class="lsub"><td colspan="4">Total Küche<\/td><td class="r">453\.00<\/td>/);
  assert.match(html, /<tr class="ldisc"><td colspan="4">Rabatt <span class="dval">3 %<\/span><\/td><td class="r">−50\.10<\/td>/);
  assert.match(html, /42 m²/);
  assert.match(html, /1 pauschal/);
  assert.match(html, /MWST 8\.1 % auf 1’619\.90<\/span><span>131\.21/);
  assert.match(html, /Total CHF<\/span><span>1’751\.11/);
  assert.match(sheetBlocks({ ...sheetOf(inv), language: 'fr' }).map((b) => b.html).join(''), /1 forfait/, 'the unit in the document\'s language');
});

test('P1.2 printed: the PDF holds the rooms, a Seitenumbruch starts the second room on a sheet of its own under the repeated table header', { skip: browserPath ? false : 'no Chromium-based browser installed' }, async () => {
  const lines = painter();
  lines.splice(4, 0, { kind: 'pagebreak' });
  const d = { ...sheetOf(draft(lines)), number: '2026-001', reference: 'RF182026001' };
  const out = await renderPdf(d, '2026-10-15T10:00:00Z');
  assert.equal(out.pages, 2);
  const pages = out.html.split('<div class="a4 ').slice(1);
  assert.match(pages[0], /Wohnzimmer/);
  assert.doesNotMatch(pages[0], /Küche/);
  assert.match(pages[1], /<thead>/, 'the table header repeats');
  assert.match(pages[1], /Küche[\s\S]*Total Küche[\s\S]*−50\.10[\s\S]*1’751\.11/);
});

// ─── P1.3: the webshop ───────────────────────────────────────────────────────

const webshop = (): Draft => draft([
  item('Hausmischung 1 kg', 20, 'pcs', 28, 2.6),
  item('Kaffeemühle Handmodell', 2, 'pcs', 189, 8.1),
  { kind: 'discount', text: 'Rabatt Wiederverkauf', percent: 2 },
], { prices: 'gross', customerId: 'cu_1' });

test('P1.3 webshop: coffee 2.6 % and grinders 8.1 %, prices incl. VAT, 2 % Rabatt split over both rates to the Rappen', () => {
  const inv = webshop();
  // By hand: 560.00 + 378.00 = 938.00 gross; 2 % = 18.76, 560/938 of it = 11.20 and 378/938 = 7.56 (exact).
  assert.deepEqual(lineAmounts(inv), [560, 378, -18.76]);
  // 2.6 %: 548.80 gross, VAT 548.80 × 2.6 / 102.6 = 13.9068 → 13.91, net 534.89.
  // 8.1 %: 370.44 gross, VAT 370.44 × 8.1 / 108.1 = 27.7578 → 27.76, net 342.68.
  const t = totals(inv);
  assert.deepEqual(rates(t), [[8.1, 342.68, 27.76, 370.44], [2.6, 534.89, 13.91, 548.8]]);
  assert.deepEqual([t.net, t.vat, t.gross], [877.57, 41.67, 919.24]);
  assert.equal(roundCHF(t.byRate.reduce((s, r) => s + r.gross, 0)), t.gross, 'the rates add up to the gross');
  assert.deepEqual(revenueSplit(inv, t.gross, '3200'), [
    { account: '3200', vatCode: 'V26', amount: 548.8 },
    { account: '3200', vatCode: 'V81', amount: 370.44 },
  ]);
  const html = sheetBlocks(sheetOf(inv)).map((b) => b.html).join('');
  assert.match(html, /2\.6 % inkl\./, 'a gross document says so on each position');
  assert.match(html, /Total CHF<\/span><span>919\.24/);
});

test('P1.3 agreed basis: RE-<n> books both rates net of the Rabatt', () => {
  setJurisdiction(ch, { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' });
  try {
    const book: InvoiceBook = { schema: INVOICES_SCHEMA, customers: [customer], invoices: [], sent: [] };
    const inv: Issued = { ...issue(webshop(), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' }), pdf: { file: 'invoices/x.pdf', sha256: 'x' } };
    book.invoices.push(inv);
    const books: Books = { receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } };
    const ctx: PaymentContext = {
      bankAccounts: [], revenueAccount: '3200', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
      pdfOf: () => Buffer.from('%PDF'), receiptId: () => 'r1', indexedAt: () => '2026-10-15T18:00:00Z', held: () => new Set(),
    };
    bookInvoiceEvents(books, book, ctx);
    const re = books.journalEntries.filter((e) => e.transactionRef === eventRef(inv, 'issue'));
    assert.deepEqual(re.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [
      ['2026-10-15', '1100', '3200', 548.8, 'V26'],
      ['2026-10-15', '1100', '3200', 370.44, 'V81'],
    ]);
    assert.deepEqual(books.receipts[0].vatSummary, [
      { ratePercent: 8.1, net: 342.68, vat: 27.76, gross: 370.44 },
      { ratePercent: 2.6, net: 534.89, vat: 13.91, gross: 548.8 },
    ], 'the invoice PDF as its receipt states the same VAT per rate');
  } finally {
    setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  }
});

// ─── Rabatt rules ─────────────────────────────────────────────────────────────

test('Rabatte combined: each on the running total above it, after the earlier ones; an amount; a minus percent is a Zuschlag', () => {
  const inv = draft([
    item('A', 1, 'pcs', 100, 8.1),
    item('B', 1, 'pcs', 100, 2.6),
    { kind: 'discount', text: 'Rabatt', percent: 10 },
    { kind: 'discount', text: 'Treuerabatt', amount: 5 },
    { kind: 'discount', text: 'Expresszuschlag', percent: -2 },
  ]);
  // 200 → −20.00 (−10 each) → 180 → −5.00 (−2.50 each) → 175 → +3.50 (+1.75 each): 89.25 net per rate.
  assert.deepEqual(lineAmounts(inv), [100, 100, -20, -5, 3.5]);
  assert.deepEqual(rates(totals(inv)), [[8.1, 89.25, 7.23, 96.48], [2.6, 89.25, 2.32, 91.57]]);
  // A Rabatt above the positions it would split (none before it) takes nothing.
  const above = draft([{ kind: 'discount', text: 'R', percent: 5 }, item('A', 1, 'pcs', 100, 8.1)]);
  assert.deepEqual(lineAmounts(above), [0, 100]);
  assert.deepEqual(warningsForIssue(above), [{ field: 'line.discountBase', line: 0 }], 'it is warned of: it prints as 0.00');
  assert.deepEqual(warningsForIssue(draft([item('A', 1, 'pcs', 0.1, 8.1), { kind: 'discount', text: 'R', percent: 1 }])), [], 'one that rounds to 0.00 over an item is no warning');
  // An odd split: 3 Rappen over three equal groups is one each; 1 Rappen goes to the largest remainder, the parts add up.
  assert.deepEqual(apportion(-3, [1, 1, 1]), [-1, -1, -1]);
  assert.deepEqual(apportion(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(apportion(10, [5, -5]), [5, 5], 'by size, whatever the sign');
  const odd = draft([item('A', 1, 'pcs', 33.33, 8.1), item('B', 1, 'pcs', 33.33, 2.6, { account: '3400' }), item('C', 1, 'pcs', 33.34, 0), { kind: 'discount', text: 'R', percent: 7 }], { exemption: 'export' });
  const amounts = lineAmounts(odd);
  assert.equal(amounts[3], -7, '7 % of 100.00');
  assert.equal(sum(revenueSplit(odd, totals(odd).gross, '3200')), totals(odd).gross);
});

test('positions that nearly cancel: an amount Rabatt is spread by size, never blown up; a percent takes each group\'s share with its sign', () => {
  // 100.00 at 8.1 % and −99.99 at 2.6 % (0.01 net in all), CHF 5 off: by size 2.50 each, not 5 × 100 / 0.01.
  const near = draft([item('A', 1, 'pcs', 100, 8.1), item('Rückgabe', 1, 'pcs', -99.99, 2.6), { kind: 'discount', text: 'R', amount: 5 }]);
  assert.deepEqual(lineAmounts(near), [100, -99.99, -5]);
  assert.deepEqual(rates(totals(near)), [[8.1, 97.5, 7.9, 105.4], [2.6, -102.49, -2.66, -105.15]]);
  assert.equal(sum(revenueSplit(near, totals(near).gross, '3200')), totals(near).gross);
  // A deposit taken back at 0 %: 10 % takes 10 % of each, the deposit's refund shrinks with the rest.
  const deposit = draft([item('Kaffee', 10, 'pcs', 30, 2.6), item('Depot Mühle zurück', 1, 'pcs', -50, 0), { kind: 'discount', text: 'Rabatt', percent: 10 }], { exemption: 'export' });
  // 300 − 50 = 250, 10 % = 25.00: −30.00 on the coffee, +5.00 on the deposit.
  assert.deepEqual(lineAmounts(deposit), [300, -50, -25]);
  assert.deepEqual(rates(totals(deposit)), [[2.6, 270, 7.02, 277.02], [0, -45, 0, -45]]);
});

test('an invoice of zero or less is refused (a QR-bill carries no amount below zero); a position\'s discount stays within 0 to 100', () => {
  const over = draft([item('A', 1, 'pcs', 100, 8.1), { kind: 'discount', text: 'R', amount: 150 }]);
  assert.deepEqual(missingForIssue(over, { customer, sender, invoices: [] }).map((m) => m.field), ['total']);
  assert.deepEqual(missingForIssue(draft([item('A', 1, 'pcs', 100, 8.1, { discount: 120 })]), { customer, sender, invoices: [] }).map((m) => [m.field, m.line]), [['line.discount', 0], ['total', undefined]]);
  const book: InvoiceBook = { schema: INVOICES_SCHEMA, customers: [customer], invoices: [], sent: [] };
  assert.throws(() => parseDraftPatch({ lines: [{ text: 'A', quantity: 1, price: 1, vatRate: 8.1, discount: -5 }] }, book), /discount ist ein Prozentsatz von 0 bis 100/);
});

test('a discount per position: printed beside it, the line less its share to the Rappen', () => {
  const inv = draft([item('Farbe', 3, 'l', 33.33, 8.1, { discount: 10 })]);
  // 99.99 − 10.00 (9.999 → 10.00) = 89.99.
  assert.deepEqual(lineAmounts(inv), [89.99]);
  assert.match(sheetBlocks(sheetOf(inv)).map((b) => b.html).join(''), /33\.33<span class="loff">Rabatt 10 %<\/span>/);
});

test('a credit note for the whole invoice copies every position, Rabatt and texts included, and mirrors its figures exactly', () => {
  const inv: Issued = { ...issue(draft(painter()), { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-10-15T10:00:00Z' }), pdf: { file: 'x', sha256: 'x' } };
  const cn = creditNoteDraft(inv, { reason: 'Storno' }, env('cn'), '2026-10-20');
  assert.deepEqual(cn.lines.map((l) => l.kind ?? 'item'), ['text', 'item', 'item', 'subtotal', 'text', 'item', 'item', 'subtotal', 'discount']);
  assert.deepEqual((cn.lines[0] as { text: string }).text, 'Wohnzimmer', 'a text keeps its words');
  assert.deepEqual(rates(totals(cn)), rates(totals(inv)).map((r) => [r[0], -r[1], -r[2], -r[3]]));
  assert.deepEqual(revenueSplit(cn, -1751.11, '3200'), revenueSplit(inv, 1751.11, '3200').map((p) => ({ ...p, amount: -p.amount })));
  const gross = creditNoteDraft({ ...inv, prices: 'gross' }, { reason: '' }, env('cn2'), '2026-10-20');
  assert.equal(gross.prices, 'gross', 'the credit note is priced as its invoice');
});

test('write-off accounts: the firm\'s, else the jurisdiction\'s (KMU chart 3800 and 3805)', () => {
  assert.deepEqual(writeOffAccounts(undefined), { skonto: '3800', loss: '3805' });
  assert.deepEqual(writeOffAccounts({ writeOffAccount: { skonto: '3801', loss: '3806' } }), { skonto: '3801', loss: '3806' });
});

// ─── what a draft may hold ────────────────────────────────────────────────────

test('the API reads each kind; a unit is one of the firm\'s or one the draft holds; a Rabatt has a percent or an amount', () => {
  const book: InvoiceBook = { schema: INVOICES_SCHEMA, customers: [customer], invoices: [draft([item('Alt', 1, 'sack', 10, 8.1)], { id: 'in_old' })], sent: [] };
  const lines = parseDraftPatch({ lines: [
    { kind: 'text', text: 'Wohnzimmer', style: 'title' }, { kind: 'text', text: 'Hinweis', style: 'plain' }, { kind: 'subtotal', text: 'Total' },
    { kind: 'discount', text: 'Rabatt', percent: 3 }, { kind: 'pagebreak' }, { text: 'Wand', quantity: 4, unit: 'm2', price: 18.5, vatRate: 8.1, discount: 5 },
  ] }, book).lines;
  assert.deepEqual(lines, [
    { kind: 'text', text: 'Wohnzimmer', style: 'title' }, { kind: 'text', text: 'Hinweis' }, { kind: 'subtotal', text: 'Total' },
    { kind: 'discount', text: 'Rabatt', percent: 3 }, { kind: 'pagebreak' }, { text: 'Wand', quantity: 4, unit: 'm2', price: 18.5, vatRate: 8.1, discount: 5 },
  ]);
  const refused = (body: unknown, re: RegExp, id?: string) => assert.throws(() => parseDraftPatch(body, book, DEFAULT_UNITS, id), (e: Error) => re.test(e.message), re.source);
  refused({ lines: [{ text: 'X', quantity: 1, unit: 'sack', price: 1, vatRate: 8.1 }] }, /unit ist eine von h, day/);
  assert.equal((parseDraftPatch({ lines: [{ text: 'X', quantity: 1, unit: 'sack', price: 1, vatRate: 8.1 }] }, book, DEFAULT_UNITS, 'in_old').lines![0] as ItemLine).unit, 'sack', 'a unit removed from the list stays on the draft that holds it');
  refused({ lines: [{ kind: 'discount', text: 'R', percent: 3, amount: 5 }] }, /percent oder amount/);
  // A unit an issued document names passes, so «Als Entwurf kopieren» never fails on a unit removed from the list since.
  const issuedBook: InvoiceBook = { ...book, invoices: [{ ...draft([item('Alt', 1, 'fass', 10, 8.1)]), status: 'issued' } as unknown as Issued] };
  assert.equal((parseDraftPatch({ lines: [{ text: 'X', quantity: 1, unit: 'fass', price: 1, vatRate: 8.1 }] }, issuedBook).lines![0] as ItemLine).unit, 'fass');
  refused({ lines: [{ kind: 'flourish', text: 'R' }] }, /kind ist eine von item, text, subtotal, discount, pagebreak/);
  refused({ lines: [{ kind: 'pagebreak', text: 'x' }] }, /unbekannte Felder text/);
  refused({ prices: 'brutto' }, /prices ist net oder gross/);
  assert.deepEqual(missingForIssue(draft([item('A', 1, 'pcs', 1, 8.1), { kind: 'discount', text: 'R' }]), { customer, sender, invoices: [] }).map((m) => [m.field, m.line]), [['line.discount', 1]]);
  assert.deepEqual(missingForIssue(draft([{ kind: 'text', text: 'Nur Text' }]), { customer, sender, invoices: [] }).map((m) => m.field), ['lines'], 'a document needs one priced position');
});

test('the sheet edits each kind: a title or plain text, a Rabatt\'s value and mode, a position\'s discount; positions move; the prices switch drops a legacy flag', () => {
  const ctx = { customers: [customer], defaultTexts: { intro: '', closing: '' } };
  const d = draft(painter());
  const change = (key: string, value: string) => { const r = sheetEdit(d, key, value, ctx); return r && 'change' in r ? r.change.lines : r; };
  assert.deepEqual((change('l:0:style', 'plain') as InvoiceLine[])[0], { kind: 'text', text: 'Wohnzimmer' });
  assert.deepEqual((change('l:8:discount', '5') as InvoiceLine[])[8], { kind: 'discount', text: 'Rabatt', percent: 5 });
  assert.deepEqual((change('l:8:dmode', 'amount') as InvoiceLine[])[8], { kind: 'discount', text: 'Rabatt', amount: 3 }, 'the value stays, its mode changes');
  assert.deepEqual((change('l:1:discount', '10 %') as InvoiceLine[])[1], { ...(painter()[1] as ItemLine), discount: 10 });
  assert.deepEqual(sheetEdit(d, 'l:1:discount', '101', ctx), { refused: 'number' });
  assert.deepEqual(sheetEdit(d, 'l:1:discount', '-5', ctx), { refused: 'number' });
  assert.deepEqual(sheetEdit(d, 'l:1:unit', 'sack', ctx), { refused: 'value' });
  assert.deepEqual(sheetEdit(d, 'l:1:unit', 'pal', { ...ctx, units: [...DEFAULT_UNITS, { id: 'pal', de: 'Palette', fr: 'palette', it: 'paletta', en: 'pallet' }] }), { change: { lines: d.lines.map((l, i) => (i === 1 ? { ...l, unit: 'pal' } : l)) } });
  assert.deepEqual(moveLine(d.lines, 8, 0)?.map((l) => l.kind ?? 'item').slice(0, 2), ['discount', 'text']);
  assert.equal(moveLine(d.lines, 0, -1), undefined, 'nothing moves above the first');
  assert.deepEqual(repriced([item('A', 1, 'pcs', 1, 8.1, { vatIncluded: true }), { kind: 'pagebreak' }]), [item('A', 1, 'pcs', 1, 8.1), { kind: 'pagebreak' }]);
  // On screen: a handle to move each position, a button to add each kind, a page break's marker.
  const lines = painter();
  lines.splice(4, 0, { kind: 'pagebreak' });
  const screen = { qrPlaceholder: '', edit: { scope: 'draft' as const, customers: [{ id: 'cu_1', name: 'Familie Keller' }], customerId: 'cu_1', words: { newCustomer: '+', chooseCustomer: 'Kunde', addLine: 'Position', removeLine: '×', intro: 'I', closing: 'C', desc: 'Text', noExemption: 'Grund', supplied: 'Leistung', ...POSITION_WORDS } } };
  const html = sheetBlocks({ ...sheetOf(draft(lines)), screen }).map((b) => b.html).join('');
  assert.equal((html.match(/data-ia="move"/g) ?? []).length, lines.length);
  for (const a of ['addline', 'addtext', 'addsubtotal', 'adddiscount', 'addpagebreak']) assert.match(html, new RegExp(`data-ia="${a}"`));
  assert.match(html, /<tr class="pbreak scr" data-row="4"><td colspan="5"><span>Seitenumbruch<\/span>/);
  assert.match(html, /data-ed="l:9:dmode"/);
});

test('pagination: a page break ends its sheet and the next row starts under the repeated header; one at the end, two in a row or one first leave no blank sheet', () => {
  const blocks = [{}, { head: true }, { row: true }, { pagebreak: true }, { row: true }, {}];
  assert.deepEqual(paginate(blocks, [10, 8, 7, 0, 7, 20], { footer: true, qrBill: false }).pages, [[0, 1, 2, 3], [-1, 4, 5]]);
  assert.deepEqual(paginate([{}, { head: true }, { row: true }, { pagebreak: true }], [10, 8, 7, 0], { footer: true, qrBill: false }).pages, [[0, 1, 2, 3]]);
  assert.deepEqual(paginate([{}, { head: true }, { row: true }, { pagebreak: true }, { pagebreak: true }, { row: true }], [10, 8, 7, 0, 0, 7], { footer: true, qrBill: false }).pages, [[0, 1, 2, 3], [4, -1, 5]], 'two in a row are one');
  assert.deepEqual(paginate([{}, { head: true }, { pagebreak: true }, { row: true }], [10, 8, 0, 7], { footer: true, qrBill: false }).pages, [[0, 1, 2, 3]], 'one first breaks nothing');
});

// ─── invoices.json 2 → 3 keeps every figure ───────────────────────────────────

/** The totals and revenue split of schema 2, as they were computed before the kinds (src/invoices/rules.ts at 0.6.0): a line's own vatIncluded. */
type OldLine = { quantity: number; price: number; vatRate: number; vatIncluded?: true; account?: string };
function oldTotals(lines: readonly OldLine[]): Totals {
  const by = new Map<number, { net: number; incl: number }>();
  for (const l of lines) {
    const g = by.get(l.vatRate) ?? { net: 0, incl: 0 };
    g[l.vatIncluded ? 'incl' : 'net'] += toRappen(roundCHF(l.quantity * l.price));
    by.set(l.vatRate, g);
  }
  const byRate = [...by].sort(([a], [b]) => b - a).map(([rate, { net, incl }]) => {
    const onNet = toRappen(fromRappen(net) * rate / 100);
    const inIncl = toRappen(fromRappen(incl) * rate / (100 + rate));
    return { rate, net: fromRappen(net + incl - inIncl), vat: fromRappen(onNet + inIncl), gross: fromRappen(net + onNet + incl) };
  });
  const s = (k: 'net' | 'vat' | 'gross') => fromRappen(byRate.reduce((x, r) => x + toRappen(r[k]), 0));
  return { byRate, net: s('net'), vat: s('vat'), gross: s('gross') };
}
function oldSplit(lines: readonly OldLine[], exemption: Draft['exemption'], amount: number, revenueAccount: string) {
  const groupBy = <T, K>(xs: readonly T[], key: (x: T) => K) => { const m = new Map<K, T[]>(); for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]); return m; };
  const groups: Array<{ account: string; rate: number; gross: number }> = [];
  for (const [rate, ls] of groupBy(lines, (l) => l.vatRate)) {
    const rt = oldTotals(ls);
    for (const [account, as] of groupBy(ls, (l) => l.account ?? revenueAccount)) {
      const net = toRappen(oldTotals(as).net);
      groups.push({ account, rate, gross: net + (toRappen(rt.net) === 0 ? 0 : Math.round(toRappen(rt.vat) * net / toRappen(rt.net))) });
    }
  }
  const whole = groups.reduce((x, g) => x + g.gross, 0);
  const pay = toRappen(amount);
  let left = pay;
  return groups.map((g, k) => {
    const part = k === groups.length - 1 ? left : whole === 0 ? 0 : Math.round(pay * g.gross / whole);
    left -= part;
    return { account: g.account, vatCode: revenueVatCode(g.rate, exemption), amount: fromRappen(part) };
  }).filter((p) => p.amount !== 0);
}

/**
 * The demo's invoices.json as it shipped at schema 2 (0.6.0, kept in tests/fixtures), and a file that
 * mixes every kind of document schema 2 could hold. The other demos have no invoices.
 */
function schema2Files(): Array<[string, { schema: number; invoices: Array<Record<string, unknown>> }]> {
  const files: Array<[string, { schema: number; invoices: Array<Record<string, unknown>> }]> = [['demo', JSON.parse(readFileSync(join(APP_ROOT, 'tests/fixtures/invoices-schema2-demo.json'), 'utf8'))]];
  const doc = (id: string, lines: OldLine[], over: Record<string, unknown> = {}) => ({ ...draft([], { id }), status: 'issued', number: id, reference: `RF00${id}`, lines: lines.map((l) => ({ text: 'x', ...l })), ...over });
  files.push(['mixed', { schema: 2, invoices: [
    doc('net', [{ quantity: 3, price: 33.35, vatRate: 8.1 }, { quantity: 2, price: 17.5, vatRate: 2.6, account: '3400' }]),
    doc('gross', [{ quantity: 1, price: -500, vatRate: 8.1, vatIncluded: true }, { quantity: 1, price: -51.3, vatRate: 2.6, vatIncluded: true }], { kind: 'credit-note' }),
    doc('mix', [{ quantity: 1, price: 500, vatRate: 8.1, vatIncluded: true }, { quantity: 6, price: 95, vatRate: 8.1 }, { quantity: 1, price: 99.95, vatRate: 2.6, vatIncluded: true }]),
    doc('zero', [{ quantity: 1, price: 1200, vatRate: 0 }], { exemption: 'abroad' }),
    doc('zeroGross', [{ quantity: 1, price: 400, vatRate: 8.1, vatIncluded: true }, { quantity: 1, price: 50, vatRate: 0 }], { exemption: 'export' }),
  ] }]);
  return files;
}

test('invoices.json 2 → 3: every document of every demo and of a mixed file keeps its totals, VAT per rate, revenue split and reference', () => {
  // Each document the demo issued at schema 2 is in the demo as generated today (found by its kind, date and customer:
  // the demo gained documents since, so the numbers moved), with the same figures.
  const today = JSON.parse(readFileSync(join(APP_ROOT, 'demo/vanilla-accounting/invoices.json'), 'utf8')) as InvoiceBook;
  const shipped = schema2Files()[0][1];
  const issuedThen = shipped.invoices.filter((i) => i.status === 'issued');
  assert.ok(issuedThen.length > 0);
  for (const was of issuedThen) {
    const who = (was.customer as { name: string }).name;
    const now = today.invoices.filter((i): i is Issued => i.status === 'issued' && i.kind === was.kind && i.date === was.date && i.customer.name === who);
    assert.equal(now.length, 1, `${String(was.number)}: one ${String(was.kind)} of ${String(was.date)} to ${who} today`);
    assert.deepEqual(totals(now[0]), oldTotals(was.lines as OldLine[]), `${String(was.number)} (today ${now[0].number}): its figures`);
  }
  for (const [name, file] of schema2Files()) {
    assert.equal(file.schema, 2, `${name} ships at schema 2`);
    const now = climb<Record<string, unknown>>(file, 2, INVOICES_SCHEMA, INVOICES_MIGRATIONS, name, (x) => structuredClone(x)) as unknown as InvoiceBook;
    assert.equal(now.invoices.length, file.invoices.length);
    file.invoices.forEach((was, i) => {
      const inv = now.invoices[i];
      const old = was.lines as OldLine[];
      const what = `${name} ${String(was.number ?? was.id)}`;
      assert.ok(inv.prices === 'net' || inv.prices === 'gross', `${what} names its prices`);
      assert.deepEqual(totals(inv), oldTotals(old), `${what}: totals and VAT per rate`);
      for (const amount of [oldTotals(old).gross, 100, 0.05]) {
        assert.deepEqual(revenueSplit(inv, amount, '3200'), oldSplit(old, was.exemption as Draft['exemption'], amount, '3200'), `${what}: revenue of ${amount}`);
      }
      assert.equal((inv as Issued).reference, was.reference, `${what}: reference`);
      assert.ok(inv.lines.every((l) => l.kind === undefined), `${what}: every line is an item`);
      const named = [...new Set((was.lines as Array<{ unit?: string }>).flatMap((l) => (l.unit ? [l.unit] : [])))];
      if (was.status === 'issued' && named.length) assert.deepEqual((inv as Issued).units?.map((u) => u.id), named, `${what}: the units it printed, frozen`);
    });
  }
  // The demo's 2026-001 printed «3 h»: a reminder of it still prints «h», not today's «Std.».
  const demo = climb<Record<string, unknown>>(schema2Files()[0][1], 2, INVOICES_SCHEMA, INVOICES_MIGRATIONS, 'demo', (x) => structuredClone(x)) as unknown as InvoiceBook;
  const first = demo.invoices.find((i): i is Issued => i.status === 'issued' && i.number === '2026-001')!;
  assert.deepEqual(first.units, [{ id: 'pcs', de: 'Stk.', fr: 'pce', it: 'pz.', en: 'pcs' }, { id: 'h', de: 'h', fr: 'h', it: 'h', en: 'h' }]);
  assert.match(sheetBlocks({ ...sheetOf(first as unknown as Draft), units: first.units }).map((b) => b.html).join(''), /3 h</);
  // How each flag lands: a gross document drops its lines' flags; a net one keeps a gross line's as the exception.
  const one = (lines: OldLine[]) => pricesOfDocument({ lines }) as { prices: string; lines: Array<Record<string, unknown>> };
  assert.deepEqual(one([{ quantity: 1, price: 5, vatRate: 8.1, vatIncluded: true }, { quantity: 1, price: 5, vatRate: 0 }]), { prices: 'gross', lines: [{ quantity: 1, price: 5, vatRate: 8.1 }, { quantity: 1, price: 5, vatRate: 0 }] });
  assert.deepEqual(one([{ quantity: 1, price: 5, vatRate: 8.1, vatIncluded: true }, { quantity: 1, price: 5, vatRate: 8.1 }]), { prices: 'net', lines: [{ quantity: 1, price: 5, vatRate: 8.1, vatIncluded: true }, { quantity: 1, price: 5, vatRate: 8.1 }] });
  assert.deepEqual(one([{ quantity: 1, price: 5, vatRate: 0 }]), { prices: 'net', lines: [{ quantity: 1, price: 5, vatRate: 0 }] });
});
