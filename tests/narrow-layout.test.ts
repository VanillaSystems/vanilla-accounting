/**
 * A narrow window with the AI sidebar open (issue #34): the detail keeps at least DETAIL_MIN, the list narrows to its
 * compact LIST_MIN first, the sidebar narrows to its least, and with still less room it lies over the page's right
 * edge instead of squeezing it (src/app/shell/look.ts sidebarFit, shell.css and assistant.css under `main` and `html.aiover`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DETAIL_MIN, LIST_MIN, sidebarFit, sidebarWidths } from '../src/app/shell/look.js';
import { closeChrome, launchChrome } from './support/browser.js';
import { findBrowser } from '../src/invoices/pdf.js';

const DOCK = 52;
const fit = (window: number, setup = false) => sidebarFit(window - DOCK, sidebarWidths(window, setup));

test('the sidebar stays beside the page while the list and the detail fit at their narrowest, else it lies over it', () => {
  assert.deepEqual(fit(1440), { width: 400, over: false }, 'a wide window: the sidebar as wide as it wants');
  assert.deepEqual(fit(1100), { width: 1100 - DOCK - LIST_MIN - DETAIL_MIN, over: false }, '1100 px: the sidebar gives up a little for the detail');
  assert.deepEqual(fit(1440, true), { width: 1440 - DOCK - LIST_MIN - DETAIL_MIN, over: false }, 'setup on a wide window: beside, a bit narrower');
  assert.deepEqual(fit(1100, true), { width: 520, over: true }, 'setup at 1100 px: over the page at its least');
  assert.deepEqual(fit(900), { width: 306, over: true }, '900 px: over the page, no wider than it wants');
});

const browserPath = findBrowser();

test('the detail column keeps its minimum width and the list narrows first, in the real CSS', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 120_000 }, async () => {
  const css = ['shell.css', 'assistant.css'].map((f) => readFileSync(`src/app/styles/${f}`, 'utf8')).join('\n');
  const browser = await launchChrome(browserPath!);
  try {
    const page = await browser.newPage();
    const columns = async (window: number, { area = 'receipts', sidebar = 0, over = false, lw = '' } = {}) => {
      await page.setViewport({ width: window, height: 700 });
      await page.setContent(`<html class="${over ? 'aiover' : ''}" style="--aiw: ${sidebar}px"><style>body { margin: 0 } ${css}</style><body>
        <main data-area="${area}" style="${lw ? `--lw: ${lw}` : ''}"><section class="list"></section><section class="detail"></section></main></body></html>`);
      return page.evaluate(() => ({ list: document.querySelector('.list')!.getBoundingClientRect().width, detail: document.querySelector('.detail')!.getBoundingClientRect().width }));
    };
    for (const area of ['receipts', 'journal']) {
      const wide = await columns(1440, { area });
      assert.ok(wide.list > LIST_MIN && wide.detail > DETAIL_MIN, `${area}: a wide window keeps both columns roomy`);
      const beside = fit(1100);
      assert.deepEqual(await columns(1100, { area, sidebar: beside.width }), { list: LIST_MIN, detail: DETAIL_MIN }, `${area}: 1100 px with the sidebar: list compact, detail at its minimum`);
      const closed = await columns(900, { area });
      assert.ok(closed.detail >= DETAIL_MIN, `${area}: 900 px without the sidebar keeps the detail at ${DETAIL_MIN} or more (was ${closed.detail})`);
      assert.deepEqual(await columns(900, { area, sidebar: 306, over: true }), { list: LIST_MIN, detail: 900 - DOCK - LIST_MIN }, `${area}: the sidebar over the page leaves the page the window, the list compact`);
    }
    assert.equal((await columns(1100, { sidebar: fit(1100).width, lw: '900px' })).detail, DETAIL_MIN, 'a list dragged wide still leaves the detail its minimum');
  } finally {
    await closeChrome(browser);
  }
});
