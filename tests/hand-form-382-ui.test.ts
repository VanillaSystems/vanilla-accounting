/**
 * #382 in the real page: a payment that names the number of her own invoice opens with that
 * invoice found and its code (abroad: V0-E), and «Verknüpfen und buchen» links and books it; one
 * whose invoice shows no VAT asks the sale question, and her answer sets the code. The amount field
 * stays readable beside a proposal line at 1024, 1280 and 1440 px, with the AI sidebar open too.
 * The real UI (Vite, from the repo) on the real API server, headless.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { startApi } from './support/api-server.js';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { devProxy } from '../src/server/app-paths.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { loadBooks, saveBooks } from '../src/books/store.js';
import type { Receipt } from '../src/types/index.js';

const EVIDENCE = process.env.EVIDENCE_DIR;

function tradesManifest(dir: string): string {
  const demo = readFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'belege.workspace.yaml'), 'utf8');
  writeFileSync(join(dir, 'belege.workspace.yaml'), `${demo.trimEnd()}
profile:
  preset: trades
  fiscalYear: calendar
  start: new
  sells: both
  foreignCustomers: no
  imports: no
  employees: staff
  ownerPaysPrivately: yes
  privateUse: [car, phone]
  payouts: no
  goods: [made]
`);
  return dir;
}

/** The amount field's width, whether its label stays on one line, and whether it stands in the row of the accounts (wide form). */
const amountBox = (page: Page) => page.$eval('[data-testid=payment-booking] .pbl', (row) => {
  const label = row.querySelector('.pba') as HTMLElement;
  const input = label.querySelector('input') as HTMLInputElement;
  const debit = row.querySelector('[name^="accountDebit-"]') as HTMLInputElement;
  const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 16;
  return { width: input.getBoundingClientRect().width, labelLines: Math.round((input.getBoundingClientRect().top - label.getBoundingClientRect().top) / lineHeight), sameRow: Math.abs(input.getBoundingClientRect().top - debit.getBoundingClientRect().top) < 4, value: input.value };
});

test('her own invoice found by its number, linked and booked from the form; the sale question; the amount readable', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hand-form-382-ui-'));
  const manifest = join(dir, 'manifest');
  mkdirSync(manifest);
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: tradesManifest(manifest) });
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  copyFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'master-data/accounts.json'), api.ws.paths.accounts);
  await api.rest();
  const uid = api.ws.company.uid;
  const b = loadBooks(api.ws);
  const k1 = b.transactions.find((t) => t.ref === 'K1')!;
  const k4 = b.transactions.find((t) => t.ref === 'K4')!;
  k4.description = 'Rechnung 2026-030 Fassade';
  const own = (id: string, number: string, body: string): Receipt => ({ id, filename: `Rechnung_${number}.pdf`, date: '2026-07-20', location: 'archived', extractionMethod: 'pdftotext',
    extractedText: `${api.ws.company.name}\nMWST-Nr. ${uid} MWST\n\nFamilie Bauer\n78462 Konstanz, Deutschland\n\nRechnung ${number}\nDatum: 20.07.2026\n${body}` }) as unknown as Receipt;
  b.receipts.push(own('r029', '2026-029', `Malerarbeiten ${k1.amount.toFixed(2)}\nTotal CHF ${k1.amount.toFixed(2)}\nLeistungsort Deutschland: nicht der schweizerischen MWST unterstellt.`));
  b.receipts.push(own('r030', '2026-030', `Fassade ${k4.amount.toFixed(2)}\nTotal CHF ${k4.amount.toFixed(2)}`));
  saveBooks(api.ws, b);

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
    const field = (name: string) => page.$eval(`[name="${name}"]`, (e) => (e as HTMLInputElement).value);
    const open = async (ref: string, width: number) => {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${ui}/payments/${ref}`, { waitUntil: 'networkidle0', timeout: 120_000 });
      await page.waitForSelector('[data-testid=payment-booking] [data-testid=proposal], [data-testid=payment-booking] [data-testid=sale-question]', { timeout: 30_000 });
    };

    // The amount beside a proposal line, at each width, and with the AI sidebar open.
    for (const width of [1024, 1280, 1440]) {
      await open('K1', width);
      for (const sidebar of [false, true]) {
        // The sidebar's state is kept between pages: open it only where it is closed, close it before the next width.
        const isOpen = () => page.$eval('.aibtn', (e) => e.getAttribute('aria-expanded') === 'true');
        if (sidebar !== await isOpen()) { await page.click('.aibtn'); await new Promise((r) => setTimeout(r, 600)); }
        assert.equal(await isOpen(), sidebar);
        // As the payment's detail shows it (narrow), and as wide as a task card shows it (640 px, the four fields in one row, 40-tasks-open.png).
        for (const wide of [false, true]) {
          await page.evaluate((w) => { const f = document.querySelector('[data-testid=payment-booking]') as HTMLElement; f.style.width = w ? '640px' : ''; }, wide);
          const box = await amountBox(page);
          const at = `${width}px${sidebar ? ' with the sidebar' : ''}${wide ? ', wide form' : ''}`;
          assert.ok(box.width >= 80, `${at}: amount field ${box.width}px wide`);
          assert.equal(box.labelLines, 1, `${at}: «Betrag CHF» on one line`);
          if (wide) assert.ok(box.sameRow, `${at}: the amount stands in the row of the accounts`);
          if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `amount-${width}${sidebar ? '-ai' : ''}${wide ? '-wide' : ''}.png`) });
        }
      }
    }

    await open('K1', 1440);
    assert.equal(await page.$eval('[data-testid=own-invoice]', (e) => e.getAttribute('data-receipt')), 'r029');
    assert.deepEqual([await field('accountCredit-0'), await field('vatCode-0')], ['3400', 'V0-E']);
    assert.match(await page.$eval('[data-testid=proposal]', (e) => e.textContent ?? ''), /Leistungsort im Ausland/);
    assert.doesNotMatch(await page.$eval('[data-testid=payment-booking]', (e) => (e as HTMLElement).innerText), /keine Rechnung verknüpft|V81/);
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, 'own-invoice-abroad.png') });
    await page.click('[data-testid=payment-booking] button[type=submit]');
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      if (loadBooks(api.ws).journalEntries.some((e) => e.transactionRef === 'K1')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const after = loadBooks(api.ws);
    assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === 'K1').map((e) => [e.accountCredit, e.vatCode, e.receipts]), [['3400', 'V0-E', ['r029']]]);
    assert.ok(after.mappings.some((m) => m.transactionRef === 'K1' && m.receiptId === 'r029'));

    // Her invoice shows no VAT and names no place abroad: no code, the sale question; her answer books the lines with its code, as the card's does.
    await open('K4', 1280);
    assert.equal(await field('vatCode-0'), '');
    await page.waitForSelector('[data-testid=sale-question] [data-choice=saleAbroad]');
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, 'sale-question.png') });
    await page.click('[data-testid=sale-question] [data-choice=saleDomestic]');
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      if (loadBooks(api.ws).journalEntries.some((e) => e.transactionRef === 'K4')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const k4 = loadBooks(api.ws);
    assert.deepEqual(k4.journalEntries.filter((e) => e.transactionRef === 'K4').map((e) => [e.accountCredit, e.vatCode, e.origin, e.receipts]), [['3400', 'V81', 'manual', ['r030']]]);
    // The answered question stands on the payment, with «Immer so?».
    await page.waitForSelector('[data-question] [data-act=sale-always]', { timeout: 15_000 });
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, 'sale-question-answered.png') });
  } finally {
    await closeChrome(browser);
    await vite.close();
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
