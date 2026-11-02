/**
 * F07: an account the books lack is added from the account field itself, but only one of the standard
 * chart, named with number and name before it is added («6600 Werbeaufwand anlegen»), through the
 * route Firma › Kontenplan adds accounts with. The real UI on the real API server on the demo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noBrowser, openApp } from './support/e2e.js';

const ID = 'b9a7cba1c428824f';

test('F07: typing «werbe» in an entry\'s Soll offers «6600 Werbeaufwand anlegen»; picking it adds the account and books on it', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  try {
    const chart = () => JSON.parse(readFileSync(join(app.api.root, 'master-data', 'accounts.json'), 'utf8')) as Array<{ number: string; name: string }>;
    assert.equal(chart().some((a) => a.number === '6600'), false, 'the demo\'s chart has no 6600');
    const { page } = app;
    await app.open(`/journal/${ID}?period=2026-Q2`);
    await page.waitForSelector(`[data-for="${ID}"]`);
    const debit = 'input[name=accountDebit]';
    await page.keyboard.press('e');
    await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), {}, debit);
    await page.keyboard.type('werbe');
    await page.waitForSelector('[role=listbox] [data-act=account-add]');
    const offered = await page.$$eval('[role=listbox] [role=option]', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(offered, ['6600 Werbeaufwand anlegen'], 'named with number and name before it is added');
    await page.keyboard.type('xyz');
    await page.waitForFunction(() => document.querySelector('[role=listbox] li.none'));
    assert.equal(chart().some((a) => a.number === '6600'), false, 'listing adds nothing');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await page.waitForSelector('[role=listbox] [data-act=account-add]');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 100 && (app.books().journalEntries ?? []).find((e) => e.id === ID)?.accountDebit !== '6600'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(chart().find((a) => a.number === '6600'), { number: '6600', name: 'Werbeaufwand' }, 'added to the chart under the standard chart\'s name');
    assert.equal((app.books().journalEntries ?? []).find((e) => e.id === ID)?.accountDebit, '6600', 'the entry is booked on it');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
