/**
 * The rules of invoicing (src/invoices/rules.ts, reference.ts, sheet.ts): payment references,
 * totals, numbering, what an invoice needs before issue, issued = frozen, delete vs cancel,
 * credit notes, reminders, how a payment is split, and how blocks fall onto A4 sheets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQRReferenceValid, isSCORReferenceValid, calculateQRReferenceChecksum } from 'swissqrbill/utils';
import {
  allocate, cancel, creditNoteDraft, deleteDraft, issue, missingForIssue, nextNumber, openAmount, openOn, reminderDraft,
  revenueSplit, status, totals, withPayment, InvoiceRuleError,
} from '../src/invoices/rules.js';
import { isQrIban, parseReference, prettyReference, qrReference, referenceFor, scorReference } from '../src/invoices/reference.js';
import { PAGE, assembleSheets, paginate, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { DEFAULT_LAYOUT, type Customer, type Draft, type Invoice, type InvoiceLine, type Issued, type Sender } from '../src/invoices/model.js';

const QR_IBAN = 'CH4431999123000889012';
const sender: Sender = {
  name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789',
  address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' },
  payTo: { account: '1021', iban: 'CH6580808000000000001', qrIban: QR_IBAN, bank: 'Raiffeisen' },
};
const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' },
  language: 'de', paymentTermsDays: 30,
};
const env = (id: string) => ({ id, createdAt: '2026-10-01T09:00:00Z', origin: 'manual' as const, deleted: false });
const line = (quantity: number, price: number, vatRate: InvoiceLine['vatRate'], text = 'Leistung'): InvoiceLine => ({ text, quantity, price, vatRate });
const draft = (lines: InvoiceLine[], over: Partial<Draft> = {}): Draft => ({
  ...env('in_d'), status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-05', currency: 'CHF', language: 'de', lines, comments: [], ...over,
});
const issued = (d: Draft, invoices: Invoice[] = [], s: Sender | Omit<Sender, 'payTo'> = sender): Issued =>
  ({ ...issue(d, { customer, sender: s, layout: DEFAULT_LAYOUT, invoices, now: '2026-10-05T10:00:00Z' }), pdf: { file: 'x.pdf', sha256: 'x' } });

// ─── references ──────────────────────────────────────────────────────────────

test('QR reference: 26 digits from the number and the mod-10 check digit, as SIX defines it', () => {
  const ref = qrReference('2026-007');
  assert.equal(ref, '000000000000000000020260073');
  assert.equal(ref.at(-1), calculateQRReferenceChecksum(ref.slice(0, 26)), 'the same check digit as swissqrbill');
  assert.ok(isQRReferenceValid(ref));
  assert.deepEqual(parseReference('21 00000 00003 13947 14300 09017'), { kind: 'QRR', reference: '210000000003139471430009017' }, 'the example of the Swiss Implementation Guidelines');
  assert.equal(parseReference('210000000003139471430009018'), undefined, 'a wrong check digit is no reference');
  assert.equal(prettyReference(ref), '00 00000 00000 00000 00202 60073');
});

test('SCOR reference: RF, two ISO 11649 check digits, the number', () => {
  const ref = scorReference('2026-007');
  assert.equal(ref, 'RF922026007');
  assert.ok(isSCORReferenceValid(ref));
  assert.deepEqual(parseReference('rf92 2026 007'), { kind: 'SCOR', reference: 'RF922026007' }, 'spaces and case do not matter');
  assert.equal(parseReference('RF932026007'), undefined, 'wrong check digits');
});

test('QR-IBAN needs QRR, a plain IBAN SCOR', () => {
  assert.ok(isQrIban(QR_IBAN));
  assert.ok(!isQrIban('CH6580808000000000001'));
  assert.match(referenceFor('2026-001', { qrIban: QR_IBAN }), /^\d{27}$/);
  assert.match(referenceFor('2026-001', {}), /^RF\d{2}2026001$/);
});

// ─── totals ──────────────────────────────────────────────────────────────────

test('totals: net per line to the Rappen, VAT per rate on its net, no 5-Rappen rounding', () => {
  const t = totals([line(1, 1800, 8.1), line(6, 95, 8.1), line(3, 33.35, 2.6)]);
  assert.deepEqual(t.byRate, [
    { rate: 8.1, net: 2370, vat: 191.97, gross: 2561.97 },
    { rate: 2.6, net: 100.05, vat: 2.6, gross: 102.65 },
  ]);
  assert.deepEqual([t.net, t.vat, t.gross], [2470.05, 194.57, 2664.62]);
  assert.equal(totals([line(1, 0.05, 8.1)]).byRate[0].vat, 0, '0.00405 rounds to 0.00');
  assert.equal(totals([line(-2, 110, 8.1)]).gross, -237.82, 'a credit note is negative');
});

// ─── numbering ───────────────────────────────────────────────────────────────

test('numbers: the next of the invoice year, cancelled ones count, drafts never have one', () => {
  const a = issued(draft([line(1, 100, 8.1)]));
  assert.equal(a.number, '2026-001');
  const b = issued(draft([line(1, 100, 8.1)], { id: 'in_b' }), [a]);
  assert.equal(b.number, '2026-002');
  const cancelledB = cancel(b, { date: '2026-10-06', reason: 'Fehler' });
  const next = [a, cancelledB, draft([line(1, 1, 8.1)], { id: 'in_x' })];
  assert.equal(nextNumber(next, '2026-12-31'), '2026-003', 'a cancelled number is never given again');
  assert.equal(nextNumber(next, '2027-01-02'), '2027-001', 'each year starts at 001');
  assert.equal('number' in draft([]), false);
});

// ─── issuing ─────────────────────────────────────────────────────────────────

test('Art. 26 MWSTG: issue refuses an invoice that lacks what the law asks', () => {
  const ok = draft([line(1, 100, 8.1)]);
  assert.deepEqual(missingForIssue(ok, { customer, sender, invoices: [] }), []);
  const fields = (m: ReturnType<typeof missingForIssue>) => m.map((x) => x.field + (x.line === undefined ? '' : `#${x.line}`));
  assert.deepEqual(fields(missingForIssue(draft([line(0, 100, 8.1, ' ')]), {
    customer: { ...customer, address: { ...customer.address, postcode: '' } },
    sender: { ...sender, uid: '', address: { postcode: '8000', town: 'Zürich', country: 'CH' } }, invoices: [],
  })), ['sender.address', 'sender.uid', 'customer.address', 'line.text#0', 'line.quantity#0']);
  assert.deepEqual(fields(missingForIssue(draft([line(1, 100, 0)]), { customer, sender, invoices: [] })), ['exemption'], 'a line without VAT needs its reason');
  assert.deepEqual(fields(missingForIssue(draft([]), { customer: undefined, sender: { ...sender, payTo: undefined }, invoices: [] })), ['payTo', 'customer', 'lines']);
  assert.throws(() => issued(draft([line(1, 100, 0)])), (e: InvoiceRuleError) => e.code === 'incomplete' && e.missing?.[0].field === 'exemption');
});

test('issue: number, due date from the customer terms, QR reference, frozen customer and sender', () => {
  const inv = issued(draft([line(2, 50, 8.1)]));
  assert.equal(inv.status, 'issued');
  assert.equal(inv.dueDate, '2026-11-04');
  assert.equal(inv.reference, qrReference('2026-001'));
  assert.deepEqual(inv.customer.address, customer.address);
  assert.equal(inv.sender.payTo.qrIban, QR_IBAN);
  assert.equal(issued(draft([line(1, 1, 8.1)], { dueDate: '2026-10-20' })).dueDate, '2026-10-20', 'a due date set on the draft is kept');
  assert.throws(() => issue(inv as unknown as Draft, { customer, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '' }), (e: InvoiceRuleError) => e.code === 'notDraft', 'issued is frozen');
});

test('a draft is deleted (a flag); an issued invoice is cancelled, keeping its number', () => {
  const d = draft([line(1, 100, 8.1)]);
  assert.equal(deleteDraft(d).deleted, true);
  const inv = issued(d);
  assert.throws(() => deleteDraft(inv), (e: InvoiceRuleError) => e.code === 'notDraft');
  assert.throws(() => cancel(d, { date: '2026-10-06', reason: '' }), (e: InvoiceRuleError) => e.code === 'notIssued');
  const c = cancel(inv, { date: '2026-10-06', reason: ' Auftrag zurückgezogen ' });
  assert.deepEqual([c.number, c.cancelled], ['2026-001', { date: '2026-10-06', reason: 'Auftrag zurückgezogen' }]);
  assert.equal(status(c, [c]), 'cancelled');
  assert.equal(openAmount(c, [c]), 0, 'a cancelled invoice is off the open invoices');
  assert.throws(() => cancel(c, { date: '2026-10-07', reason: '' }), (e: InvoiceRuleError) => e.code === 'cancelled');
});

test('a paid invoice is not cancelled: it gets a credit note for the full amount', () => {
  const inv = withPayment(issued(draft([line(1, 100, 8.1)])), { transactionRef: 'T1', date: '2026-10-10', amount: 108.1, by: 'reference' });
  assert.equal(status(inv, [inv]), 'paid');
  assert.throws(() => cancel(inv, { date: '2026-10-11', reason: '' }), (e: InvoiceRuleError) => e.code === 'paid');
  const credit = creditNoteDraft(inv, { reason: 'Storno' }, env('in_c'), '2026-10-11');
  assert.deepEqual([credit.kind, credit.creditFor, totals(credit.lines).gross], ['credit-note', inv.id, -108.1]);
  assert.equal(credit.lines[0].text, 'Leistung (Storno)');
});

test('credit notes: a part over the invoice rates, or at one rate; they reduce what is open; more than the invoice is refused', () => {
  const inv = issued(draft([line(1, 1000, 8.1), line(10, 50, 2.6)]));
  const all = [inv];
  const part = creditNoteDraft(inv, { amount: 100, reason: 'Rabatt' }, env('in_p'), '2026-10-12');
  assert.equal(part.lines.length, 2);
  assert.ok(Math.abs(totals(part.lines).gross + 100) <= 0.01, 'the parts make the amount, give or take the VAT rounding of a Rappen');
  const one = creditNoteDraft(inv, { amount: 51.3, vatRate: 2.6, reason: '1 Sack' }, env('in_o'), '2026-10-12');
  assert.deepEqual(one.lines.map((l) => [l.vatRate, l.quantity, l.price]), [[2.6, -1, 50]]);
  const credited: Issued = { ...issued(one, all), id: 'in_o' };
  assert.equal(openAmount(inv, [inv, credited]), Math.round((totals(inv.lines).gross - 51.3) * 100) / 100);
  assert.equal(openAmount(inv, [inv, credited], '2026-10-01'), totals(inv.lines).gross, 'a credit note written later does not count for an earlier payment');
  const tooMuch = { ...creditNoteDraft(inv, { reason: '' }, env('in_t'), '2026-10-12') };
  assert.deepEqual(missingForIssue(tooMuch, { customer, sender, invoices: [inv, credited] }).map((m) => m.field), ['credit.exceeds']);
  assert.throws(() => creditNoteDraft(inv, { amount: 99999, reason: '' }, env('in_x'), '2026-10-12'), (e: InvoiceRuleError) => e.code === 'incomplete');
});

test('reminders: the next level in the invoice language, due in 10 days; not for paid, cancelled or credit notes', () => {
  const inv = issued(draft([line(1, 100, 8.1)], { language: 'fr' }));
  const r1 = reminderDraft(inv, [inv], '2026-11-20', 20);
  assert.deepEqual([r1.level, r1.dueDate, r1.fee], [1, '2026-11-30', 20]);
  assert.match(r1.intro, /^Notre facture 2026-001 du 05\.10\.2026 était payable le 04\.11\.2026\./);
  const withR1 = { ...inv, reminders: [{ ...r1, documentId: 'sd_1' }] };
  const r2 = reminderDraft(withR1, [withR1], '2026-12-05');
  assert.equal(r2.level, 2);
  assert.match(r2.intro, /^Malgré notre rappel du 20\.11\.2026/);
  const de = issued(draft([line(1, 100, 8.1)]));
  assert.match(reminderDraft(de, [de], '2026-11-20').intro, /^Unsere Rechnung 2026-001 vom 05\.10\.2026 war am 04\.11\.2026 fällig\./);
  const paid = withPayment(de, { transactionRef: 'T', date: '2026-11-01', amount: 108.1, by: 'reference' });
  assert.throws(() => reminderDraft(paid, [paid], '2026-11-20'), (e: InvoiceRuleError) => e.code === 'nothingOpen');
  const cx = cancel(de, { date: '2026-10-10', reason: '' });
  assert.throws(() => reminderDraft(cx, [cx], '2026-11-20'), (e: InvoiceRuleError) => e.code === 'cancelled');
});

// ─── payments ────────────────────────────────────────────────────────────────

test('allocate: what is open first, then unpaid reminder fees; more is a surplus, never booked', () => {
  const inv = { ...issued(draft([line(1, 100, 8.1)])), reminders: [{ level: 1, date: '2026-11-20', dueDate: '2026-11-30', fee: 20, intro: '', closing: '', documentId: 'sd' }] };
  assert.deepEqual(allocate(inv, [inv], 50), { amount: 50, fee: 0, surplus: 0 });
  assert.deepEqual(allocate(inv, [inv], 128.1), { amount: 108.1, fee: 20, surplus: 0 });
  assert.deepEqual(allocate(inv, [inv], 130), { amount: 108.1, fee: 20, surplus: 1.9 });
  const part = withPayment(inv, { transactionRef: 'T1', date: '2026-11-01', amount: 50, by: 'reference' });
  assert.equal(status(part, [part]), 'partly-paid');
  assert.equal(openAmount(part, [part]), 58.1);
  assert.equal(withPayment(part, { transactionRef: 'T1', date: '2026-11-01', amount: 50, by: 'reference' }), part, 'the same transaction is counted once');
});

test('open on 31.12.: issued by then, less what was paid and cancelled by then; a later payment still leaves it open', () => {
  const inv = withPayment(issued(draft([line(1, 100, 8.1)])), { transactionRef: 'T1', date: '2026-12-10', amount: 50, by: 'reference' });
  const paidLater = withPayment(inv, { transactionRef: 'T2', date: '2027-01-15', amount: 58.1, by: 'reference' });
  assert.equal(openOn(paidLater, [paidLater], '2026-12-31'), 58.1);
  assert.equal(openAmount(paidLater, [paidLater]), 0);
  assert.equal(openOn(paidLater, [paidLater], '2026-10-04'), 0, 'not issued yet');
  const cancelledLater = cancel(issued(draft([line(1, 100, 8.1)])), { date: '2027-01-05', reason: 'x' });
  assert.equal(openOn(cancelledLater, [cancelledLater], '2026-12-31'), 108.1, 'cancelled only in the new year');
  assert.equal(openOn(cancelledLater, [cancelledLater], '2027-01-05'), 0);
});

test('revenue of a payment: split like the invoice over accounts and rates, the parts add up exactly', () => {
  const inv = draft([line(20, 28, 2.6), { ...line(3, 120, 8.1), account: '3600' }]);
  assert.deepEqual(revenueSplit(inv, 963.72, '3300'), [
    { account: '3300', vatCode: 'V26', amount: 574.56 },
    { account: '3600', vatCode: 'V81', amount: 389.16 },
  ]);
  const half = revenueSplit(inv, 481.86, '3300');
  assert.equal(Math.round(half.reduce((s, p) => s + p.amount, 0) * 100) / 100, 481.86);
  assert.deepEqual(revenueSplit(draft([line(1, 500, 0)], { exemption: 'abroad' }), 500, '3300'), [{ account: '3300', vatCode: 'V0-E', amount: 500 }]);
  assert.deepEqual(revenueSplit(draft([line(1, 500, 0)], { exemption: 'export' }), 500, '3300'), [{ account: '3300', vatCode: 'V0', amount: 500 }]);
});

// ─── the sheet ───────────────────────────────────────────────────────────────

const sheet = (lines: number): SheetData => ({
  kind: 'invoice', language: 'de', number: '2026-001', date: '2026-10-05', dueDate: '2026-11-04', currency: 'CHF', customer, sender,
  lines: Array.from({ length: lines }, (_, i) => line(1, 10, 8.1, `Position ${i + 1}`)), intro: 'Intro', closing: 'Gruss',
  layout: DEFAULT_LAYOUT, reference: qrReference('2026-001'),
});

/** Block heights as a sheet measures them: title 15 mm, intro 10, table header 8, each row 7, totals 25, closing 12. */
function pagesFor(lines: number) {
  const blocks = sheetBlocks(sheet(lines));
  const mm = blocks.map((b, i) => (b.head ? 8 : b.row ? 7 : i === 0 ? 15 : b.html.includes('class="intro"') ? 10 : b.html.includes('class="sum"') ? 25 : 12));
  return { blocks, ...paginate(blocks, mm, { footer: true, qrBill: true }) };
}

test('blocks: one per table row, so a long table breaks between rows', () => {
  const { blocks } = pagesFor(30);
  assert.equal(blocks.filter((b) => b.row).length, 30);
  assert.equal(blocks.filter((b) => b.head).length, 1);
});

test('pagination: line count → sheets, the QR-bill on the last sheet or on one of its own', () => {
  const sheets = (n: number) => { const p = pagesFor(n); return p.pages.length + (p.qrOwnPage ? 1 : 0); };
  assert.equal(sheets(1), 1, '88 + 15 + 10 + 8 + 7 + 25 + 12 = 165 mm leaves the bottom 105 mm for the QR-bill');
  assert.equal(sheets(2), 1, 'a 2-line invoice: one page with its QR-bill');
  assert.equal(sheets(4), 1, 'ending at 186 mm it still fits: the QR-bill sheet has no footer to make room for');
  assert.equal(sheets(5), 2, 'at 193 mm the QR-bill no longer fits: it gets a sheet of its own');
  const thirty = pagesFor(30);
  assert.deepEqual(thirty.pages.map((p) => p.filter((i) => i >= 0 && thirty.blocks[i].row).length), [21, 9], `21 rows fit above the footer (limit ${PAGE.bottom - PAGE.footer} mm)`);
  assert.equal(thirty.pages[1][0], -1, 'page 2 repeats the table header');
  assert.equal(thirty.qrOwnPage, false);
  assert.equal(sheets(60), 3);
});

test('the sheet that carries the QR-bill has no footer; the others keep it', () => {
  const d = sheet(30);
  const blocks = sheetBlocks(d);
  const html = assembleSheets(d, blocks, { pages: [[0, 1, 2], [-1, 3]], qrOwnPage: false });
  const pages = html.split('<div class="a4 ').slice(1);
  assert.match(pages[0], /class="foot"/);
  assert.match(pages[1], /has-qr/);
  assert.doesNotMatch(pages[1], /class="foot"/);
  assert.match(pages[1], /class="foot bare"><span class="pno">Seite 2 von 2/, 'the page number stays');
});

test('pagination: a table header never ends a page alone', () => {
  const blocks = [{}, { head: true }, { row: true }, { row: true }];
  const { pages } = paginate(blocks, [177, 8, 7, 7], { footer: true, qrBill: false });
  assert.deepEqual(pages, [[0], [1, 2, 3]]);
});

test('the sheet on screen: a draft edited in place names each field; texts-only editing leaves the lines alone; a printed sheet has neither', () => {
  const words = { newCustomer: 'Neuer Kunde', chooseCustomer: 'Kunde wählen', addLine: 'Position', removeLine: 'Position entfernen', intro: 'Text vor der Tabelle', closing: 'Text nach den Kosten', desc: 'Beschreibung', noExemption: 'Grund für 0 %' };
  const draft: SheetData = { ...sheet(2), number: undefined, reference: undefined, lines: [line(1, 10, 8.1, 'A'), line(2, 5, 0, 'B')] };
  const screen = { qrPlaceholder: 'QR-Zahlteil beim Ausstellen', edit: { scope: 'draft' as const, customers: [{ id: 'cu_1', name: 'Kunde AG' }], customerId: 'cu_1', words } };
  const edited = sheetBlocks({ ...draft, screen }).map((b) => b.html).join('');
  const keys = [...edited.matchAll(/data-ed="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['date', 'dueDate', 'intro', 'l:0:text', 'l:0:quantity', 'l:0:unit', 'l:0:price', 'l:0:vatRate', 'l:1:text', 'l:1:quantity', 'l:1:unit', 'l:1:price', 'l:1:vatRate', 'exemption', 'closing']);
  assert.match(edited, /data-ia="addline"/);
  assert.equal((edited.match(/data-ia="rmline"/g) ?? []).length, 2);
  const blocks = sheetBlocks({ ...draft, screen });
  const page = assembleSheets({ ...draft, screen }, blocks, { pages: [blocks.map((_, i) => i)], qrOwnPage: false });
  assert.match(page, /<select class="ed edsel" data-ed="customer"><option value="cu_1" selected>Kunde AG<\/option><option value="\+">/);
  assert.match(page, /<div class="qrb ph"><span>QR-Zahlteil beim Ausstellen<\/span>/);

  const texts = sheetBlocks({ ...sheet(2), screen: { ...screen, edit: { ...screen.edit, scope: 'texts' } } }).map((b) => b.html).join('');
  assert.deepEqual([...texts.matchAll(/data-ed="([^"]+)"/g)].map((m) => m[1]), ['intro', 'closing']);

  const printed = sheetBlocks(draft).map((b) => b.html).join('');
  assert.doesNotMatch(printed, /data-ed|contenteditable|data-ia/);
});
