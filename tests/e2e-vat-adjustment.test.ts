/**
 * End to end: a Nachdeklaration entered in Firma › MWST for a filed entry changes the open quarter's return by its
 * amount, on the MWST page and in vat-report alike; removed, the figures are back, and the toast's «Rückgängig» brings
 * the same line back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { click, clickText, noBrowser, openApp, waitText } from './support/e2e.js';
import type { VatAdjustment } from '../src/types/index.js';

const LINE = '[data-testid=vat-adjustments] .fr[data-adjustment]';
const r2 = (n: number) => Math.round(n * 100) / 100;
const amount = (text: string) => Number(text.replace(/[’'\s]/g, ''));

/** The figures of the open quarter's MWST page, by Ziffer. */
async function onPage(page: Page): Promise<Record<string, number>> {
  await page.waitForSelector('.rows.vz .row[data-z="405"]');
  const rows = await page.$$eval('.rows.vz .row[data-z]', (rs) => rs.map((r) => [(r as HTMLElement).dataset.z!, r.querySelector('.a')?.textContent ?? '']));
  return Object.fromEntries(rows.filter(([z]) => ['405', '479', '500'].includes(z)).map(([z, a]) => [z, amount(a)]));
}

function inReport(root: string): Record<string, number> {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/vat-report.ts', '2026-Q2'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, VANILLA_WORKSPACE: root } });
  assert.equal(run.status, 0, run.stderr);
  return Object.fromEntries([...run.stdout.matchAll(/Ziffer (405|479|500) .*?([\d']+\.\d\d)$/gm)].map(([, z, a]) => [z, amount(a)]));
}

test('a Nachdeklaration moves 405, 479 and 500 by its amount on the MWST page and in vat-report; remove and undo', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  const adjustments = () => (JSON.parse(readFileSync(api.ws.paths.ledger, 'utf8')).config.vatAdjustments ?? []) as VatAdjustment[];
  try {
    await app.open('/vat?period=2026-Q2');
    const before = await onPage(page);
    assert.deepEqual(inReport(api.root), before, 'page and vat-report agree before');

    await app.open('/company/vat');
    await clickText(page, 'Nachdeklaration erfassen');
    await page.waitForSelector('[data-testid=adj-form]');
    await page.select('[data-testid=adj-form] select[name=period]', '2026-Q2');
    await page.select('[data-testid=adj-form] select[name=ziffer]', '405');
    await page.type('[data-testid=adj-form] input[name=amount]', '-1');
    const filed = await page.$eval('#adj-filed-entries option', (o) => (o as HTMLOptionElement).value);
    await page.type('[data-testid=adj-form] input[name=entries]', filed);
    await page.type('[data-testid=adj-form] textarea[name=reason]', 'Einfuhrsteuer zurückerstattet');
    await click(page, '[data-testid=adj-form] button[type=submit]');
    await waitText(page, 'Nachdeklaration erfasst: 2026-Q2, Ziffer 405.');
    await page.waitForSelector(LINE);
    const [line, ...more] = adjustments();
    assert.deepEqual(more, []);
    assert.deepEqual({ ...line, reason: undefined }, { id: '2026-Q2-1', period: '2026-Q2', ziffer: '405', amount: -1, entryIds: [filed], reason: undefined });

    const moved = { '405': r2(before['405'] - 1), '479': r2(before['479'] - 1), '500': r2(before['500'] + 1) };
    await app.open('/vat/405?period=2026-Q2');
    await page.waitForSelector('.vl.adj[data-adjustment="2026-Q2-1"]');
    assert.deepEqual(await onPage(page), moved, 'the MWST page carries the line');
    assert.deepEqual(inReport(api.root), moved, 'vat-report carries it too');

    await app.open('/company/vat');
    await click(page, `${LINE} button[aria-label="Nachdeklaration 2026-Q2 Ziffer 405 entfernen"]`);
    await waitText(page, 'Nachdeklaration entfernt: 2026-Q2, Ziffer 405.');
    assert.deepEqual(adjustments(), []);
    assert.deepEqual(inReport(api.root), before, 'removed, the figures are back');
    // The toast comes with the answer, the books reload after it: until then the removed line is still shown, and
    // waiting for the line after «Rückgängig» would find it before the undo is written. The toast hides after 6 s,
    // vat-report may take longer under load, and its undo outlives it (src/app/shell/Toast.tsx).
    await page.waitForSelector(LINE, { hidden: true });
    await click(page, '.toast button');
    await page.waitForSelector(LINE);
    assert.deepEqual(adjustments(), [line], 'the undo brings the same line back');

    await app.open('/vat?period=2026-Q2');
    assert.deepEqual(await onPage(page), moved);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
