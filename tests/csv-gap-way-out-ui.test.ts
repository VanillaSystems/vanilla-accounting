/**
 * Issue #425, in the real UI on a copy of the demo: a CSV no provider's file knows, its columns answered,
 * whose balance check fails ends with a way out. Before, the row said «Geht nicht auf: …» with «Einlesen»
 * greyed and no other button (webshop-ai-r2-7): now it says what to do, offers «Andere Spalten wählen»
 * (the column question again, as answered) and «Weglegen» (the file out of the drop, nothing in the books).
 * The list is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noBrowser, openApp } from './support/e2e.js';

// The webshop persona's payouts list (its header as persona-files/webshop.mjs writes it), on a firm whose knowledge has no file of the provider.
const PAYOUTS = ['Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency',
  '2026-07-01,paid,388.80,0.00,0.00,0.00,-12.18,0.00,376.62,CHF', '2026-07-03,paid,888.00,0.00,0.00,0.00,-28.44,0.00,859.56,CHF'].join('\n');

test('a provider\'s payouts list dropped alone at the first drop is named in its row and never summed up as «schon in den Büchern»', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  try {
    await app.open('/bank?period=2026-Q4', '#root > *');
    await page.evaluate((csv) => {
      const files = new DataTransfer();
      files.items.add(new File([csv], 'payouts_export.csv', { type: 'text/csv' }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: files, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    }, PAYOUTS);
    await page.waitForSelector('[data-testid=drop-other-export]', { timeout: 120_000 });
    await page.waitForSelector('[data-testid=drop-summary], [data-testid=drop-nothing-new]');
    const seen = await page.evaluate(() => ({
      row: document.querySelector<HTMLElement>('[data-testid=drop-other-export]')!.innerText,
      nothingNew: !!document.querySelector('[data-testid=drop-nothing-new]'),
      anyway: !!document.querySelector('[data-testid=drop-read-anyway]'),
      csv: !!document.querySelector('[data-testid=drop-csv]'),
    }));
    assert.match(seen.row, /^Das ist die Auszahlungsliste von Shopify/);
    assert.deepEqual([seen.nothingNew, seen.anyway, seen.csv], [false, true, false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

const LIST ='Datum;Text;Betrag\n01.12.2026;Eins;-12.00\n03.12.2026;Zwei;30.00\n';

test('a CSV whose table does not add up after its columns were answered offers other columns and setting it aside', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  try {
    await app.open('/bank?period=2026-Q4', '#root > *');
    await page.evaluate((csv) => {
      const files = new DataTransfer();
      files.items.add(new File([csv], 'liste.csv', { type: 'text/csv' }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: files, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    }, LIST);
    await page.waitForSelector('[data-testid=drop-csv]', { timeout: 120_000 });
    const account = await page.$eval('[data-testid=drop-csv-account]', (s) => [...(s as HTMLSelectElement).options].map((o) => o.value).find(Boolean)!);
    await page.select('[data-testid=drop-csv-account]', account);
    await page.select('[data-testid=drop-csv] select[data-field=date]', '0');
    await page.select('[data-testid=drop-csv] select[data-field=amount]', '2');
    await page.click('[data-testid=drop-csv-read]');
    await page.waitForSelector('[data-testid=drop-read-check][data-ok=false]');
    const end = await page.evaluate(() => ({
      check: document.querySelector<HTMLElement>('[data-testid=drop-read-check]')!.innerText,
      way: document.querySelector<HTMLElement>('[data-testid=drop-read-wayout]')?.innerText ?? '',
      columns: !!document.querySelector('[data-testid=drop-read-columns]'),
      aside: !!document.querySelector('[data-testid=drop-read-aside]'),
    }));
    assert.match(end.check, /^Geht nicht auf/);
    assert.match(end.way, /Saldi|Spalten/, 'the way out in words');
    assert.deepEqual([end.columns, end.aside], [true, true], 'and as buttons');

    // «Andere Spalten wählen»: the column question again, with the answer given.
    await page.click('[data-testid=drop-read-columns]');
    await page.waitForSelector('[data-testid=drop-csv]');
    assert.equal(await page.$eval('[data-testid=drop-csv] select[data-field=amount]', (s) => (s as HTMLSelectElement).value), '2');
    await page.click('[data-testid=drop-csv-read]');
    await page.waitForSelector('[data-testid=drop-read-check][data-ok=false]');

    // «Weglegen»: the row leaves the drop, nothing enters the books.
    const before = app.books().transactions.length;
    await page.click('[data-testid=drop-read-aside]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-row][data-file="liste.csv"]'));
    assert.equal(app.books().transactions.length, before);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
