/**
 * «Auszug entfernen» and the toast's «Rückgängig» in the real page (r9k-3): on the demo's July statement
 * the Datei fold removes the PDF, the undo brings it back, and July and August read «Stimmt.» again
 * with the books byte for byte as before. The real UI (Vite, from the repo) on the real API server, in
 * a headless browser.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { startApi } from './support/api-server.js';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { devProxy } from '../src/server/app-paths.js';
import de from '../src/app/i18n/locales/de.js';

const JULY = 'Kontoauszug 01.07.2026 - 31.07.2026 - CH6580808000000000001 - 2026-07-31.pdf';

const booksText = (root: string) => {
  const dir = join(root, 'transactional-data/2026/books');
  return readdirSync(dir).sort().map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`).join('\n');
};

/** The statement's check line, once the detail shows one. */
async function check(page: Page): Promise<string> {
  await page.waitForFunction(() => !!document.querySelector('.linked, .notice'), { timeout: 30_000 });
  return page.evaluate(() => document.querySelector('.linked')?.textContent ?? document.querySelector('.notice')?.textContent ?? '');
}

test('Datei › Auszug entfernen › Rückgängig: the month reads «Stimmt.» again and the books are as before', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'statement-undo-ui-'));
  const api = await startApi('demo/vanilla-accounting');
  cpSync(join(process.cwd(), 'demo/vanilla-accounting/transactional-data'), join(api.root, 'transactional-data'), { recursive: true, filter: (src) => !src.includes('/books') });
  const { build, preview } = await import('vite');
  const outDir = join(dir, 'dist');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const vite = await preview({
    configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir },
    preview: { host: '127.0.0.1', port: 0, proxy: devProxy(`http://127.0.0.1:${api.port}`) },
  });
  const ui = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  const browser = await launchChrome(browserPath!);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('language', 'de'));
    const before = booksText(api.root);
    const ok = /^Stimmt\./;

    await page.goto(`${ui}/bank/1021-2026-08?period=2026-Q3`, { waitUntil: 'networkidle0', timeout: 120_000 });
    assert.match(await check(page), ok, 'August adds up before');
    await page.goto(`${ui}/bank/1021-2026-07?period=2026-Q3`, { waitUntil: 'networkidle0', timeout: 120_000 });
    assert.match(await check(page), ok, 'July adds up before');

    await (await page.waitForSelector('[data-sec=datei] button.sum'))!.evaluate((b) => (b as HTMLButtonElement).click());
    await (await page.waitForSelector('[data-testid=remove-statement]'))!.evaluate((b) => (b as HTMLButtonElement).click());
    const undo = await page.waitForSelector('.toast.show button', { timeout: 30_000 });
    assert.equal(existsSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', JULY)), false, 'the PDF is removed');
    assert.ok(booksText(api.root) !== before, 'the removal changed the books');

    await undo!.evaluate((b) => (b as HTMLButtonElement).click());
    const pdf = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', JULY);
    for (const end = Date.now() + 30_000; !existsSync(pdf) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
    await page.waitForSelector(`dd[data-tip="${JULY}"]`, { timeout: 30_000 });
    await page.waitForNetworkIdle({ timeout: 30_000 });
    assert.match(await check(page), ok, 'July adds up again');
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(de.messages['bank.noClose']), 'its closing balance is there');
    assert.ok(booksText(api.root) === before, 'the books read byte for byte as before');

    await page.goto(`${ui}/bank/1021-2026-08?period=2026-Q3`, { waitUntil: 'networkidle0', timeout: 120_000 });
    assert.match(await check(page), ok, 'August has its opening balance again');
  } finally {
    await closeChrome(browser);
    await vite.close();
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
