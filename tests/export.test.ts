/**
 * The export bundle (src/export): which files each preset writes, that SHA256SUMS.txt and
 * manifest.json match the bytes in the ZIP, and that the journal's CSV and Excel hold exactly the
 * books' entries of the period. PDFs are printed by a stub here; one test prints a real one.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/node';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { accountsOf } from '../src/workspace/reads.js';
import { localToday, parsePeriod } from '../src/accounting/periods.js';
import { chfAmount } from '../src/accounting/ledger.js';
import { buildBundle, downloadOf, zipBundle, type Bundle } from '../src/export/bundle.js';
import { BadRequest, PRESETS, entriesIn, parseRequest, presetPeriod, receiptsIn, statementsIn, type PresetId } from '../src/export/model.js';
import { closeBrowser, findBrowser, printPdf } from '../src/invoices/pdf.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const ws = workspaceAt(DEMO_ROOT);
const books = loadBooks(ws);
const names = Object.fromEntries((accountsOf(ws) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
const today = localToday();
const Q3 = parsePeriod('2026-Q3', today)!;
const stubPdf = async (html: string) => Buffer.from(`%PDF-stub ${html.length}`);
after(() => closeBrowser());

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function bundleOf(id: PresetId, period = Q3, language = 'de', print = stubPdf): Promise<Bundle> {
  const p = PRESETS.find((x) => x.id === id)!;
  const token = presetPeriod(p, Q3, period);
  return buildBundle(ws, books, names, parseRequest({ period: token, items: p.items, sums: p.sums, oneBook: p.oneBook, language }), { print, now: new Date('2026-10-11T08:00:00Z') });
}

async function unzip(b: Bundle): Promise<Record<string, Uint8Array>> {
  const chunks: Uint8Array[] = [];
  await zipBundle(b, (c) => chunks.push(c));
  return unzipSync(Buffer.concat(chunks));
}

const paths = (b: Bundle) => b.files.map((f) => f.path);

test('Treuhänder-Paket: reports as PDF, journal for Banana and as CSV, payments, every original, LIESMICH and sums', async () => {
  const b = await bundleOf('treuhand');
  const receipts = receiptsIn(books, Q3).map((v) => `Belege/${v.r.filename}`);
  const statements = statementsIn(books, Q3).map((s) => `Kontoauszuege/${s.bank}/${s.filename}`);
  assert.ok(receipts.length > 0 && statements.length > 0, 'the demo has receipts and statements in Q3');
  assert.deepEqual(paths(b).sort(), [
    'LIESMICH.txt',
    'Berichte/Erfolgsrechnung.pdf', 'Berichte/Bilanz.pdf', 'Berichte/Saldobilanz.pdf', 'Berichte/MWST-Abrechnungen.pdf',
    'Daten/Banana-Import.tsv', 'Daten/Buchungen.csv', 'Daten/Zahlungen.csv',
    ...receipts, ...statements,
    'manifest.json', 'SHA256SUMS.txt',
  ].sort());
  assert.equal(b.root, 'Muster-Kaffee-GmbH_2026-07-01_2026-09-30');
  assert.deepEqual(downloadOf(b), { name: `${b.root}.zip`, type: 'application/zip' });
});

test('Prüfung ESTV / AHV and Jahresarchiv: the year, with the filed returns and seals of its filed quarters', async () => {
  const audit = paths(await bundleOf('audit'));
  for (const p of ['Berichte/Kontoblätter.pdf', 'Berichte/Kontoblätter.csv', 'Daten/Buchungen.json', 'Daten/Belege.csv', 'Daten/Kontenplan.csv', 'MWST-eingereicht/2026/mwst-ech0217-2026-Q1.xml', 'MWST-eingereicht/2026/seal-Q1.json']) {
    assert.ok(audit.includes(p), `audit has ${p}`);
  }
  assert.ok(!audit.some((p) => p.includes('Q2') && p.startsWith('MWST-eingereicht')), 'only filed quarters');
  const archive = paths(await bundleOf('archive'));
  for (const p of ['Berichte/Erfolgsrechnung.csv', 'Daten/Belege.json']) assert.ok(archive.includes(p), `archive has ${p}`);
});

test('Excel-Rohdaten: one workbook, nothing else, downloaded as the file itself', async () => {
  const b = await bundleOf('excel');
  assert.deepEqual(paths(b), ['Daten/Export.xlsx']);
  assert.deepEqual(downloadOf(b), { name: `${b.root}_Export.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
});

test('in English the folders, file names and the README are English', async () => {
  const b = await bundleOf('treuhand', Q3, 'en');
  for (const p of ['README.txt', 'Reports/Income-statement.pdf', 'Data/Entries.csv', 'Data/Payments.csv']) assert.ok(paths(b).includes(p), p);
  assert.match(new TextDecoder().decode(b.files[0].data), /^Muster Kaffee GmbH · Export 01\.07\.2026 – 30\.09\.2026\nMade 11\.10\.2026 08:00 UTC/);
});

test('SHA256SUMS.txt and manifest.json name every file of the ZIP with the hash of its bytes', async () => {
  const b = await bundleOf('treuhand');
  const zip = await unzip(b);
  const inZip = (p: string) => zip[`${b.root}/${p}`];
  const sums = new TextDecoder().decode(inZip('SHA256SUMS.txt')).trim().split('\n').map((l) => l.split('  ') as [string, string]);
  assert.deepEqual(sums.map(([, p]) => p).sort(), paths(b).filter((p) => p !== 'SHA256SUMS.txt').sort());
  for (const [hash, p] of sums) assert.equal(sha(inZip(p)), hash, p);
  const manifest = JSON.parse(new TextDecoder().decode(inZip('manifest.json'))) as { format: string; files: Array<{ path: string; sha256: string; bytes: number }> };
  assert.equal(manifest.format, 'vanilla-accounting-export/1');
  for (const f of manifest.files) {
    assert.equal(sha(inZip(f.path)), f.sha256, f.path);
    assert.equal(inZip(f.path).length, f.bytes, f.path);
  }
  assert.equal(Object.keys(zip).length, b.files.length, 'nothing in the ZIP but the files');
});

const journalOf = async (format: 'csv' | 'xlsx', period = Q3) =>
  buildBundle(ws, books, names, parseRequest({ period: period.token, items: { journal: [format] }, sums: false, oneBook: false, language: 'de' }), { print: stubPdf });

test('the journal as CSV holds the books\' entries of the period, in date order, CHF to the Rappen', async () => {
  const b = await journalOf('csv');
  assert.deepEqual(paths(b), ['Daten/Buchungen.csv']);
  const lines = new TextDecoder().decode(b.files[0].data).replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(';'));
  assert.deepEqual(lines[0], ['Datum', 'Buchung', 'Ref', 'Beschreibung', 'Soll', 'Haben', 'MWST-Code', 'Betrag', 'Währung', 'Kurs', 'CHF', 'Korrigiert']);
  const want = entriesIn(books, Q3).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  assert.ok(want.length > 10);
  assert.deepEqual(lines.slice(1).map((l) => [l[0], l[1], l[4], l[5], l[6], l[10]]),
    want.map((e) => [e.date, e.id, e.accountDebit, e.accountCredit, e.vatCode ?? '', chfAmount(e).toFixed(2)]));
});

test('the journal as Excel holds the same entries, amounts as numbers', async () => {
  const b = await journalOf('xlsx');
  const [{ data: rows }] = await readXlsxFile(Buffer.from(b.files[0].data));
  const want = entriesIn(books, Q3).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  assert.equal(rows.length, want.length + 1);
  assert.deepEqual(rows.slice(1).map((r) => [r[1], r[10]]), want.map((e) => [e.id, chfAmount(e)]));
});

test('a request with an unknown part or format is refused at the boundary', () => {
  assert.throws(() => parseRequest({ period: '2026-Q3', items: { journal: ['pdf'] }, language: 'de' }), BadRequest);
  assert.throws(() => parseRequest({ period: '2026-Q3', items: { secrets: ['csv'] }, language: 'de' }), BadRequest);
  assert.throws(() => parseRequest({ period: 'gestern', items: { journal: ['csv'] }, language: 'de' }), BadRequest);
  assert.throws(() => parseRequest({ period: '2026-Q3', items: { ledger: ['csv'] }, language: 'de' }), BadRequest, 'a ledger needs its account');
});

const browser = findBrowser();
test('a report PDF is printed by Chromium', { skip: browser ? false : 'no Chromium-based browser installed' }, async () => {
  const b = await buildBundle(ws, books, names, parseRequest({ period: '2026-Q3', items: { income: ['pdf'] }, sums: false, oneBook: false, language: 'de' }), { print: printPdf });
  const pdf = Buffer.from(b.files[0].data);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(downloadOf(b).type, 'application/pdf');
});

test('POST /api/export answers in audit mode with the ZIP, the books unchanged', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json', { READONLY: '1' });
  const before = readFileSync(api.indexPath);
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: 'all', items: { journal: ['csv', 'json'] }, sums: true, language: 'de' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer()))).map((p) => p.slice(p.indexOf('/') + 1)).sort();
    assert.deepEqual(files, ['Daten/Buchungen.csv', 'Daten/Buchungen.json', 'LIESMICH.txt', 'SHA256SUMS.txt', 'manifest.json']);
    const bad = await api.send('POST', '/api/export', { period: 'all', items: {} });
    assert.equal(bad.status, 400);
    assert.ok(readFileSync(api.indexPath).equals(before), 'books.json is byte-identical');
  } finally {
    api.stop();
  }
});
