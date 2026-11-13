/**
 * Issue #453, in the real UI: a drop of 43 files (the consultancy persona's) shows its head, its
 * overview and its list each in its own place, at the narrowest window the Mac app allows (900 × 600)
 * and a wide one; before, the line «Gesamt 51 % · 1 von 43 Dateien fertig» was drawn over the tabs.
 * The overview counts the rows by the state each row shows, each count a filter of the list; what
 * needs her is listed first, the files still worked on or done are folded into a line with their
 * count; the counts follow the session live. The drop's session is the server's answer, made up here
 * so the rows stand still while the boxes are measured: 41 receipts whose run is not in the poll
 * (worked on), a ZIP that asks its password, a file the books hold already.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { noBrowser, openApp } from './support/e2e.js';
import type { DropRow, DropSession } from '../src/types/drop.js';

const working = Array.from({ length: 41 }, (_, i): DropRow => ({ key: `r${i}`, id: `r${i}`, name: `Rechnung_${String(i + 1).padStart(2, '0')}.pdf`, size: 1, kind: 'receipt', state: 'taken', run: 'run-not-polled-yet' }));
const locked: DropRow = { key: 'z', id: 'z', name: 'Belege_Q3.zip', size: 1, kind: 'zip', state: 'locked' };
const known: DropRow = { key: 'k', id: 'k', name: 'Alpentel_Rechnung_2026-07.pdf', size: 1, kind: 'receipt', state: 'duplicate', reason: 'duplicate' };
const SESSION: DropSession = { id: 'many', rows: [locked, ...working, known] };

/** Answers the drop window's requests with the made-up session; `rows` may change between answers. */
async function fakeDrop(page: Page, rows: () => DropRow[]): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/drop')) { void r.continue(); return; }
    if (r.method() === 'DELETE') { void r.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); return; }
    void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: SESSION.id, rows: rows() }) });
  });
}

/** Every box of the dialog's parts (each direct child with all it draws, its overflow included) that lies over another. */
const overlaps = (page: Page) => page.evaluate(() => {
  const dlg = document.querySelector('[data-testid=drop-dialog]')!;
  const parts = [...dlg.children].filter((e) => (e as HTMLElement).offsetParent !== null).map((part) => {
    const scrolls = getComputedStyle(part).overflowY === 'auto';
    const rects = [part, ...(scrolls ? [] : part.querySelectorAll('*'))].map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.height);
    return { name: `${part.tagName.toLowerCase()}.${(part as HTMLElement).className}`, top: Math.min(...rects.map((b) => b.top)), bottom: Math.max(...rects.map((b) => b.bottom)) };
  });
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push(`${a.name} [${Math.round(a.top)}–${Math.round(a.bottom)}] over ${b.name} [${Math.round(b.top)}–${Math.round(b.bottom)}]`);
  }
  return out;
});

const filters = (page: Page) => page.$$eval('[data-testid=drop-filter]', (bs) => bs.map((b) => ({ name: (b.getAttribute('aria-label') ?? (b as HTMLElement).innerText).replace(/\s+/g, ' ').trim(), stage: (b as HTMLElement).dataset.stage, pressed: b.getAttribute('aria-pressed') })));
const listed = (page: Page) => page.$$eval('[data-testid=drop-row]', (rs) => rs.map((r) => (r as HTMLElement).dataset.file));

test('a drop of 43 files: head, overview and list each in its own place, the overview counts and filters the rows, live', { skip: noBrowser, timeout: 400_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  let rows = SESSION.rows;
  try {
    await fakeDrop(page, () => rows);
    await app.open('/bank?period=2026-Q3', '#root > *');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4'], 'Rechnung_01.pdf', { type: 'application/pdf' }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelector('[data-testid=drop-dialog]')?.textContent?.includes('Belege_Q3.zip'), { timeout: 60_000 });

    for (const [width, height] of [[900, 600], [1440, 900]]) {
      await page.setViewport({ width, height });
      await new Promise((r) => setTimeout(r, 300));
      if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `drop-43-working-${width}.png`) });
      assert.deepEqual(await overlaps(page), [], `${width} × ${height}: no part of the dialog lies over another`);
    }

    // The overview: one bar with its value, the stages counted from the rows, each a button with its count in its name.
    const bar = await page.$eval('[data-testid=drop-overview] [role=progressbar]', (b) => b.getAttribute('aria-valuenow'));
    assert.match(bar ?? '', /^\d+$/, 'the bar has a value');
    assert.deepEqual((await filters(page)).map((f) => f.name), ['43 Dateien', '1 braucht dich', '41 in Arbeit', '1 nicht übernommen'], 'stages without files are not shown');
    assert.equal(await page.$$eval('[data-testid=drop-dialog] .wftabs', (t) => t.length), 0, 'the tabs are folded into the overview\'s filters');
    const overall = await page.$$eval('[data-testid=drop-dialog]', (d) => (d[0] as HTMLElement).innerText.match(/Gesamt \d+ %/g) ?? []);
    assert.equal(overall.length, 1, 'one line says how far the drop is');

    // What needs her comes first and is listed; what is worked on or done is a line with its count, folded.
    assert.deepEqual(await listed(page), ['Belege_Q3.zip']);
    const groups = await page.$$eval('[data-testid=drop-group]', (gs) => gs.map((g) => `${(g as HTMLElement).dataset.stage} ${g.getAttribute('aria-expanded')}`));
    assert.deepEqual(groups, ['working false', 'out false']);
    await page.click('[data-testid=drop-group][data-stage=out]');
    assert.deepEqual(await listed(page), ['Belege_Q3.zip', 'Alpentel_Rechnung_2026-07.pdf'], 'a folded line opens its rows');

    // A filter shows its rows only, all of them; pressing it again shows the whole drop.
    await page.click('[data-testid=drop-filter][data-stage=working]');
    assert.equal((await listed(page)).length, 41);
    assert.equal((await filters(page)).find((f) => f.stage === 'working')?.pressed, 'true');
    await page.click('[data-testid=drop-filter][data-stage=working]');
    assert.equal((await filters(page)).find((f) => f.stage === 'working')?.pressed, 'false');

    // Live: the ZIP taken out of the drop, the counts follow the session's next answer.
    rows = SESSION.rows.filter((r) => r !== locked);
    await page.click('[data-testid=drop-row][data-file="Belege_Q3.zip"] .dx');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-filter][data-stage=needs]'));
    assert.deepEqual((await filters(page)).map((f) => f.name), ['42 Dateien', '41 in Arbeit', '1 nicht übernommen']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
