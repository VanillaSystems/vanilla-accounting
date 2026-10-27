/**
 * «KI ganz ausschalten» in the page (issue #212): with the switch on, each area that would ask the
 * AI says so and offers its way by hand. The real UI (Vite, from the repo) on the real API server
 * with a `claude` that records every model call, driven in a headless browser: a receipt the AI
 * would read says it waits because the AI is off, pairing searches by amount, date and name only,
 * «Neu klassifizieren» shows the error line with «KI einschalten», the KI column's input is off
 * with the link to Firma › KI. Unticking the switch there turns the column back on. No call
 * reaches the model meanwhile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { findBrowser } from '../src/invoices/pdf.js';
import { devProxy } from '../src/server/app-paths.js';
import de from '../src/app/i18n/locales/de.js';
import type { Index } from '../src/types/index.js';

const browserPath = findBrowser();
const STUB = join(process.cwd(), 'tests/support/stub-bin');

test('each area says the AI is off and offers the way by hand; Firma › KI switches it on again', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-off-ui-'));
  const settings = join(dir, 'ai.json');
  const claudeCalls = join(dir, 'claude-args');
  writeFileSync(settings, JSON.stringify({ steps: {}, off: true }));
  const calls = () => (existsSync(claudeCalls) ? readFileSync(claudeCalls, 'utf8').split('\n').filter(Boolean) : []);
  const api = await startApi('demo/vanilla-accounting', {
    PATH: `${STUB}:${process.env.PATH}`, VANILLA_AI_SETTINGS: settings, CLAUDE_STUB_ARGS: claudeCalls, CLAUDE_BIN: '', CODEX_BIN: '', CODEX_HOME: join(dir, 'codex-home'),
  });
  // Built once and served by Vite's preview with the dev proxy: a dev server re-optimises its deps on first load and reloads the page under the test.
  const { build, preview } = await import('vite');
  const outDir = join(dir, 'dist');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const vite = await preview({
    configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir },
    preview: { host: '127.0.0.1', port: 0, proxy: devProxy(`http://127.0.0.1:${api.port}`) },
  });
  const ui = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('language', 'de'));
    const text = async (sel: string) => (await page.waitForSelector(sel, { timeout: 30_000 }))!.evaluate((e) => (e as HTMLElement).innerText);

    // Booking: a payment of the demo no rule books (the model would). Its entry's «Neu klassifizieren»
    // says it books by the rules, and without one shows the error line with «KI einschalten».
    const books = (await (await api.fetch('/books.json')).json()) as Index;
    const entry = (books.journalEntries ?? []).find((e) => e.transactionRef === '90000000039')!;
    await page.goto(`${ui}/journal/${entry.id}?period=2026-Q2`, { waitUntil: 'networkidle0', timeout: 120_000 });
    // Clicked in the page: the dock near the bottom edge may lie over the button.
    await (await page.waitForSelector(`button[data-tip="${de.messages['journal.reclassifyTipOff']}"]`))!.evaluate((b) => (b as HTMLButtonElement).click());
    const switchOn = await page.waitForSelector('[data-act=ai-set-up]');
    assert.equal(await switchOn!.evaluate((e) => (e as HTMLElement).innerText), de.messages['aiOff.line.switchOn']);
    assert.ok((await page.evaluate(() => document.body.innerText)).includes(de.messages['error.ai.off']), 'the line says the AI is off');

    // A scan only a model can read, taken in by an inbox run: it waits unread. (The run also drops
    // the demo's payments, whose statement files this temp workspace lacks: booking came first.)
    mkdirSync(join(api.root, 'beleg-import'), { recursive: true });
    writeFileSync(join(api.root, 'beleg-import', 'Scan 7.pdf'), '%PDF-1.4\n% a scan: no text a program can read\n%%EOF\n');
    assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } })).json.ok, true);
    await api.rest();
    const scan = ((await (await api.fetch('/books.json')).json()) as Index).receipts.find((r) => !r.extractedText.trim());
    assert.ok(scan, 'the scan is a receipt, unread');

    // Receipt reading: the scan says it waits because the AI is off.
    await page.goto(`${ui}/receipts/${scan.id}?period=all`, { waitUntil: 'networkidle0' });
    assert.match(await text('[data-testid=waits-ai-off]'), new RegExp(de.messages['receipts.waitsAiOff'].slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Pairing: with date and amount entered by hand, «Zahlung suchen» searches by amount, date and name only.
    assert.equal((await api.send('PATCH', `/api/receipts/${scan.id}`, { date: '2026-09-20', amount: 987.65, currency: 'CHF' })).status, 200);
    await page.goto(`${ui}/receipts/${scan.id}?period=2026-Q3`, { waitUntil: 'networkidle0' });
    await (await page.waitForSelector('[data-testid=find-payment]'))!.click();
    assert.equal(await text('[data-testid=pair-no-model]'), de.messages['pair.aiOff']);

    // Chat: the KI column's input is off and links to Firma › KI.
    await page.keyboard.down('Meta'); await page.keyboard.press('j'); await page.keyboard.up('Meta');
    assert.ok((await text('[data-testid=column-ai-off]')).includes(de.messages['aiOff.side.title']));
    const input = await page.$('textarea[aria-label]');
    assert.deepEqual(await input!.evaluate((e) => [(e as HTMLTextAreaElement).disabled, (e as HTMLTextAreaElement).placeholder]), [true, de.messages['aiOff.side.placeholder']]);
    await (await page.waitForSelector('[data-act=ai-off-firma]'))!.click();
    await page.waitForFunction(() => location.pathname === '/company/ai');

    assert.deepEqual(calls(), [], 'no call reached the model while the AI was off');

    // Firma › KI: unticked, the switch is off and the column asks again.
    const box = await page.waitForSelector('input[name=ai-off]');
    assert.equal(await box!.evaluate((e) => (e as HTMLInputElement).checked), true);
    await box!.click();
    await page.waitForFunction(() => !(document.querySelector('input[name=ai-off]') as HTMLInputElement).checked);
    await page.waitForFunction(() => !document.querySelector('[data-testid=column-ai-off]'));
    assert.equal((await api.send('GET', '/api/status')).json.aiOff, false);
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).off, undefined, 'kept on this Mac: the switch is gone from the settings');
  } finally {
    await browser.close();
    await vite.close();
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
