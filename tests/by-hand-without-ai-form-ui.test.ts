/**
 * The hand form of a payment in the real page (#344, review of #356), on a trades firm's fresh
 * books: it opens only once the server's answer about the payment is in (no first guess replaced
 * under her), a customer payment opens 3400 · V81 with the line that says the app takes it for a
 * sale, and when she changes the account to the owner's the proposed V81 leaves the VAT field, so
 * the booking carries no code. The real UI (Vite, from the repo) on the real API server, headless.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApi } from './support/api-server.js';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { devProxy } from '../src/server/app-paths.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';

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

test('the hand form opens with the final proposal, and a proposed sale code leaves when she books the money onto the owner\'s account', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'by-hand-form-ui-'));
  const manifest = join(dir, 'manifest');
  mkdirSync(manifest);
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: tradesManifest(manifest) });
  // The demo's chart: the owner's account 2451 and the revenue accounts are in it.
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  copyFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'master-data/accounts.json'), api.ws.paths.accounts);
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
    await page.setViewport({ width: 1400, height: 1000 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('language', 'de');
      // When the server's answer about the payment came in, and when the form first stood on the page.
      const w = window as unknown as { startAt?: number; formAt?: number };
      const real = window.fetch.bind(window);
      window.fetch = async (...a: Parameters<typeof fetch>) => {
        const r = await real(...a);
        if (String(a[0]).includes('/api/rules/hand?')) w.startAt ??= performance.now();
        return r;
      };
      new MutationObserver(() => { if (!w.formAt && document.querySelector('[data-testid=payment-booking]')) w.formAt = performance.now(); })
        .observe(document, { childList: true, subtree: true });
    });
    // The server's answer comes late, as on a slow Mac.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().includes('/api/rules/hand?')) setTimeout(() => void r.continue(), 1500);
      else void r.continue();
    });

    await page.goto(`${ui}/payments/K1`, { waitUntil: 'networkidle0', timeout: 120_000 });
    await page.waitForSelector('[data-testid=payment-booking]', { timeout: 30_000 });
    const seen = await page.evaluate(() => { const w = window as unknown as { startAt?: number; formAt?: number }; return { startAt: w.startAt, formAt: w.formAt }; });
    assert.ok(seen.startAt !== undefined && seen.formAt !== undefined && seen.formAt >= seen.startAt, `the form waits for the answer: ${JSON.stringify(seen)}`);

    const field = (name: string) => page.$eval(`[name="${name}"]`, (e) => (e as HTMLInputElement).value);
    assert.deepEqual([await field('accountDebit-0'), await field('accountCredit-0'), await field('vatCode-0')], ['1021', '3400', 'V81']);
    const text = () => page.$eval('[data-testid=payment-booking]', (e) => (e as HTMLElement).innerText);
    assert.match(await text(), /nimmt einen Verkauf an/);
    assert.match(await page.$eval('[data-testid=proposal]', (e) => e.textContent ?? ''), /V81/);
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, 'form-sale-proposal.png') });

    // She books the money onto the owner's account: by the list, with the mouse.
    const credit = (await page.$('[name="accountCredit-0"]'))!;
    await credit.click({ count: 3 });
    await credit.type('2451');
    await page.waitForSelector('.acl [role=option]');
    await page.$$eval('.acl [role=option]', (os) => { const o = os.find((x) => x.textContent?.startsWith('2451')); o?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await page.waitForFunction(() => (document.querySelector('[name="vatCode-0"]') as HTMLInputElement | null)?.value === '', { timeout: 10_000 });
    assert.equal(await field('accountCredit-0'), '2451');
    assert.doesNotMatch(await page.$eval('[data-testid=payment-booking]', (e) => (e as HTMLElement).innerText), /V81|nimmt einen Verkauf an/, 'no sale code and no sale assumed stands anywhere on the form');
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, 'form-owner-no-code.png') });

    await page.click('[data-testid=payment-booking] button[type=submit]');
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      if (loadBooks(api.ws).journalEntries.some((e) => e.transactionRef === 'K1')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const entries = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'K1').map((e) => [e.accountDebit, e.accountCredit, e.vatCode ?? '', e.origin]);
    assert.deepEqual(entries, [['1021', '2451', '', 'manual']]);
  } finally {
    await closeChrome(browser);
    await vite.close();
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
