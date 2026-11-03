/**
 * F07: an account the books lack is added from the account field itself, but only one of the standard
 * chart, named with number and name before it is added («6600 Werbeaufwand anlegen»), through the
 * route Firma › Kontenplan adds accounts with. The real UI on the real API server on the demo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    await page.waitForSelector('.acl [data-act=account-add]');
    const offered = await page.$$eval('.acl [role=option]', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(offered, ['6600 Werbeaufwand anlegen'], 'named with number and name before it is added');
    await page.keyboard.type('xyz');
    await page.waitForFunction(() => document.querySelector('.acl li.none'));
    assert.equal(chart().some((a) => a.number === '6600'), false, 'listing adds nothing');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await page.waitForSelector('.acl [data-act=account-add]');
    // A real mouse click (down, up, click), as a person makes it: the field must not save the typed name before the account exists.
    await page.click('.acl [data-act=account-add]');
    for (let i = 0; i < 100 && (app.books().journalEntries ?? []).find((e) => e.id === ID)?.accountDebit !== '6600'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(chart().find((a) => a.number === '6600'), { number: '6600', name: 'Werbeaufwand' }, 'added to the chart under the standard chart\'s name');
    assert.equal((app.books().journalEntries ?? []).find((e) => e.id === ID)?.accountDebit, '6600', 'the entry is booked on it');
    assert.equal(await page.$eval(debit, (e) => (e as HTMLInputElement).value), '6600', 'the field holds it');
    assert.equal((await page.$eval('body', (e) => (e as HTMLElement).innerText)).includes('gibt es nicht'), false, 'no refusal of the typed text on the way');
    // A standard account typed and left without picking it: the form names the way to add it.
    await page.$eval(debit, (e) => (e as HTMLInputElement).focus());
    await page.$eval(debit, (e) => (e as HTMLInputElement).select());
    await page.keyboard.type('6400');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.body.innerText.includes('Konto 6400 ist noch nicht im Kontenplan: in der Liste «6400 Energie- und Entsorgungsaufwand anlegen» wählen'));
    assert.equal(chart().some((a) => a.number === '6400'), false, 'leaving the field adds nothing');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

const ORDERS = ['Name,Paid at,Currency,Taxes,Total,Shipping Country,Refunded Amount,Created at,Payment Method',
  '#2001,2026-10-02 10:00:00 +0200,CHF,8.10,108.10,CH,0.00,2026-10-02 09:00:00 +0200,Shopify Payments',
  '#2002,2026-10-10 10:00:00 +0200,CHF,4.05,54.05,CH,0.00,2026-10-10 09:00:00 +0200,Shopify Payments',
].join('\n');
const FEES = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
  '2026-10-02 14:22:10 +0200,charge,#2001,108.10,3.44,104.66,CHF',
].join('\n');

test('F08/F09: the drop row of a provider\'s report proposes «Durchlaufkonto Shopify» and the report\'s first day, names no file, and adds the account with the answer; the fee row then asks for the fees', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp();
  try {
    writeFileSync(join(app.api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  revenue: "3200"\n');
    const dir = mkdtempSync(join(tmpdir(), 'e2e-drop-'));
    const files = [join(dir, 'orders_export_1.csv'), join(dir, 'payment_transactions_export_1.csv')];
    writeFileSync(files[0], ORDERS);
    writeFileSync(files[1], FEES);
    const { page } = app;
    await app.open('/receipts');
    const c = await page.createCDPSession();
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await c.send('Input.dispatchDragEvent', { type, x: 700, y: 450, data });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=drop-provider]').length === 2, { timeout: 60_000 });
    const text = await page.$eval('.dropdlg', (e) => (e as HTMLElement).innerText);
    assert.equal(text.includes('knowledge/'), false, 'no file path in the question');
    const first = '[data-testid=drop-provider]';
    assert.equal(await page.$eval(`${first} input[name=account]`, (e) => (e as HTMLInputElement).value), '1093');
    assert.equal(await page.$eval(`${first} input[type=date]`, (e) => (e as HTMLInputElement).value), '2026-10-02', 'the report\'s first day');
    assert.match(await page.$eval(`${first} .acn`, (e) => (e as HTMLElement).innerText), /Durchlaufkonto Shopify · wird angelegt/);
    await page.screenshot({ path: join(dir, 'drop-proposed.png') });
    await page.$eval(`${first} button[type=submit]`, (e) => (e as HTMLElement).click());
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=drop-provider]').length === 1 && document.querySelector<HTMLInputElement>('[data-testid=drop-provider] input[name=account]')?.value === '6580', { timeout: 60_000 });
    const chart = JSON.parse(readFileSync(join(app.api.root, 'master-data', 'accounts.json'), 'utf8')) as Array<{ number: string; name: string }>;
    assert.equal(chart.find((a) => a.number === '1093')?.name, 'Durchlaufkonto Shopify');
    assert.equal(await page.$eval('[data-testid=drop-provider] input[aria-label=Steuercode]', (e) => (e as HTMLInputElement).value), 'I0');
    await page.screenshot({ path: join(dir, 'drop-fees.png') });
    console.log(`screenshots: ${dir}`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
