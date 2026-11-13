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
        // The columns start lower, and still end at the window's foot: their last rows are reachable.
        const feet = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.list, .detail, main.full')].map((c) => Math.round(c.getBoundingClientRect().bottom)));
        assert.ok(feet.every((b) => b <= 600), `${width} ${path}: every column ends inside the window (${feet})`);
      }
    }
  } finally {
    await app.stop();
  }
});

/**
 * What keeps the columns clear of the bar cuts no overlay a column opens (#387 review): Quick Look and a dialog cover
 * the whole window, the dock and the bar's band included, and stand above the dock.
 */
test('Quick Look and a dialog opened in a column cover the whole window, above the dock and the top bar', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  try {
    const { page } = app;
    await page.setViewport({ width: 1280, height: 800 });
    /** The points the overlay must own: the dock, the bar's band, the corners, the middle. */
    const covered = (sel: string) => page.evaluate((sel) => {
      const over = document.querySelector(sel)!;
      const points: Array<[number, number]> = [[20, 400], [20, 780], [640, 20], [640, 60], [1260, 20], [1260, 780], [640, 400]];
      return points.filter(([x, y]) => { const at = document.elementFromPoint(x, y); return !at || !(over === at || over.contains(at)); })
        .map(([x, y]) => { const at = document.elementFromPoint(x, y) as HTMLElement | null; return `${x},${y} ${at?.tagName}.${at?.className}`; });
    }, sel);

    await app.open('/receipts?period=2026-Q2', '.topbar');
    await page.waitForSelector('.detail .paper.real', { visible: true, timeout: 30_000 });
    await page.click('.detail .paper.real');
    await page.waitForSelector('.quick', { visible: true, timeout: 10_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/review-quick.png` });
    assert.deepEqual(await covered('.quick'), [], 'Quick Look covers the window');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.quick'), { timeout: 10_000 });

    await app.open('/journal?period=2026-Q2', '.topbar');
    await page.waitForSelector('[data-add]', { visible: true, timeout: 30_000 });
    await page.click('[data-add]');
    await page.waitForSelector('.scrim', { timeout: 10_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/review-dialog.png` });
    // The scrim, or the dialog on it, owns every point: a click on the dock does not reach it.
    const free = await page.evaluate(() => {
      const scrim = document.querySelector('.scrim')!;
      const dialog = scrim.nextElementSibling ?? scrim.parentElement!;
      const points: Array<[number, number]> = [[20, 400], [20, 780], [640, 20], [1260, 20], [1260, 780]];
      return points.filter(([x, y]) => { const at = document.elementFromPoint(x, y); return !at || !(at === scrim || dialog.contains(at)); })
        .map(([x, y]) => { const at = document.elementFromPoint(x, y) as HTMLElement | null; return `${x},${y} ${at?.tagName}.${at?.className}`; });
    });
    assert.deepEqual(free, [], 'the dialog\'s scrim covers the window, the dock included');
  } finally {
    await app.stop();
  }
});
