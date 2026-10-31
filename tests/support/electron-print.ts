/**
 * Run inside Electron by tests/desktop-print.test.ts: prints invoice sheets with the desktop app's
 * printer (src/desktop/print.ts) and writes what it found as one JSON line to stdout.
 */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { renderPdf, usePrintPages } from '../../src/invoices/pdf.js';
import { electronPage } from '../../src/desktop/print.js';
import { issuedSheet } from '../../src/invoices/documents.js';
import { logoSrc } from '../../src/invoices/service.js';
import { loadInvoices } from '../../src/invoices/store.js';
import { DEFAULT_LAYOUT, type InvoiceLine, type Issued } from '../../src/invoices/model.js';
import { qrReference } from '../../src/providers/qr-bill/reference.js';
import type { SheetData } from '../../src/invoices/sheet.js';
import { workspaceAt } from '../../src/workspace/workspace.js';
import { DEMO_ROOT } from './workspace.js';

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const lines = (n: number): InvoiceLine[] => Array.from({ length: n }, (_, i) => ({ text: `Espresso-Mischung ${i + 1}`, quantity: 2, unit: 'pcs', price: 24.5, vatRate: 8.1 }));
const sheet = (n: number): SheetData => ({
  kind: 'invoice', language: 'de', number: '2026-007', date: '2026-10-11', dueDate: '2026-11-10', currency: 'CHF',
  customer: { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30 },
  sender: { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' },
    payTo: { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012' } },
  lines: lines(n), intro: '', closing: 'Freundliche Grüsse', layout: { ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show, intro: false } },
  reference: qrReference('2026-007'),
});

// Not a top-level await: Electron holds 'ready' back until the main module has finished loading.
app.dock?.hide();
void app.whenReady().then(main);

async function main() {
usePrintPages(electronPage);
try {
  const byLines: Record<number, { sheet: number; pdf: number }> = {};
  for (const n of [1, 25, 60]) {
    const out = await renderPdf(sheet(n), '2026-10-11T12:00:00Z');
    byLines[n] = { sheet: out.pages, pdf: pageCount(out.pdf) };
  }
  const ws = workspaceAt(DEMO_ROOT);
  const book = loadInvoices(ws);
  const inv = book.invoices.find((i): i is Issued => i.status === 'issued' && i.number === '2026-001')!;
  const demo = await renderPdf(issuedSheet(book, inv, logoSrc(ws, inv.layout.logo)), inv.issuedAt);
  const a = await renderPdf(sheet(3), '2026-10-11T12:34:56Z');
  const b = await renderPdf(sheet(3), '2026-10-11T12:34:56Z');
  const text = a.pdf.toString('latin1');
  process.stdout.write(JSON.stringify({
    byLines,
    demo: { sheet: demo.pages, pdf: pageCount(demo.pdf), qr: /class="a4 [^"]*has-qr/.test(demo.html) },
    sameBytes: sha(a.pdf) === sha(b.pdf),
    dates: /\/CreationDate \(D:20261011123456/.test(text) && /\/ModDate \(D:20261011123456/.test(text),
  }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String((e as Error).stack ?? e) }) + '\n');
}
app.exit(0);
}
