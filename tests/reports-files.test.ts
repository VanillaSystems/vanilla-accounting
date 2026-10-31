/**
 * A report as CSV and PDF (src/reports/files.ts): the CSV is the plain table whose amounts add up
 * to the runner's totals, in every language's column names; the PDF page says the title, the
 * period, the filters in words, the totals, the comment with its figures and the VAT note. One
 * test prints a real PDF.
 */
import { after, test } from 'node:test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { accountsOf } from '../src/workspace/reads.js';
import { loadInvoices } from '../src/invoices/store.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { closeBrowser, printPdf } from '../src/invoices/pdf.js';
import { wordsIn } from '../src/export/texts.js';
import { money } from '../src/export/bundle.js';
import { parseSpec } from '../src/reports/spec.js';
import { runReport } from '../src/reports/run.js';
import { reportCsv, reportFileName, reportHtml, reportTable } from '../src/reports/files.js';
import { filtersInWords } from '../src/reports/words.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import { browserPath } from './support/browser.js';

const ws = workspaceAt(DEMO_ROOT);
const books = loadBooks(ws);
const invoices = loadInvoices(ws).invoices;
const names = Object.fromEntries((accountsOf(ws) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
const Q3 = parsePeriod('2026-Q3', '2026-10-16')!;
after(() => closeBrowser());

const raw = {
  title: 'Aufwand und Zahlungen', period: '2026-Q3',
  comment: 'Im {period} kostete der Betrieb {section1.total} in {section1.count} Buchungen.',
  sections: [
    { title: 'Aufwand', source: 'entries', filter: { accounts: ['6000-6999'], receipt: 'with' }, group: 'account', columns: ['date', 'text', 'account', 'vatCode', 'net', 'tax', 'amount', 'receipt'] },
    { source: 'payments', filter: { currencies: ['EUR'] } },
  ],
};
const parsed = parseSpec(raw, '2026-10-16');
assert.ok(parsed.ok);
const result = runReport(parsed.value, { books, invoices, names }, Q3);
const de = wordsIn('de');

test('the CSV is the plain table: a header, one line per row, the amounts adding up to the totals', () => {
  const csv = reportCsv(result, de);
  assert.ok(csv.startsWith('\uFEFF'), 'UTF-8 with its BOM, as the export writes it');
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.deepEqual(lines[0].split(';'), ['Abschnitt', 'Gruppe', 'Datum', 'Text', 'Konto', 'MWST-Code', 'Betrag', 'Netto', 'MWST', 'Währung', 'Beleg']);
  assert.equal(lines.length - 1, result.count);
  const tb = reportTable(result, de);
  const amount = tb.head.indexOf('Betrag');
  const sum = (section: string) => Math.round(tb.rows.filter((r) => r[0] === section).reduce((n, r) => n + Number(r[amount]), 0) * 100);
  assert.equal(sum('Aufwand'), Math.round(result.sections[0].totals[0].amount * 100));
  assert.equal(sum('2. Zahlungen'), Math.round(result.sections[1].totals[0].amount * 100));
  assert.ok(result.sections[1].count > 0 && result.sections[1].totals.every((t) => t.currency === 'EUR'));
  assert.equal(reportTable(result, wordsIn('fr')).head[2], 'Date');
  assert.equal(reportFileName(result, 'csv'), 'Aufwand-und-Zahlungen_2026-07-01_2026-09-30.csv');
});

test('the PDF page names the period and the filters in words, prints each total, fills the comment and says where Bilanz and ER put the VAT', () => {
  const html = reportHtml(result, de, { company: 'Muster Kaffee GmbH', fonts: '', now: '2026-10-16T08:00:00Z' });
  assert.match(html, /<h1>Aufwand und Zahlungen<\/h1>/);
  assert.match(html, /01\.07\.2026 – 30\.09\.2026/);
  assert.equal(filtersInWords(result.sections[0].section, de), 'Buchungen · Konten 6000-6999 · mit Beleg · nach Konto');
  assert.ok(html.includes('Buchungen · Konten 6000-6999 · mit Beleg · nach Konto'));
  const total = money(result.sections[0].totals[0].amount);
  assert.ok(html.includes(`Im 01.07.2026 – 30.09.2026 kostete der Betrieb CHF ${total} in ${result.sections[0].count} Buchungen.`), 'the comment\'s figures are the runner\'s');
  for (const g of result.sections[0].groups) assert.ok(html.includes(`Total ${g.key} ${g.label}`), g.key);
  assert.ok(result.vat, 'the expenses carry VAT codes');
  assert.ok(result.vatAccount, 'the Swiss statements are net of VAT within the year');
  assert.ok(html.includes(`Netto: ohne sie, wie Bilanz und Erfolgsrechnung die Konten zeigen; dort steht die MWST auf Konto ${result.vatAccount}.`), 'the note says which column Bilanz and ER show');
  assert.ok(html.includes('Gesamttotal'));
});

test('a report PDF is printed by Chromium', { skip: browserPath ? false : 'no Chromium-based browser installed' }, async () => {
  const pdf = await printPdf(reportHtml(result, de, { company: 'Muster Kaffee GmbH', fonts: '', now: '2026-10-16T08:00:00Z' }), '2026-10-16T08:00:00Z');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('POST /api/reports/run and /file answer in audit mode; a filter on an account the chart lacks is refused with its reason', async () => {
  const api = await startApi('demo/vanilla-accounting', { READONLY: '1' });
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  copyFileSync(ws.paths.accounts, api.ws.paths.accounts);
  try {
    const ran = await api.send('POST', '/api/reports/run', { spec: raw, period: '2026-Q3' });
    assert.equal(ran.status, 200, JSON.stringify(ran.json));
    const r = ran.json.result as typeof result;
    assert.deepEqual(r.sections[0].totals, result.sections[0].totals, 'the server\'s figures are the runner\'s');
    const bad = await api.send('POST', '/api/reports/run', { spec: { ...raw, sections: [{ source: 'entries', filter: { accounts: ['6599'] } }] } });
    assert.equal(bad.status, 400);
    assert.deepEqual([bad.json.code, bad.json.params], ['report', { refusal: { code: 'unknownAccount', params: { account: '6599' } } }]);
    assert.equal(bad.json.error, 'Bericht nicht erstellt: Das Konto 6599 steht nicht im Kontenplan.');
    const file = await api.fetch('/api/reports/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: raw, format: 'csv', language: 'en' }) });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition') ?? '', /Aufwand-und-Zahlungen_2026-07-01_2026-09-30\.csv/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with its BOM');
    assert.ok(bytes.subarray(3).toString('utf8').startsWith('Section;Group;Date;Text;Account'), 'the columns in the person\'s language');
  } finally {
    await api.stop();
  }
});
