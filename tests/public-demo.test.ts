/**
 * The public demo (npm run build:audit -- <dir> --demo): the static export of one of the app's made-up companies, served
 * under a sub-path of a website. It says it is a demo in the audit bar's place, links to the download, asks the host for
 * nothing but its own files, and says where the AI and the server's pages are instead of failing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { buildAuditExport } from '../src/audit/build.js';
import { EXPORT_SOURCES } from '../src/audit/sources.js';
import type { ApiStatus } from '../src/types/api-error.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { serveStatic, type StaticServer } from './support/static-server.js';
import { browserPath, closeChrome, closeContext, launchChrome } from './support/browser.js';
import en from '../src/app/i18n/locales/en.js';

const DOWNLOAD = 'https://example.com/accounting/download/';
const tmp = mkdtempSync(join(tmpdir(), 'public-demo-'));
const dir = join(tmp, 'host', 'buchhaltung', 'demo');
let server: StaticServer;
let base: string;
let launched: Promise<Browser> | undefined;
const chrome = () => launched ??= launchChrome(browserPath!, ['--lang=en-US']);

before(async () => {
  await buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), dir, { purpose: 'demo', createdAt: '2026-10-09T12:00:00.000Z', download: DOWNLOAD });
  server = await serveStatic(join(tmp, 'host'));
  base = `${server.url}/buchhaltung/demo/`;
});
after(async () => {
  await closeChrome(await launched?.catch(() => undefined));
  await server?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const json = async <T>(url: string) => (await fetch(new URL(url, base))).json() as Promise<T>;

test('the demo is a read-only snapshot marked as the demo, loading everything relative to its page', async () => {
  const status = await json<ApiStatus>(EXPORT_SOURCES.status());
  assert.equal(status.readonly, true);
  assert.equal(status.snapshot?.purpose, 'demo');
  const html = await (await fetch(base)).text();
  assert.match(html, /src="\.\/assets\/index-[\w-]+\.js"/);
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'no root-absolute URL: it runs under /buchhaltung/demo/');
});

test('--demo refuses books that are not one of the app\'s demos, and a download link that is no web page, before it writes anything', async () => {
  const books = join(tmp, 'books');
  cpSync(join(APP_ROOT, 'demo'), books, { recursive: true });
  const out = join(tmp, 'refused');
  await assert.rejects(buildAuditExport(workspaceAt(books), out, { purpose: 'demo' }), /not one of the app's demo workspaces/);
  assert.equal(existsSync(out), false);
  await assert.rejects(buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), out, { purpose: 'demo', download: 'javascript:alert(1)' }), /--download takes the http\(s\) address/);
  await assert.rejects(buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), out, { download: DOWNLOAD }), /only with --demo/);
  assert.equal(existsSync(out), false);

  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/build-audit.ts', out, '--demo', '--workspace', books], { cwd: APP_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /not one of the app's demo workspaces/);
  assert.equal(existsSync(out), false);
});

test('the demo bar names the made-up company and links to the download; the AI and the server\'s pages say they are in the app', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const browser = await chrome();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport({ width: 1280, height: 900 });
    const first = server.requests.length;
    await page.goto(`${base}#/receipts`, { waitUntil: 'networkidle0' });

    const bar = await page.waitForSelector('[data-testid=demo-bar]');
    const text = await bar!.evaluate((e) => (e as HTMLElement).innerText);
    assert.match(text, /Muster Kaffee GmbH is a made-up company/);
    assert.equal(await page.$eval('[data-act=demo-download]', (a) => (a as HTMLAnchorElement).href), DOWNLOAD);
    assert.equal(await page.$('[data-testid=audit-bar]'), null, 'no audit bar: the demo is no audit');

    // The card on the first visit points at what the demo shows, none of it a page that needs the app.
    const intro = await page.$$eval('[data-testid=demo-intro] li a', (as) => as.map((a) => (a as HTMLAnchorElement).hash));
    assert.deepEqual(intro, ['#/receipts', '#/journal', '#/vat']);

    await page.evaluate(() => { location.hash = '#/automation'; });
    await page.waitForFunction((want) => document.body.innerText.includes(want), {}, en.messages['automation.demoOff']);

    await page.click('.corner button');
    const input = await page.waitForSelector('.aside textarea');
    await input!.type('What is still open?');
    await page.keyboard.press('Enter');
    await page.waitForFunction((want) => document.querySelector('.aside')?.textContent?.includes(want), {}, en.messages['demo.web.ai']);

    assert.deepEqual(server.requests.slice(first).filter((p) => !p.startsWith('/buchhaltung/demo/')), [], 'every request is a file of the demo');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(browser, context);
  }
});

