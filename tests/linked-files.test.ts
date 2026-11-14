/**
 * #523: every linked file previews by its type, or names itself with a download, in the live app and the
 * static audit export alike: a PDF as paper, an image, a CSV as a table, text and XML as text, a saved mail
 * as its body, an HTML page in a sandbox; an xlsx (any type not drawn) as its name, type and size. The
 * export keeps each receipt's extension, and its manifest verifies. Made-up files on a copy of the demo.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Browser } from 'puppeteer-core';
import { buildAuditExport } from '../src/audit/build.js';
import { verifyExport } from '../src/audit/manifest.js';
import { EXPORT_FILES, EXPORT_SOURCES } from '../src/audit/sources.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { csvRows, decodeText, fileHeaders, fileKindOf, inertExt } from '../src/core/files.js';
import { mailText } from '../src/core/mail-text.js';
import type { Receipt } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { serveStatic, type StaticServer } from './support/static-server.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { browserPath, closeChrome, closeContext, launchChrome } from './support/browser.js';
import en from '../src/app/i18n/locales/en.js';

/** A 2 × 2 grey PNG. */
const PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.from([0, 128, 128, 0, 128, 128]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
})();
const MAIL = [
  'From: Muster Laden <rechnung@laden.example>',
  'To: buchhaltung@firma.example',
  'Subject: =?UTF-8?Q?Ihre_Bestellung_bei_M=C3=BCster?=',
  'Date: Tue, 15 Sep 2026 10:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Total CHF 42.50 f=C3=BCr Kaffeebohnen',
  '--b1',
  'Content-Type: application/pdf; name="x.pdf"',
  'Content-Disposition: attachment; filename="x.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--b1--',
  '',
].join('\r\n');

/** One file of each kind, its id, its name, its bytes, and what its pane shows. */
const FILES = [
  { id: 'lf-csv', filename: 'shop-fees-2026-09.csv', bytes: Buffer.from('Order;Fee;Currency\n#1001;1.20;CHF\n#1002;"0,95";CHF\n'), view: 'table', shows: '#1002' },
  { id: 'lf-png', filename: 'kassenzettel.png', bytes: PNG, view: 'image', width: 2 },
  { id: 'lf-svg', filename: 'stempel.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3" fill="grey"/><script>parent.document.title="svg"</script></svg>'), view: 'image', width: 3 },
  { id: 'lf-txt', filename: 'notiz.txt', bytes: Buffer.from('Barbeleg Parkhaus CHF 12.00\n', 'latin1'), view: 'text', shows: 'Parkhaus' },
  { id: 'lf-xml', filename: 'auszug.xml', bytes: Buffer.from('<?xml version="1.0"?><Document><Amt Ccy="CHF">12.00</Amt></Document>'), view: 'text', shows: '<Amt Ccy="CHF">' },
  { id: 'lf-eml', filename: 'bestellung.eml', bytes: Buffer.from(MAIL, 'latin1'), view: 'mail', shows: 'für Kaffeebohnen' },
  { id: 'lf-html', filename: 'beleg.html', bytes: Buffer.from('<html><body><h1>Quittung</h1><script>document.body.setAttribute("data-ran","1");parent.document.title="x"</script></body></html>'), view: 'html' },
  { id: 'lf-xlsx', filename: 'umsatz.xlsx', bytes: Buffer.from('PK\u0003\u0004 not really a workbook'), view: 'none', shows: 'umsatz.xlsx' },
] as const;

const receipt = (f: (typeof FILES)[number]): Receipt => ({
  id: f.id, filename: f.filename, originalFilename: f.filename, extractedText: '', extractionMethod: 'pdftotext', fileSize: f.bytes.length,
  indexedAt: '2026-09-15T00:00:00Z', location: 'archived', date: '2026-09-15', amount: 12, currency: 'CHF', description: f.filename,
});

/** Adds the files to the books of `ws` and links the CSV to an entry of the open period whose payment has no receipt; returns that entry's id. */
function addFiles(ws: Workspace): string {
  const dir = yearPaths(ws.paths, '2026').receipts;
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) writeFileSync(join(dir, f.filename), f.bytes);
  const books = loadBooks(ws);
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const entry = books.journalEntries.find((e) => e.date >= '2026-07-01' && e.transactionRef && !linked.has(e.transactionRef) && !e.receipts?.length)!;
  assert.ok(entry, 'the demo has an entry of the open period without a receipt');
  update(books, PERSON, (b) => {
    b.receipts.push(...FILES.map(receipt));
    b.mappings.push({ receiptId: 'lf-csv', transactionRef: entry.transactionRef! });
  });
  saveBooks(ws, books);
  return entry.id;
}

test('a file is shown by its name: its type, its view, the headers it is served with', () => {
  assert.deepEqual(FILES.map((f) => fileKindOf(f.filename).view), FILES.map((f) => f.view));
  assert.deepEqual(fileKindOf('Rechnung.PDF'), { ext: 'pdf', type: 'application/pdf', view: 'pdf' });
  assert.deepEqual(fileKindOf('ohne-endung'), { ext: '', type: 'application/octet-stream', view: 'none' });
  assert.equal(fileKindOf('foto.heic').view, 'none', 'most browsers draw no HEIC: downloaded');
  assert.deepEqual(fileHeaders('a.pdf'), { 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff' });
  assert.equal(fileHeaders('a.html')['Content-Security-Policy'], 'sandbox', 'a page opened on its own runs no script');
  assert.equal(decodeText(Buffer.from('Gebühr', 'latin1')), 'Gebühr', 'a Windows-1252 CSV reads');
  assert.deepEqual(csvRows('a;b\n"x;1";"he said ""hi"""\n'), [['a', 'b'], ['x;1', 'he said "hi"']]);
});

test('a saved mail reads as its sender, subject and plain text body, attachments left out', () => {
  const m = mailText(MAIL);
  assert.equal(m.from, 'Muster Laden <rechnung@laden.example>');
  assert.equal(m.subject, 'Ihre Bestellung bei Müster');
  assert.equal(m.text?.trim(), 'Total CHF 42.50 für Kaffeebohnen');
  const html = mailText('Subject: Hallo\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPGI+SGk8L2I+\r\n');
  assert.deepEqual(html, { from: undefined, to: undefined, subject: 'Hallo', date: undefined, html: '<b>Hi</b>' });
});

test('the API serves each receipt with its own type, not as a PDF', async () => {
  const api: ApiServer = await startApi('demo');
  try {
    addFiles(api.ws);
    for (const f of FILES) {
      const res = await api.fetch(`/api/receipts/${f.id}`);
      assert.equal(res.status, 200, f.filename);
      assert.equal(res.headers.get('content-type')?.split(';')[0], fileKindOf(f.filename).type, f.filename);
      assert.equal(res.headers.get('content-security-policy'), 'sandbox', f.filename);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), f.bytes, f.filename);
    }
    // The file by its name, as the UI's dev proxy and the desktop serve it: never an active document of the app's origin.
    for (const name of ['beleg.html', 'stempel.svg', 'auszug.xml']) {
      const res = await api.fetch(`/receipts/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
      assert.equal(res.headers.get('content-security-policy'), 'sandbox', name);
    }
  } finally {
    await api.stop();
  }
});

const tmp = mkdtempSync(join(tmpdir(), 'linked-files-'));
const dir = join(tmp, 'host', 'export');
let server: StaticServer;
let base: string;
let entryId: string;
let launched: Promise<Browser> | undefined;

before(async () => {
  const copy = join(tmp, 'demo');
  cpSync(join(APP_ROOT, 'demo'), copy, { recursive: true, filter: (src) => !src.endsWith('/data') });
  const ws = workspaceAt(copy);
  entryId = addFiles(ws);
  await buildAuditExport(ws, dir, '2026-10-09T12:00:00.000Z');
  server = await serveStatic(join(tmp, 'host'));
  base = `${server.url}/export/`;
});
after(async () => {
  await closeChrome(await launched?.catch(() => undefined));
  await server?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

test('the export keeps each receipt with its bytes, its own extension when inert, and its manifest verifies', async () => {
  assert.deepEqual(FILES.map((f) => inertExt(f.filename)), ['csv', 'png', 'bin', 'txt', 'bin', 'eml', 'bin', 'xlsx'], 'html, svg and xml go out as .bin');
  assert.equal(inertExt('ohne-endung'), 'bin');
  for (const f of FILES) {
    const path = EXPORT_FILES.receipt(f);
    assert.equal(path, `receipts/${f.id}.${inertExt(f.filename)}`);
    assert.deepEqual(readFileSync(join(dir, path)), f.bytes, path);
    const res = await fetch(new URL(EXPORT_SOURCES.receipt(f), base));
    assert.equal(res.status, 200, path);
  }
  assert.deepEqual(verifyExport(dir), []);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }>; missing: string[] };
  for (const f of FILES) assert.ok(manifest.files.some((m) => m.path === EXPORT_FILES.receipt(f)), `${f.filename} is in the manifest`);
  assert.deepEqual(manifest.missing, []);
  const active = manifest.files.map((m) => m.path).filter((p) => /^(receipts|bank-statements)\/.*\.(html?|svg|xml|xhtml|mht|shtml)$/i.test(p));
  assert.deepEqual(active, [], 'no receipt or statement a static host would serve as an active document');
  assert.equal(EXPORT_FILES.statement('Muster Bank', 'camt053-2026-09.xml'), 'bank-statements/Muster Bank/camt053-2026-09.xml.bin', 'the bank\'s XML goes out inert');
  assert.equal(EXPORT_FILES.statement('Muster Bank', '2026-09.pdf'), 'bank-statements/Muster Bank/2026-09.pdf');
});

test('the exported app shows every kind by its type, and a type it does not draw with its facts and download', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const browser = await (launched ??= launchChrome(browserPath!, ['--lang=en-US']));
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.setItem('language', 'en'));
    for (const f of FILES) {
      await page.goto(`${base}#/receipts/${f.id}?period=2026-Q3`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      const pane = `.detail-in[data-for="${f.id}"] .desk [data-view="${f.view}"]`;
      await page.waitForSelector(pane);
      const text = await page.$eval(pane, (el) => (el as HTMLElement).innerText);
      if ('shows' in f) assert.ok(text.includes(f.shows), `${f.filename}: «${f.shows}» in ${JSON.stringify(text.slice(0, 200))}`);
      if ('width' in f) await page.waitForFunction((sel, w) => (document.querySelector(sel) as HTMLImageElement | null)?.naturalWidth === w, {}, pane, f.width);
      if (f.view === 'html') {
        const frame = await page.$eval(pane, (el) => ({ sandbox: el.getAttribute('sandbox'), doc: (el as HTMLIFrameElement).srcdoc }));
        assert.equal(frame.sandbox, '', 'the page runs no script: no allow-scripts');
        assert.ok(frame.doc.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\''), 'the page carries the CSP that forbids script and requests');
        assert.match(frame.doc, /<h1>Quittung<\/h1>/);
        // Seen from inside the frame: the page is drawn, and its script did not run (it would mark the body).
        const inside = (await (await page.$(pane))!.contentFrame())!;
        assert.equal(await inside.$eval('h1', (h) => h.textContent), 'Quittung');
        assert.equal(await inside.$eval('body', (b) => b.getAttribute('data-ran')), null, 'the page\'s script did not run');
      }
      await new Promise((ok) => setTimeout(ok, 300));
      assert.ok(!['x', 'svg'].includes(await page.title()), `${f.filename}: a script in the file ran`);
      if (f.view === 'none') {
        assert.ok(text.includes(en.messages['file.noPreview'] as string), text);
        assert.match(text, /XLSX/);
        assert.match(text, /\b26 B\b/, 'its size, in the app\'s language');
        const href = await page.$eval(`${pane} a[download]`, (a) => (a as HTMLAnchorElement).href);
        assert.ok(href.endsWith(EXPORT_FILES.receipt(f)), href);
        assert.equal((await fetch(href)).status, 200);
      }
      assert.ok(!text.includes('Failed to load PDF'), f.filename);
    }
    await page.goto(`${base}#/journal/${entryId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.desk [data-view="table"]');
    const cells = await page.$$eval('.desk [data-view="table"] td', (tds) => tds.map((td) => td.textContent));
    assert.deepEqual(cells, ['#1001', '1.20', 'CHF', '#1002', '0,95', 'CHF'], 'the journal entry\'s receipt pane shows the CSV as a table');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(browser, context);
  }
});
