/**
 * An answer and the «Stand Q3 2026» card under it wrap inside the AI sidebar (#362, first-ai-26:
 * the text was cut at the right edge of the 400 px sidebar and a horizontal scrollbar appeared).
 * The answer's markup as src/app/shell/Sidebar.tsx and src/app/assistant/OpenPeriodCard.tsx write it,
 * in the real CSS, at 320 and 400 px, light and dark: nothing reaches past the column.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';

const LONG = '5 Zahlungen noch nicht gebucht (alle warten auf ihren Beleg)';
const ANSWER = `
  <div class="msg me">was muss ich jetzt no mache?<small>Rechnung 2026-030 Fassade Garage</small></div>
  <div class="msg ai"><svg class="bot"></svg><div>
    <div class="aitext">
      <p>Das ist für Q3 noch offen:</p>
      <ul>
        <li><strong>Kontoauszüge:</strong> 5 Zahlungen sind noch nicht gebucht. Die App bucht sie selbst, sobald ihre Belege zugeordnet sind.</li>
        <li><strong>Fällig:</strong> Die MWST-Abrechnung für Q3 ist bis 29.11.2026 fällig: https://www.estv.admin.ch/estv/de/home/mehrwertsteuer/abrechnen.html</li>
        <li>Rechnungsnummer FM-77812-2026-Q3-Farbmix-AG-Malerbedarf-Gossau-Ostschweiz</li>
      </ul>
      <p>Die Swisscom-Regel ist behalten und gilt ab der nächsten passenden Zahlung.</p>
    </div>
    <ul class="aichanges"><li class="aimailbox"><section class="openp">
      <h3>Stand Q3 2026</h3>
      <p class="m"><a class="linkbtn" href="#">Abrechnung fällig am 29.11.2026</a></p>
      <ul>
        <li><a class="linkbtn" href="#">${LONG}</a><small>${LONG}</small></li>
        <li><a class="linkbtn" href="#">3 Belege ohne Zahlung</a></li>
      </ul>
    </section></li></ul>
  </div></div>`;

test('an answer and its card wrap inside the sidebar at 320 and 400 px, light and dark', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 120_000 }, async () => {
  const css = ['tokens.css', 'shell.css', 'detail.css', 'assistant.css'].map((f) => readFileSync(`src/app/styles/${f}`, 'utf8')).join('\n');
  const browser = await launchChrome(browserPath!);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    for (const width of [320, 400]) {
      for (const theme of ['light', 'dark']) {
        await page.setContent(`<html data-theme="${theme}" style="--aiw: ${width}px"><style>body { margin: 0 } ${css}</style><body>
          <aside class="aside"><div class="aiturns">${ANSWER}</div></aside></body></html>`);
        const out = await page.evaluate(() => {
          const turns = document.querySelector('.aiturns')!;
          const right = turns.getBoundingClientRect().right;
          const past = [...turns.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > right + 0.5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
          return { scroll: turns.scrollWidth, client: turns.clientWidth, past };
        });
        assert.ok(out.scroll <= out.client, `${width} px, ${theme}: no horizontal scroll (${out.scroll} > ${out.client})`);
        assert.deepEqual(out.past, [], `${width} px, ${theme}: nothing reaches past the column`);
      }
    }
  } finally {
    await closeChrome(browser);
  }
});
