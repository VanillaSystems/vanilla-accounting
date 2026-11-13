/**
 * The floating top bar covers nothing a column scrolled up (#385, round 2: «KI einrichten» in Belege, «Aufgaben» and
 * «Regeln» in Automatisierung stood under it): at 1024 and 1280 px, with the list and the detail scrolled, no point of
 * the band the bar stands in reaches the columns' content. The real UI on the real API server on the demo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noBrowser, openApp } from './support/e2e.js';

test('a list or detail scrolled up ends below the top bar, at 1024 and 1280 px', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  try {
    const { page } = app;
    for (const width of [1024, 1280]) {
      await page.setViewport({ width, height: 600 });
      for (const path of ['/receipts?period=2026-Q2', '/automation', '/journal?period=2026-Q2']) {
        await app.open(path, '.topbar');
        // The list has its rows once it is longer than the window.
        await page.waitForFunction(() => { const l = document.querySelector('.list'); return !!l && l.scrollHeight > l.clientHeight; }, { timeout: 20_000 });
        // Scrolled as far as each column goes, at most 300 px.
        await page.evaluate(() => { for (const c of document.querySelectorAll<HTMLElement>('.list, .detail, main.full')) c.scrollTop = 300; });
        await new Promise((r) => setTimeout(r, 200));
        const under = await page.evaluate(() => {
          const bar = document.querySelector('.topbar')!.getBoundingClientRect();
          const columns = [...document.querySelectorAll<HTMLElement>('.list, .detail, main.full')].filter((c) => c.scrollTop > 0);
          const found: string[] = [];
          for (let y = 4; y < bar.bottom; y += 8) {
            for (let x = 0; x < innerWidth; x += 16) {
              const at = document.elementFromPoint(x, y);
              const col = at && columns.find((c) => c !== at && c.contains(at));
              if (col) found.push(`${x},${y} ${at!.tagName}.${(at as HTMLElement).className} «${(at as HTMLElement).innerText?.slice(0, 30) ?? ''}»`);
            }
          }
          return { scrolled: columns.length, found: found.slice(0, 5) };
        });
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/layout-${width}-${path.split('?')[0].slice(1)}.png` });
        assert.ok(under.scrolled > 0, `${width} ${path}: a column scrolled`);
        assert.deepEqual(under.found, [], `${width} ${path}: nothing scrolled up stands in the bar's band`);
      }
    }
  } finally {
    await app.stop();
  }
});
