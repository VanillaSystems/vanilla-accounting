/**
 * End to end: typing quickly from field to field on a draft's sheet (UAT F14). A number field selects its value one
 * frame after it is entered; keys typed in that frame replace the value too, never land beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noBrowser, openApp } from './support/e2e.js';

/** The demo's draft for Muster Hotel GmbH: line 1 is 1 × 680, line 2 is 1 × 45. */
const DRAFT = 'in_8rkN6yKIRdjB';

interface DraftView { lines: Array<{ quantity: number; price: number }> }

test('quantity and price typed fast one after the other are saved as typed', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  const lines = async () => ((await api.send('GET', `/api/invoices/${DRAFT}`)).json as unknown as DraftView).lines.map((l) => [l.quantity, l.price]);
  try {
    await app.open(`/invoices/draft-${DRAFT}?period=2026`);
    await page.waitForSelector('[data-ed="l:0:quantity"]');
    await page.click('[data-ed="l:0:quantity"]');
    await page.keyboard.type('12');
    await page.click('[data-ed="l:0:price"]');
    await page.keyboard.type('160');
    await page.click('[data-ed="l:1:quantity"]');
    await page.keyboard.type('3');
    await page.click('[data-ed="l:1:price"]');
    await page.keyboard.type('25');
    await page.keyboard.press('Enter');
    const want = [[12, 160], [3, 25]];
    await page.waitForNetworkIdle({ idleTime: 500 });
    const deadline = Date.now() + 10_000;
    while (JSON.stringify(await lines()) !== JSON.stringify(want) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await lines(), want, 'the draft holds what was typed');
    const shown = await page.$$eval('[data-ed$=":quantity"], [data-ed$=":price"]', (els) => els.map((e) => (e as HTMLElement).innerText.trim()));
    assert.deepEqual(shown, ['12', '160.00', '3', '25.00'], 'the sheet shows what was typed');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
