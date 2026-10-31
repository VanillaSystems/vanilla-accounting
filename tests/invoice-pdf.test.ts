/**
 * Invoice PDFs (ADR 0012): printed by the installed Chromium from the HTML sheet, stored once,
 * byte-exact with their SHA-256, and read back as stored, never printed again. Needs Chrome, Edge,
 * Brave or Chromium; without one the tests are skipped, saying so.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser, renderPdf, stampDates } from '../src/invoices/pdf.js';
import { createCustomer, createDraft, issueInvoice, issuedPdf, logoSrc, recordSend, sendReminder, cancelInvoice, updateDraft } from '../src/invoices/service.js';
import { issuedSheet } from '../src/invoices/documents.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { loadInvoices, storePdf } from '../src/invoices/store.js';
import { InvoiceRuleError } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type InvoiceLine, type Issued } from '../src/invoices/model.js';
import { qrReference } from '../src/providers/qr-bill/reference.js';
import type { SheetData } from '../src/invoices/sheet.js';
import { DEMO_ROOT, tempWorkspace } from './support/workspace.js';
import { browserPath } from './support/browser.js';

const skip = browserPath ? false : 'no Chromium-based browser installed (Chrome, Edge, Brave or Chromium; or set CHROME_PATH)';
after(() => closeBrowser());

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const lines = (n: number): InvoiceLine[] => Array.from({ length: n }, (_, i) => ({ text: `Espresso-Mischung ${i + 1}`, quantity: 2, unit: 'pcs', price: 24.5, vatRate: 8.1 }));

function sheet(n: number): SheetData {
  return {
    kind: 'invoice', language: 'de', number: '2026-007', date: '2026-10-11', dueDate: '2026-11-10', currency: 'CHF',
    customer: { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30 },
    sender: { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' },
      payTo: { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012' } },
    lines: lines(n), intro: '', closing: 'Freundliche Grüsse', layout: { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, intro: false } },
    reference: qrReference('2026-007'),
  };
}

test('line count → pages of the printed PDF, the QR-bill on the last', { skip }, async () => {
  for (const [n, pages] of [[1, 1], [25, 2], [60, 3]] as const) {
    const out = await renderPdf(sheet(n), '2026-10-11T12:00:00Z');
    assert.equal(out.pages, pages, `${n} lines`);
    assert.equal(pageCount(out.pdf), pages, `${n} lines: the PDF has as many pages as the sheet`);
  }
});

test('a short invoice prints on one page with its QR-bill: the demo 2026-001, two lines at two rates', { skip }, async () => {
  const ws = workspaceAt(DEMO_ROOT);
  const book = loadInvoices(ws);
  const inv = book.invoices.find((i): i is Issued => i.status === 'issued' && i.number === '2026-001')!;
  assert.equal(inv.lines.length, 2);
  const out = await renderPdf(issuedSheet(book, inv, logoSrc(ws, inv.layout.logo)), inv.issuedAt);
  assert.equal(out.pages, 1);
  assert.equal(pageCount(out.pdf), 1);
  assert.match(out.html, /class="a4 [^"]*has-qr/);
});

test('the same sheet printed twice gives the same bytes; the PDF dates are the document time', { skip }, async () => {
  const a = await renderPdf(sheet(3), '2026-10-11T12:34:56Z');
  const b = await renderPdf(sheet(3), '2026-10-11T12:34:56Z');
  assert.equal(sha(a.pdf), sha(b.pdf));
  assert.match(a.pdf.toString('latin1'), /\/CreationDate \(D:20261011123456/);
  assert.match(a.pdf.toString('latin1'), /\/ModDate \(D:20261011123456/);
  assert.equal(stampDates(a.pdf, '2026-10-11T12:34:56Z').length, a.pdf.length, 'stamping keeps every offset');
});

test('issue stores the PDF byte-exact with its checksum; it is read back as stored, never printed again', { skip }, async () => {
  const ws = tempWorkspace('invoice-pdf-');
  mkdirSync(ws.paths.logos, { recursive: true });
  copyFileSync(join(DEMO_ROOT, 'logos/logo.svg'), join(ws.paths.root, 'logos/logo.svg'));
  const c = createCustomer(ws, { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', email: 'a@b.example' });
  const d = createDraft(ws, { customerId: c.id, date: '2026-10-11', lines: lines(2) }, '2026-10-11T08:00:00Z');
  const inv = await issueInvoice(ws, d.id, { now: '2026-10-11T09:00:00Z' });
  assert.equal(inv.number, '2026-001');
  const onDisk = readFileSync(join(ws.paths.root, inv.pdf.file));
  assert.equal(inv.pdf.file, 'transactional-data/2026/invoices/2026-001.pdf');
  assert.equal(sha(onDisk), inv.pdf.sha256);
  assert.ok(issuedPdf(ws, '2026-001').equals(onDisk));
  assert.match(onDisk.toString('latin1'), /\/CreationDate \(D:20261011090000/);

  assert.throws(() => updateDraft(ws, d.id, { subject: 'neu' }), (e: InvoiceRuleError) => e.code === 'notDraft', 'issued is frozen');
  assert.throws(() => storePdf(ws, '2026', '2026-001.pdf', Buffer.from('other')), /never replaced/);

  const sent = await recordSend(ws, d.id, { now: '2026-10-11T09:01:00Z' });
  const resent = await recordSend(ws, d.id, { to: 'x@y.example', now: '2026-10-12T09:00:00Z' });
  assert.deepEqual([sent.kind, sent.to, sent.sha256, resent.kind, resent.file], ['invoice', 'a@b.example', inv.pdf.sha256, 'resend', inv.pdf.file], 'a resend is the same bytes');

  const { sent: reminder } = await sendReminder(ws, d.id, { date: '2026-11-20', fee: 20 }, { now: '2026-11-20T08:00:00Z' });
  assert.equal(sha(readFileSync(join(ws.paths.root, reminder.file))), reminder.sha256);
  assert.match(reminder.file, /^transactional-data\/2026\/invoices\/sent\/sd_.+\.pdf$/);
  const { invoice: cancelled, sent: notice } = await cancelInvoice(ws, d.id, { date: '2026-11-25', reason: 'Fehler', notify: true }, { now: '2026-11-25T08:00:00Z' });
  assert.deepEqual([cancelled.number, notice?.kind], ['2026-001', 'cancellation']);
  assert.ok(issuedPdf(ws, '2026-001').equals(onDisk), 'cancelling never touches the issued PDF');

  writeFileSync(join(ws.paths.root, inv.pdf.file), Buffer.concat([onDisk, Buffer.from(' ')]));
  assert.throws(() => issuedPdf(ws, '2026-001'), /no longer matches its checksum/);
  assert.equal((loadInvoices(ws).invoices[0] as Issued).reminders[0].fee, 20);
});
