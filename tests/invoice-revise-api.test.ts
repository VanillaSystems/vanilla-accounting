/**
 * «Zurück zum Entwurf» and «Konten ändern» at the API, on the agreed basis (docs/specs/invoicing.md
 * 4.4.2, 4.11, P2.7): the real server on a temp workspace whose manifest reports on the agreed
 * basis, closed through 2026-06-30, with three issued invoices and their VAT events (written as the
 * books stood when they were booked, so no browser prints). A document whose event lies in the filed
 * quarter stays issued (403); an open one goes back with its event, link and receipt; a sent one is
 * refused with `sent`; a change of accounts of the filed one books a reclassification in the open
 * period and leaves the filed event as it is.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { appFolderIn, MANIFEST_FILE } from '../src/workspace/workspace.js';
import { issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type Draft, type InvoiceBook, type Issued } from '../src/invoices/model.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

let api: ApiServer;
const customer = { id: 'cu_p', createdAt: '', origin: 'manual' as const, deleted: false, name: 'Beispiel Bistro AG', address: { street: 'Seeweg', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
const sender = { name: 'Muster', uid: 'CHE-123.456.789', address: { street: 'Weg', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1021', iban: 'CH6580808000000000001' } };
const pdfOf = (n: string) => Buffer.from(`%PDF-1.4 Rechnung ${n}`);
const book = (): InvoiceBook => JSON.parse(readFileSync(join(api.root, 'invoices.json'), 'utf8')) as InvoiceBook;
const rows = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]);

before(async () => {
  const agreed = mkdtempSync(join(tmpdir(), 'belege-agreed-'));
  const manifest = readFileSync(join(appFolderIn(DEMO_ROOT) ?? DEMO_ROOT, MANIFEST_FILE), 'utf8');
  writeFileSync(join(agreed, MANIFEST_FILE), manifest.replace('reporting: received', 'reporting: agreed'));
  api = await startApi('tests/fixtures/period-lock-index.json', {}, { manifestOf: agreed });
  const invoices: Issued[] = [];
  for (const [id, date] of [['in_a', '2026-06-10'], ['in_b', '2026-08-10'], ['in_c', '2026-08-12']] as const) {
    const draft: Draft = { id, createdAt: `${date}T08:00:00Z`, origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_p', date, currency: 'CHF', language: 'de', comments: [], lines: [{ text: 'Leistung', quantity: 1, price: 100, vatRate: 8.1 }] };
    const inv = issue(draft, { customer, sender, layout: DEFAULT_LAYOUT, invoices, now: `${date}T09:00:00Z` });
    const pdf = pdfOf(inv.number);
    const file = `transactional-data/2026/invoices/${inv.number}.pdf`;
    mkdirSync(join(api.root, 'transactional-data/2026/invoices'), { recursive: true });
    writeFileSync(join(api.root, file), pdf);
    invoices.push({ ...inv, pdf: { file, sha256: createHash('sha256').update(pdf).digest('hex') } });
  }
  writeFileSync(join(api.root, 'invoices.json'), JSON.stringify({ schema: 3, customers: [customer], invoices, sent: [] }));
  // Their events as booked on their dates, each with the receipt its PDF became (src/invoices/events.ts).
  const books = loadBooks(api.ws);
  mkdirSync(join(api.root, 'transactional-data/2026/receipts'), { recursive: true });
  for (const inv of invoices) {
    const receipt = createHash('sha256').update(pdfOf(inv.number)).digest('hex').slice(0, 16);
    const filename = `${inv.date.replace(/-/g, '')}-rechnung-${inv.number}.pdf`;
    writeFileSync(join(api.root, 'transactional-data/2026/receipts', filename), pdfOf(inv.number));
    books.receipts.push({ id: receipt, filename, originalFilename: filename, extractedText: `Rechnung ${inv.number}`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: `${inv.date}T10:00:00Z`, location: 'archived', date: inv.date, amount: 108.1, currency: 'CHF', kind: 'sales-record' });
    books.journalEntries.push({ id: `je_${inv.id}`, transactionRef: `RE-${inv.number}`, date: inv.date, accountDebit: '1100', accountCredit: '3300', amount: 108.1, vatCode: 'V81', description: `Rechnung ${inv.number} ${customer.name}`, origin: 'invoice', receipts: [receipt] });
    books.mappings.push({ transactionRef: `RE-${inv.number}`, receiptId: receipt, by: 'rule', rule: 'invoice-issue' });
  }
  saveBooks(api.ws, books);
});
after(() => api?.stop());

test('back to draft: refused while the event lies in the filed quarter (403), the document as it was', async () => {
  const before = readFileSync(join(api.root, 'invoices.json'), 'utf8');
  const r = await api.send('POST', '/api/invoices/in_a/draft');
  assert.equal(r.status, 403, String(r.json.error));
  assert.equal(r.json.code, 'periodClosed');
  assert.equal(readFileSync(join(api.root, 'invoices.json'), 'utf8'), before);
  assert.ok(existsSync(join(api.root, 'transactional-data/2026/invoices/2026-001.pdf')), 'its PDF where it was');
  assert.deepEqual(rows('RE-2026-001'), [['2026-06-10', '1100', '3300', 108.1, 'V81']]);
});

test('P2.7 at the API: back to draft of an unsent invoice takes RE- off the open quarter with its link and receipt; the number stays', async () => {
  const receiptFile = join(api.root, 'transactional-data/2026/receipts/20260810-rechnung-2026-002.pdf');
  assert.ok(existsSync(receiptFile));
  const r = await api.send('POST', '/api/invoices/in_b/draft');
  assert.equal(r.status, 200, String(r.json.error));
  assert.deepEqual([r.json.status, r.json.number], ['draft', '2026-002']);
  const books = loadBooks(api.ws);
  assert.deepEqual(rows('RE-2026-002'), [], 'RE-2026-002 is gone from the open quarter');
  assert.equal(books.mappings.some((m) => m.transactionRef === 'RE-2026-002'), false);
  assert.equal(books.receipts.some((x) => x.filename === '20260810-rechnung-2026-002.pdf'), false);
  assert.equal(existsSync(receiptFile), false, 'its receipt file too: issued again, the new PDF is filed under that name');
  assert.ok(existsSync(join(api.root, 'transactional-data/2026/invoices/2026-002.replaced-1.pdf')), 'the PDF stays, as replaced');
  const pdf = await api.fetch('/api/invoices/in_b/replaced/1.pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).toString(), '%PDF-1.4 Rechnung 2026-002', 'and is served byte for byte');
  assert.deepEqual(rows('RE-2026-001').length, 1, 'the other invoices\' events stay');
});

test('back to draft of a sent invoice: refused with `sent`, nothing changed (MWSTG Art. 27 Abs. 2)', async () => {
  const sent = await api.send('POST', '/api/invoices/in_c/send', { to: 'download' });
  assert.equal(sent.status, 200, String(sent.json.error));
  const r = await api.send('POST', '/api/invoices/in_c/draft');
  assert.deepEqual([r.status, r.json.invoiceRefusal], [409, 'sent'], String(r.json.error));
  assert.equal(book().invoices.find((i) => i.id === 'in_c')?.status, 'issued');
  assert.equal(rows('RE-2026-003').length, 1);
});

test('Konten ändern of the filed invoice: its plan, then a reclassification without a code in the open period; the filed event as filed', async () => {
  const req = { lines: [{ line: 0, account: '3400' }], date: '2026-08-15' };
  const plan = await api.send('POST', '/api/invoices/in_a/accounts/plan', req);
  assert.equal(plan.status, 200, String(plan.json.error));
  assert.deepEqual(plan.json.reclass, [{ ref: 'RE-2026-001-kk-1', number: '2026-001', date: '2026-08-15', moves: [{ from: '3300', to: '3400', amount: 108.1 }] }]);
  assert.deepEqual(rows('RE-2026-001-kk-1'), [], 'the plan writes nothing');
  const bad = await api.send('POST', '/api/invoices/in_a/accounts', { lines: [{ line: 0, account: '6500' }] });
  assert.deepEqual([bad.status, bad.json.invoiceRefusal], [400, 'account']);
  const r = await api.send('POST', '/api/invoices/in_a/accounts', req);
  assert.equal(r.status, 200, String(r.json.error));
  assert.deepEqual(rows('RE-2026-001'), [['2026-06-10', '1100', '3300', 108.1, 'V81']], 'the filed event stays');
  assert.deepEqual(rows('RE-2026-001-kk-1'), [['2026-08-15', '3300', '3400', 108.1, undefined]]);
  const inv = book().invoices.find((i) => i.id === 'in_a') as Issued;
  assert.equal((inv.lines[0] as { account?: string }).account, '3400', 'the position records the new account');
  assert.deepEqual(inv.accountChanges?.map((c) => [c.lines, c.refs, c.reclass]), [[[{ line: 0, from: '3300', to: '3400' }], [], 'RE-2026-001-kk-1']], 'and its history says so');
  assert.equal(inv.pdf.sha256, createHash('sha256').update(pdfOf('2026-001')).digest('hex'), 'the PDF stays as issued');
});
