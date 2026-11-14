/**
 * The static audit export (npm run build:audit) of the demo, served by a plain static file server
 * under a sub-path: every read the UI makes is a file there, and manifest.json catches a change.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuditExport } from '../src/audit/build.js';
import { verifyExport } from '../src/audit/manifest.js';
import { EXPORT_SOURCES } from '../src/audit/sources.js';
import type { ApiStatus } from '../src/types/api-error.js';
import type { Index } from '../src/types/index.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { BOOKS_SCHEMA } from '../src/workspace/schema.js';
import { serveStatic, type StaticServer } from './support/static-server.js';
import { browserPath, closeChrome, closeContext, launchChrome } from './support/browser.js';
import type { Browser } from 'puppeteer-core';
import en from '../src/app/i18n/locales/en.js';

const tmp = mkdtempSync(join(tmpdir(), 'audit-export-'));
const dir = join(tmp, 'host', 'snapshot');
let server: StaticServer;
let base: string;
/**
 * One browser for the file's walks, each in a context of its own (its own storage, as a fresh profile), closed in `after`:
 * on a busy machine Chrome took up to 80 s to shut down (#246), which is no part of what a walk checks and so is kept out
 * of every test's timeout. Its start and close have time limits of their own (support/browser.ts): `after` waits on both,
 * and a start without one once stalled for good, leaving the run and its Chrome waiting forever.
 */
let launched: Promise<Browser> | undefined;
const chrome = () => launched ??= launchChrome(browserPath!, ['--lang=en-US']);

before(async () => {
  await buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), dir, '2026-10-09T12:00:00.000Z');
  server = await serveStatic(join(tmp, 'host'));
  base = `${server.url}/snapshot/`;
});
after(async () => {
  await closeChrome(await launched?.catch(() => undefined));
  await server?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const get = (url: string) => fetch(new URL(url, base));
const json = async <T>(url: string) => (await get(url)).json() as Promise<T>;

test('every read the UI makes is a file of the export, under any base path', async () => {
  const books = await json<Index>(EXPORT_SOURCES.books());
  const years = new Set(books.transactions.map((t) => t.date.slice(0, 4)));
  const urls = [
    EXPORT_SOURCES.status(), EXPORT_SOURCES.accounts(), EXPORT_SOURCES.workspace(), EXPORT_SOURCES.fxRates(),
    ...[...years].map((y) => EXPORT_SOURCES.filedReturns(y)),
    ...books.receipts.map((r) => EXPORT_SOURCES.receipt(r)),
    ...books.bankStatements.map((s) => EXPORT_SOURCES.statement(s.bank, s.filename)),
  ];
  assert.ok(books.receipts.length > 10 && books.bankStatements.length > 5, 'the demo names receipts and statements');
  const failed: string[] = [];
  for (const url of urls) {
    const res = await get(url);
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || (url.endsWith('.pdf') && !body.subarray(0, 5).equals(Buffer.from('%PDF-')))) failed.push(`${res.status} ${url}`);
  }
  assert.deepEqual(failed, []);

  const html = await (await get('')).text();
  assert.match(html, /src="\.\/assets\/index-[\w-]+\.js"/, 'the app loads its script relative to index.html');
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'no root-absolute URL in index.html');
});

test('the status is a read-only snapshot naming its date, schema and app version', async () => {
  const status = await json<ApiStatus>(EXPORT_SOURCES.status());
  const { version } = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.deepEqual(status, { ok: true, readonly: true, snapshot: { createdAt: '2026-10-09T12:00:00.000Z', booksSchema: BOOKS_SCHEMA, appVersion: version } });
});

test('the filed returns of the demo are in the export', async () => {
  const filed = await json<Array<{ period: string }>>(EXPORT_SOURCES.filedReturns('2026'));
  assert.deepEqual(filed.map((f) => f.period), ['2026-Q1']);
});

test('the manifest verifies the export as made and names the seals', () => {
  assert.deepEqual(verifyExport(dir), []);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.seals.map((s: { quarter: string; status: string }) => `${s.quarter} ${s.status}`), ['2026-Q1 intact']);
  assert.deepEqual(manifest.missing, []);
  assert.ok(manifest.files.some((f: { path: string }) => f.path === 'books.json'));
});

test('verify-audit fails on a changed, an added and a removed file', () => {
  const copy = join(tmp, 'tampered');
  cpSync(dir, copy, { recursive: true });
  const books = JSON.parse(readFileSync(join(copy, 'books.json'), 'utf8')) as Index;
  const receipt = EXPORT_SOURCES.receipt(books.receipts[0]);
  appendFileSync(join(copy, receipt), ' ');
  writeFileSync(join(copy, 'data', 'extra.json'), '{}');
  unlinkSync(join(copy, EXPORT_SOURCES.accounts()));

  const problems = verifyExport(copy);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.find((p) => p.startsWith(receipt)) ?? '', /changed/);
  assert.match(problems.find((p) => p.startsWith('data/extra.json')) ?? '', /not in the manifest/);
  assert.match(problems.find((p) => p.startsWith('data/accounts.json')) ?? '', /missing/);

  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/verify-audit.ts', copy], { cwd: APP_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /differs from its manifest/);
});

test('a non-empty folder that holds no export is refused, not emptied', async () => {
  const other = join(tmp, 'someone-elses');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'mine');
  await assert.rejects(buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), other), /not empty and holds no audit export/);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'mine');
});

/**
 * #211: at the narrowest list width (Split.tsx's MIN, 340 px) the list column is never wider than its
 * track: its heading's counts, chips, «Filter» menu and search wrap, so scrollWidth equals clientWidth.
 */
test('the list column never widens past its track at the narrowest width, with chips and the filter menu open', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const browser = await chrome();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 1000, height: 800 });
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    const wide: string[] = [];
    for (const language of ['de', 'fr', 'en']) {
      await page.evaluate((lang) => { localStorage.setItem('language', lang); localStorage.setItem('lw.receipts', '340'); localStorage.setItem('lw.journal', '340'); }, language);
      for (const at of ['receipts', 'receipts?f=state_open&f=month_2026-09&f=over_100&q=x', 'journal', 'journal?f=account_1020&f=account_6000&f=who_classify']) {
        await page.goto(`${base}#/${at}`, { waitUntil: 'networkidle0' });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))));
        const measure = async (what: string) => {
          // scrollWidth misses a child that overflows inside a scrolling box of its own, so every element's right edge is measured too
          // (text a box of its own clips, a title's ellipsis, is no overflow; the clipping box is measured itself).
          const m = await page.evaluate(() => {
            const l = document.querySelector('.list')!;
            const edge = l.getBoundingClientRect().left + l.clientLeft + l.clientWidth;
            const past = [...l.querySelectorAll('*')].filter((e) => {
              const r = e.getBoundingClientRect();
              if (!(r.width > 0 && r.right > edge + 0.5)) return false;
              for (let p = e.parentElement; p && p !== l; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return false;
              return true;
            })
              .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${(e.getAttribute('class') ?? '').split(' ')[0]}`);
            return { scroll: l.scrollWidth, client: l.clientWidth, width: l.getBoundingClientRect().width, past };
          });
          assert.ok(m.width <= 341, `${language} ${at}: the list is at its narrowest (${m.width} px)`);
          if (m.scroll !== m.client) wide.push(`${language} ${at}${what}: scrollWidth ${m.scroll} ≠ clientWidth ${m.client}`);
          if (m.past.length) wide.push(`${language} ${at}${what}: past the column's edge: ${m.past.join(', ')}`);
        };
        await measure('');
        await page.click('[data-testid=filter-button]');
        await measure(' (filter menu open)');
      }
    }
    assert.deepEqual(wide, []);
  } finally {
    await closeContext(browser, context);
  }
});

const AREAS = ['receipts', 'bank', 'journal', 'vat', 'vat/codes', 'reports/income', 'reports/balance', 'reports/custom', 'close', 'company/profile',
  'company/rules', 'company/sources', 'company/mail', 'invoices', 'automation', 'automation/runs', 'changes', 'partners', 'knowledge', 'receipts'];

/**
 * Conditions, not clocks (#246): an area is measured once its page settled (no request for 300 ms, then an idle moment of
 * the main thread), so a busy machine only makes the walk slower. The idle wait gives up after 5 s of the page's own time,
 * leaving an area that never settles to the measurement. The test's timeout is the one wall clock: when it strikes, the
 * walk says where it stood and how long each step before took.
 */
test('a browser walk over every area asks the host for no /api/, logs no error and leaves the page idle', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async (t) => {
  let at: string | undefined = 'the browser\'s start';
  let since = Date.now();
  const took: string[] = [];
  const reach = (step: string) => { took.push(`${at} ${Date.now() - since} ms`); at = step; since = Date.now(); };
  // The signal aborts after every test, passed or not: only a walk still under way says where it stood.
  t.signal.addEventListener('abort', () => { if (at) t.diagnostic(`the walk stood at ${at} for ${Date.now() - since} ms, after ${took.join(', ')}`); });
  const browser = await chrome();
  const context = await browser.createBrowserContext();
  reach('a new page');
  const page = await context.newPage();
  const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  try {
    page.setDefaultTimeout(0);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url ?? ''}`); });
    page.on('pageerror', (e) => errors.push(String(e)));
    reach('the page\'s metrics');
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const sample = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
      return { busy: value('TaskDuration'), at: value('Timestamp') };
    };
    const settled = async () => {
      await page.waitForNetworkIdle({ idleTime: 300 });
      await page.evaluate(() => new Promise((ok) => requestIdleCallback(() => ok(undefined), { timeout: 5000 })));
    };
    const first = server.requests.length;
    reach('#/receipts, loading');
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    const busy: string[] = [];
    for (const area of AREAS) {
      reach(`#/${area}`);
      await page.evaluate((hash) => { location.hash = hash; }, `#/${area}`);
      await settled();
      reach(`#/${area}, measuring`);
      const a = await sample();
      await pause(1000);
      const b = await sample();
      const share = (b.busy - a.busy) / (b.at - a.at);
      if (share > 0.5) busy.push(`${area}: main thread ${Math.round(share * 100)} % busy`);
      if (area === 'changes') assert.ok((await page.evaluate(() => document.body.innerText)).includes(en.messages['automation.apiOnly']), 'Änderungen says it needs the server');
    }
    assert.deepEqual(server.requests.slice(first).filter((p) => !p.startsWith('/snapshot/')), [], 'every request is a file of the export');
    assert.deepEqual(busy, [], 'no area keeps the page busy');
    assert.deepEqual(errors, []);
  } finally {
    at = undefined;
    await closeContext(browser, context);
  }
});

interface ExportedInvoices {
  today: string;
  invoices: Array<{ id: string; status: string; kind: string; number?: string; pdf?: { file: string; sha256: string } }>;
  sent: Array<{ id: string; kind: string; sha256: string }>;
}

/** #516: the invoices, credit notes and sent documents are in the export, each PDF as stored, listed in the manifest with its checksum. */
test('the invoices and their PDFs are in the export, each with the checksum it was issued with', async () => {
  const d = await json<ExportedInvoices>(EXPORT_SOURCES.invoices());
  assert.equal(d.today, '2026-10-09', 'the records are as on the day of the export');
  const issued = d.invoices.filter((i) => i.status === 'issued');
  assert.ok(issued.length > 3 && d.sent.length > 3, 'the demo has issued invoices and sent documents');
  const demo = JSON.parse(readFileSync(join(APP_ROOT, 'demo', 'vanilla-accounting', 'invoices.json'), 'utf8')) as ExportedInvoices;
  assert.ok(demo.invoices.some((i) => i.status === 'draft'), 'the demo has a draft');
  assert.deepEqual(d.invoices.filter((i) => i.status !== 'issued').map((i) => i.id), [], 'drafts are left out of the export');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  const hashes = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const docs = [...issued.map((i) => ({ path: EXPORT_SOURCES.invoicePdf(i.number!), sha256: i.pdf!.sha256 })), ...d.sent.map((s) => ({ path: EXPORT_SOURCES.sentPdf(s.id), sha256: s.sha256 }))];
  const wrong: string[] = [];
  for (const doc of docs) {
    const res = await get(doc.path);
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || !body.subarray(0, 5).equals(Buffer.from('%PDF-'))) wrong.push(`${res.status} ${doc.path}`);
    if (hashes.get(doc.path) !== doc.sha256) wrong.push(`${doc.path}: manifest ${hashes.get(doc.path)}, record ${doc.sha256}`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(manifest.files.some((f) => f.path.startsWith('invoice-logos/')), 'the logo the sheets show is in the export');
});

test('verify-audit refuses an invoice PDF swapped for another with a manifest made to match', () => {
  const copy = join(tmp, 'swapped');
  cpSync(dir, copy, { recursive: true });
  const d = JSON.parse(readFileSync(join(copy, EXPORT_SOURCES.invoices()), 'utf8')) as ExportedInvoices;
  const [a, b] = d.invoices.filter((i) => i.status === 'issued');
  const pathA = EXPORT_SOURCES.invoicePdf(a.number!);
  writeFileSync(join(copy, pathA), readFileSync(join(copy, EXPORT_SOURCES.invoicePdf(b.number!))));
  const manifestFile = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  for (const f of manifest.files) if (f.path === pathA) f.sha256 = b.pdf!.sha256;
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(verifyExport(copy), [`${pathA}: not the PDF as issued (sha256 ${b.pdf!.sha256}, data/invoices.json ${a.pdf!.sha256})`]);
});

test('verify-audit names an invoice PDF taken out with its manifest line, and prints what the export lacked', () => {
  const copy = join(tmp, 'pdf-gone');
  cpSync(dir, copy, { recursive: true });
  const d = JSON.parse(readFileSync(join(copy, EXPORT_SOURCES.invoices()), 'utf8')) as ExportedInvoices;
  const gone = EXPORT_SOURCES.invoicePdf(d.invoices.find((i) => i.status === 'issued')!.number!);
  unlinkSync(join(copy, gone));
  const manifestFile = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { files: Array<{ path: string }>; missing: string[] };
  manifest.files = manifest.files.filter((f) => f.path !== gone);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(verifyExport(copy), [`${gone}: data/invoices.json names it, the manifest neither lists it nor names it missing`]);

  // Named missing when the export was made, it is no tampering: verify-audit says ok and names what is incomplete.
  manifest.missing = ['receipt r_x (scan.pdf)', `invoice ${gone.slice('invoices/'.length, -'.pdf'.length)}: transactional-data/2026/invoices/x.pdf not found`];
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(verifyExport(copy), []);
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/verify-audit.ts', copy], { cwd: APP_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /incomplete: 2 file\(s\)[\s\S]*receipt r_x/);
});

/** #516: the Invoices area of the export shows the invoices read-only and opens their PDFs. */
test('the Invoices area of the export lists the invoices, offers no change and opens a sent PDF', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const d = await json<ExportedInvoices>(EXPORT_SOURCES.invoices());
  const issued = d.invoices.find((i) => i.status === 'issued' && i.kind === 'invoice')!;
  const browser = await chrome();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(60_000);
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`${base}#/invoices/${issued.number}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`.detail-in[data-for="${issued.id}"]`);
    const rows = await page.$$eval('.list .row.inv', (xs) => xs.length);
    assert.ok(rows > 3, `the list shows the invoices (${rows})`);
    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(!body.includes(en.messages['invoices.unavailable']), 'no «only with its server»');
    const writes = await page.$$eval('[data-act="send"], [data-act="copy"], [data-act="credit"], [data-act="cancel"], [data-act="remind"], [data-act="issue"], [data-act="delete"], [data-act="reset-texts"], .addbtn',
      (xs) => xs.map((x) => x.getAttribute('data-act') ?? x.className));
    assert.deepEqual(writes, [], 'no button that would change an invoice');
    const href = await page.$eval('.detail a.dl', (a) => (a as HTMLAnchorElement).href);
    const pdf = Buffer.from(await (await fetch(href)).arrayBuffer());
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')), `the download is the issued PDF (${href})`);

    const sent = d.sent[0];
    await page.evaluate((hash) => { location.hash = hash; }, `#/invoices/sent/${sent.id}`);
    await page.waitForSelector(`.detail-in[data-for="${sent.id}"] .sentpdf canvas`);
  } finally {
    await closeContext(browser, context);
  }
});

/** #515: the floating top bar, the corner, the dock and the page start below the amber audit bar, whose text stays whole, at every width, zoom and theme. */
test('the audit bar is never covered by the top bar, at any width, zoom or theme', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const browser = await chrome();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(60_000);
    await page.bringToFront();
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    const covered: string[] = [];
    for (const theme of ['light', 'dark']) {
      for (const zoom of ['0.8', '1', '1.4', '1.6']) {
        for (const width of [1440, 1000, 700, 390]) {
          await page.setViewport({ width, height: 800 });
          await page.evaluate((th, z) => { localStorage.setItem('theme', th); localStorage.setItem('zoom', z); localStorage.setItem('language', 'de'); }, theme, zoom);
          await page.reload({ waitUntil: 'networkidle0' });
          await page.waitForSelector('[data-testid=audit-snapshot]');
          // Polled by a timer, never by animation frames (a page Chrome renders in the background gets none): the fonts are
          // in and --audit-h holds the bar's height as laid out now, rounded up (AuditBar.tsx).
          await page.waitForFunction(() => {
            const bar = document.querySelector<HTMLElement>('.auditbar');
            const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--audit-h'));
            return document.fonts.status === 'loaded' && !!bar && h >= bar.offsetHeight && h <= bar.offsetHeight + 1;
          }, { polling: 100, timeout: 20_000 });
          const m = await page.evaluate(() => {
            const bar = document.querySelector<HTMLElement>('.auditbar')!;
            const a = bar.getBoundingClientRect();
            const over = [...document.querySelectorAll<HTMLElement>('.topbar, .corner, .activity, main')].filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < a.bottom - 0.5 && r.bottom > a.top + 0.5 && r.left < a.right && r.right > a.left;
            }).map((e) => e.tagName === 'MAIN' ? 'main' : e.className.split(' ')[0]);
            return { over, clipped: bar.scrollHeight > bar.clientHeight + 1, theme: document.documentElement.dataset.theme };
          });
          const at = `${theme} zoom ${zoom} ${width}px`;
          if (m.theme !== theme) covered.push(`${at}: the theme is ${m.theme}`);
          if (m.over.length) covered.push(`${at}: ${m.over.join(', ')} over the audit bar`);
          if (m.clipped) covered.push(`${at}: the audit bar's text is clipped`);
        }
      }
    }
    assert.deepEqual(covered, []);
  } finally {
    await closeContext(browser, context);
  }
});
