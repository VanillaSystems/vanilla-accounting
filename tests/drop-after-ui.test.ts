/**
 * After the drop she sees her data (#424), in the real UI on the webshop persona's new books,
 * without a model (the provider path and a statement PDF placed by its text are code):
 * - the reports the dialog says it booked («2 Berichte gebucht», after her answers in the rows) are
 *   on the page behind at once, MWST and the dock, without a reload (before: the page kept the
 *   figures of before the drop until the window was reloaded);
 * - closing the window after a statement PDF kept as the account's statement opens that statement
 *   in its own quarter (before: the PDF «file» in today's quarter, «… ist nicht eingelesen»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Page } from 'puppeteer-core';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, type Answers } from '../src/workspace/setup.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, type Uid } from '../src/workspace/workspace.js';
import type { Iban } from '../src/workspace/banks.js';
import { noBrowser, openApp } from './support/e2e.js';
import { textPdf } from './support/text-pdf.js';
import './support/jurisdiction.js';

// @ts-expect-error a plain ES module of the verify skill, without types
import webshop from '../.claude/skills/verify/persona-files/webshop.mjs';

const FILES = (webshop as () => { files: Record<string, string> })().files;
const IBAN = /<Acct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(FILES['camt053_LUKB_Q3-2026.xml'])![1] as Iban;

function shopBooks(): string {
  const root = mkdtempSync(join(tmpdir(), 'webshop-'));
  const { answers, vat } = checkAnswers({ ...PRESETS.webshop.answers } as Answers, []);
  applyPlan(root, planWorkspace({ name: 'Teegarten Beispiel GmbH', uid: 'CHE-153.004.184' as Uid, owner: 'Corinne Beispiel', preset: 'webshop', answers, vat, banks: [{ bank: 'LUKB', currency: 'CHF', account: '1020', iban: IBAN }] }, loadChart(), '2026'));
  return relative(process.cwd(), join(root, APP_FOLDER));
}

/** Drops the files on the page as the window's drop does. */
async function dropIn(page: Page, files: Array<{ name: string; type: string; b64: string }>): Promise<void> {
  await page.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
  }, files);
}
const csv = (name: string) => ({ name, type: 'text/csv', b64: Buffer.from(FILES[name]).toString('base64') });

const dockText = (page: Page) => page.$eval('nav.activity', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));
const vatText = (page: Page) => page.$eval('[data-testid=vat-pending]', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));
const mainText = (page: Page) => page.$eval('main, #root', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));

test('in the app: what the drop booked is on the page behind at once, and closing it opens the dropped statement in its quarter', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp(shopBooks());
  const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'drop-after-'));
  try {
    const { page, api } = app;
    // Her first drop: the bank's export, its 40 payouts of Shopify waiting for the clearing account.
    const s = (await api.send('POST', '/api/drop')).json as { id: string };
    await api.fetch(`/api/drop/${s.id}/files?name=camt053_LUKB_Q3-2026.xml`, { method: 'POST', body: new Uint8Array(Buffer.from(FILES['camt053_LUKB_Q3-2026.xml'])), headers: { 'Content-Type': 'application/octet-stream' } });
    await api.send('DELETE', `/api/drop/${s.id}`);
    await api.rest();

    await app.open('/vat?period=2026-Q3', 'nav.activity');
    await page.waitForNetworkIdle({ timeout: 30_000 }).catch(() => undefined);
    const dockBefore = await page.$eval('nav.activity', (e) => e.textContent ?? '');
    const vatBefore = await page.$eval('[data-testid=vat-pending]', (e) => e.textContent ?? '');
    await page.screenshot({ path: join(shots, '01-vat-before.png') });

    // Her second drop on MWST: the orders export and the payments export; she answers the rows' questions with their proposals.
    await dropIn(page, [csv('orders_export_1.csv'), csv('payment_transactions_export_1.csv')]);
    for (let i = 0; i < 10; i++) {
      await page.waitForFunction(() => document.querySelector('form[data-testid=drop-provider]') || document.querySelector('[data-testid=drop-summary]'), { timeout: 60_000 });
      const form = await page.evaluate(() => { const f = document.querySelector<HTMLFormElement>('form[data-testid=drop-provider]'); f?.requestSubmit(); return !!f; });
      if (!form) break;
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 30_000 });
    }
    await page.waitForFunction(() => /2 Berichte gebucht/.test(document.querySelector('[data-testid=drop-summary]')?.textContent ?? ''), { timeout: 60_000 });
    // The page behind the window, still open and not reloaded: the dock and MWST show the books as they are now.
    const moved = await page.waitForFunction((dock, vat) => !!document.querySelector('[data-testid=drop-dialog]')
      && document.querySelector('nav.activity')?.textContent !== dock && document.querySelector('[data-testid=vat-pending]')?.textContent !== vat,
    { timeout: 20_000 }, dockBefore, vatBefore).then(() => true, () => false);
    await page.screenshot({ path: join(shots, '02-vat-after-reports.png') });
    assert.ok(moved, `while the window is open, the dock and MWST show what it booked: ${await dockText(page)} | ${await vatText(page)}`);
    assert.ok(await page.$('[data-testid=drop-dialog]'), 'the window is still open');
    await page.click('[data-testid=drop-close]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-dialog]'));
    await page.screenshot({ path: join(shots, '03-vat-closed.png') });

    // A third drop on Kontoauszüge: the bank's PDF statement of the quarter, kept as the account's statement beside its export.
    await app.open('/bank?period=2026-Q3', 'nav.activity');
    const pdf = await textPdf(['Luzerner Kantonalbank', 'Kontoauszug 01.07.2026 - 30.09.2026', `IBAN ${IBAN.replace(/(.{4})/g, '$1 ').trim()}`, 'Teegarten Beispiel GmbH', 'Saldo per 30.09.2026']);
    await dropIn(page, [{ name: 'LUKB_Kontoauszug_Q3_2026.pdf', type: 'application/pdf', b64: pdf.toString('base64') }]);
    await page.waitForFunction(() => document.querySelector('[data-testid=drop-row][data-file="LUKB_Kontoauszug_Q3_2026.pdf"]')?.classList.contains('s-taken') && !!document.querySelector('[data-testid=drop-summary]'), { timeout: 60_000 })
      .catch(async (e) => { await page.screenshot({ path: join(shots, '04-pdf-row.png') }); throw e; });
    await page.click('[data-testid=drop-close]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-dialog]'));
    await page.waitForNetworkIdle({ timeout: 30_000 }).catch(() => undefined);
    const url = new URL(page.url());
    await page.screenshot({ path: join(shots, '04-bank-closed.png') });
    console.log(`screenshots: ${shots}`);
    // No period in the link is the open quarter, Q3 here: the heading says which.
    assert.ok([null, '2026-Q3'].includes(url.searchParams.get('period')), `the quarter of the statement: ${url.pathname}${url.search}`);
    assert.match(await page.$eval('[data-testid=period-picker]', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ')), /Q3 2026/);
    assert.equal(decodeURIComponent(url.pathname), '/bank/1020-2026-07', 'the statement she dropped');
    assert.doesNotMatch(await mainText(page), /ist nicht eingelesen/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
