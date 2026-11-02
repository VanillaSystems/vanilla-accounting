/**
 * An open form follows the books (src/app/lib/booked-fields.ts). An undone edit stays undone: after
 * ⌘Z the entry's form shows the booked account again, and leaving a field the person did not change
 * saves nothing. Before, the account field kept the undone value in its own state, and focusing and
 * leaving it booked that value again as the person's. Likewise the year close's receivables entry:
 * «Konto 1100 anlegen» fills its empty Soll at once. The real UI (built by Vite) on the real API
 * server on the demo, driven in a headless browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { devProxy } from '../src/server/app-paths.js';
import type { Index, JournalEntry } from '../src/types/index.js';

const ID = 'b9a7cba1c428824f';

test('open forms follow the books: ⌘Z shows the booked account and leaving the field saves nothing; an added account fills the empty Soll', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-form-'));
  const api = await startApi('demo/vanilla-accounting');
  // The demo's chart (the account field offers it; it has no 1100) and its open invoices (the year close's receivables), which startApi leaves out.
  mkdirSync(join(api.root, 'master-data'), { recursive: true });
  copyFileSync('demo/vanilla-accounting/master-data/accounts.json', join(api.root, 'master-data/accounts.json'));
  copyFileSync('demo/vanilla-accounting/invoices.json', join(api.root, 'invoices.json'));
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
    const entry = async () => (((await (await api.fetch('/books.json')).json()) as Index).journalEntries ?? []).find((e) => e.id === ID)!;
    const until = async (ok: (e: JournalEntry) => boolean, what: string) => {
      for (let i = 0; i < 100; i++) { if (ok(await entry())) return; await new Promise((r) => setTimeout(r, 100)); }
      assert.fail(what);
    };
    const before = await entry();
    assert.equal(before.accountDebit, '6940');

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('language', 'de'));
    await page.goto(`${ui}/journal/${ID}?period=2026-Q2`, { waitUntil: 'networkidle0', timeout: 120_000 });
    await page.waitForSelector(`[data-for="${ID}"]`);
    const debit = 'input[name=accountDebit]';
    const shown = () => page.$eval(debit, (el) => (el as HTMLInputElement).value);

    await page.keyboard.press('e');
    await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), {}, debit);
    await page.keyboard.type('65');
    await page.waitForSelector('[role=listbox] [role=option]');
    await page.keyboard.press('Enter');
        await until((e) => e.accountDebit !== '6940', 'the edit is saved');
    const saved = (await entry()).accountDebit;
    assert.equal(await shown(), saved);

    await page.keyboard.press('Escape');
    await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
    await until((e) => e.accountDebit === '6940', 'the books are back on 6940 after ⌘Z');
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '6940', { timeout: 10_000 }, debit)
      .catch(async () => assert.fail(`the open form shows ${await shown()} after ⌘Z, the books 6940`));

    await page.click(debit);
    await page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 1500));
    const after = await entry();
    assert.equal(after.accountDebit, '6940', 'leaving the untouched field books nothing');
    assert.equal(after.origin, before.origin, 'the entry is not the person\'s');
    assert.equal(await shown(), '6940');

    // Abschluss: «Konto 1100 anlegen» fills the open receivables entry's Soll, still empty, at once.
    await page.goto(`${ui}/close/entries?period=2026`, { waitUntil: 'networkidle0' });
    await (await page.waitForSelector('[data-template=receivables] .ye button.btn:not(.ghost)'))!.click();
    const soll = '[data-template=receivables] form input[list=close-accounts]';
    assert.equal(await page.$eval(soll, (el) => (el as HTMLInputElement).value), '', 'the demo\'s chart has no 1100: Soll is empty');
    await (await page.waitForSelector('[data-testid=receivables-account-missing] button'))!.click();
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.value === '1100', { timeout: 10_000 }, soll)
      .catch(async () => assert.fail(`Soll shows «${await page.$eval(soll, (el) => (el as HTMLInputElement).value)}» after 1100 was added`));
  } finally {
    await closeChrome(browser);
    await vite.close();
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
