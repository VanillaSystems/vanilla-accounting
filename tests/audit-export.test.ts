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
import { findBrowser } from '../src/invoices/pdf.js';
import en from '../src/app/i18n/locales/en.js';

const tmp = mkdtempSync(join(tmpdir(), 'audit-export-'));
const dir = join(tmp, 'host', 'snapshot');
let server: StaticServer;
let base: string;

before(async () => {
  await buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), dir, '2026-10-09T12:00:00.000Z');
  server = await serveStatic(join(tmp, 'host'));
  base = `${server.url}/snapshot/`;
});
after(async () => {
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
    ...books.receipts.map((r) => EXPORT_SOURCES.receipt(r.id)),
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
  const receipt = EXPORT_SOURCES.receipt(books.receipts[0].id);
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
test('the list column never widens past its track at the narrowest width, with chips and the filter menu open', { skip: findBrowser() ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--lang=en-US'] });
  const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800 });
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    const wide: string[] = [];
    for (const language of ['de', 'fr', 'en']) {
      await page.evaluate((lang) => { localStorage.setItem('language', lang); localStorage.setItem('lw.receipts', '340'); localStorage.setItem('lw.journal', '340'); }, language);
      for (const at of ['receipts', 'receipts?f=state_open&f=month_2026-09&f=over_100&q=x', 'journal', 'journal?f=account_1020&f=account_6000&f=who_classify']) {
        await page.goto(`${base}#/${at}`, { waitUntil: 'networkidle0' });
        await page.reload({ waitUntil: 'networkidle0' });
        await pause(300);
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
    await browser.close();
  }
});

const AREAS = ['receipts', 'bank', 'journal', 'vat', 'vat/codes', 'reports/income', 'reports/balance', 'reports/custom', 'close', 'company/profile',
  'company/rules', 'company/sources', 'company/mail', 'invoices', 'automation', 'automation/runs', 'changes', 'partners', 'knowledge', 'receipts'];
const browserPath = findBrowser();

test('a browser walk over every area asks the host for no /api/, logs no error and leaves the page idle', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 120_000 }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run', '--lang=en-US'] });
  const within = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what}: the page did not answer in 5 s`)), 5000))]);
  const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url ?? ''}`); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const sample = async () => {
      const { metrics } = await within(cdp.send('Performance.getMetrics'), 'metrics');
      const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
      return { busy: value('TaskDuration'), at: value('Timestamp') };
    };
    const first = server.requests.length;
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });
    const busy: string[] = [];
    for (const area of AREAS) {
      await within(page.evaluate((hash) => { location.hash = hash; }, `#/${area}`), area);
      await pause(700);
      const a = await sample();
      await pause(1000);
      const b = await sample();
      const share = (b.busy - a.busy) / (b.at - a.at);
      if (share > 0.5) busy.push(`${area}: main thread ${Math.round(share * 100)} % busy`);
      if (area === 'changes') assert.ok((await within(page.evaluate(() => document.body.innerText), area)).includes(en.messages['automation.apiOnly']), 'Änderungen says it needs the server');
    }
    assert.deepEqual(server.requests.slice(first).filter((p) => !p.startsWith('/snapshot/')), [], 'every request is a file of the export');
    assert.deepEqual(busy, [], 'no area keeps the page busy');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
