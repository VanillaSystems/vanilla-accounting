/**
 * Firma › Eröffnung in the real page (#454): the account field, the balance in the base currency and,
 * for a foreign-currency account, its balance in its own currency stand in rows whose labels start on
 * one line and whose input boxes stand at one height, at a narrow and a wide form and window: a hint
 * under one input («kein Konto», the account's name) moves no other field. Each balance field says it
 * is an amount, of which day and currency («Saldo per 1.1.2026 (CHF)»), right-aligned and shown in the
 * app's number format once left. The real UI (Vite, from the repo) on the real API server, headless.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { startApi } from './support/api-server.js';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { devProxy } from '../src/server/app-paths.js';

const EVIDENCE = process.env.EVIDENCE_DIR;

/** Each field of the form: its label's text, where its label and its input box stand, and how its input aligns. */
const fields = (page: Page) => page.$$eval('[data-testid=opening-form] > label', (labels) => labels.map((label) => {
  const input = label.querySelector('input') as HTMLInputElement;
  const box = label.getBoundingClientRect();
  return {
    name: input.name,
    label: (label.firstChild?.textContent ?? '').trim(),
    labelTop: Math.round(box.top),
    labelBottom: Math.round(box.bottom),
    inputTop: Math.round(input.getBoundingClientRect().top),
    align: getComputedStyle(input).textAlign,
  };
}));
type Field = Awaited<ReturnType<typeof fields>>[number];

/** The rows of the form: fields whose labels overlap in height stand in one row. */
function rowsOf(list: Field[]): Field[][] {
  const rows: Field[][] = [];
  for (const f of list) {
    const row = rows.find((r) => r.some((o) => f.labelTop < o.labelBottom && o.labelTop < f.labelBottom));
    if (row) row.push(f); else rows.push([f]);
  }
  return rows;
}

/** In each row the labels start on one line and the input boxes stand at one height. */
function assertAligned(list: Field[], at: string) {
  for (const row of rowsOf(list)) {
    assert.equal(new Set(row.map((f) => f.labelTop)).size, 1, `${at}: the labels of a row on one line: ${JSON.stringify(row)}`);
    assert.equal(new Set(row.map((f) => f.inputTop)).size, 1, `${at}: the input boxes of a row at one height: ${JSON.stringify(row)}`);
  }
}

test('the opening form: its fields aligned at every width, each balance labelled with its day and currency', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opening-form-ui-'));
  const api = await startApi('tests/fixtures/fresh-books-index.json');
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
    await page.evaluateOnNewDocument(() => localStorage.setItem('language', 'de'));
    for (const width of [1024, 1440]) {
      // The form as narrow as two fields fit beside each other, and as wide as it grows (760 px).
      for (const formWidth of [340, 760]) {
        const at = `${width}px, form ${formWidth}px`;
        await page.setViewport({ width, height: 900 });
        await page.goto(`${ui}/company/opening`, { waitUntil: 'networkidle0', timeout: 120_000 });
        await page.waitForSelector('[data-testid=opening-form] input[name=amount]', { timeout: 30_000 });
        await page.$eval('[data-testid=opening-form]', (f, w) => { (f as HTMLElement).style.width = `${w}px`; }, formWidth);

        // An empty account field says «kein Konto» under its input: the balance beside it stands as high.
        if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `opening-form-${width}-${formWidth}.png`) });
        const empty = await fields(page);
        assert.deepEqual(empty.map((f) => f.name), ['account', 'amount']);
        assert.equal(rowsOf(empty).length, 1, `${at}: account and balance in one row: ${JSON.stringify(empty)}`);
        assertAligned(empty, at);
        assert.equal(empty[1].label, 'Saldo per 1.1.2026 (CHF)', 'the balance field names an amount, its day and its currency');
        assert.equal(empty[1].align, 'right', 'an amount is right-aligned');

        // A foreign-currency account: its balance in its own currency beside the one in the base currency.
        await page.click('[data-testid=opening-form] input[name=account]');
        await page.keyboard.type('1023');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid=opening-native]', { timeout: 10_000 });
        await page.type('[data-testid=opening-native]', '1200');
        await page.type('[data-testid=opening-form] input[name=amount]', '1126.5');
        await page.focus('[data-testid=opening-native]');
        if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `opening-form-foreign-${width}-${formWidth}.png`) });
        const foreign = await fields(page);
        assert.deepEqual(foreign.map((f) => f.label), ['Konto', 'Saldo per 1.1.2026 (CHF)', 'Saldo per 1.1.2026 (EUR)']);
        if (formWidth === 760) assert.equal(rowsOf(foreign).length, 1, `${at}: the three fields in one row`);
        assertAligned(foreign, `${at}, foreign account`);
        assert.equal(foreign[2].align, 'right');
        assert.match(await page.$eval('[data-testid=opening-form] input[name=amount]', (e) => (e as HTMLInputElement).value), /^1['’]126\.50$/, 'left, the amount reads in the app\'s number format');
      }
    }
  } finally {
    await closeChrome(browser);
    await new Promise<void>((r) => vite.httpServer.close(() => r()));
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
