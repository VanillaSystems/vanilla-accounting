/**
 * End to end: Ausziffern opened where the money is seen (spec 4.4.6, 4.8). On the bank's page of an incoming payment no
 * document holds, «Ausziffern» opens the dialog with the contact code proposes by name and the open Rechnungen; the
 * person can switch to all contacts and back. From a contact, «Zahlung ausziffern» picks the payment first. Each «Buchen»
 * allocates the payment to the invoices and books it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, noBrowser, openApp, waitText, type App } from './support/e2e.js';
import { writeIndex } from './support/workspace.js';

interface View { id: string; status: string; kind: string; customerId: string; currency: string; cancelled?: unknown; number?: string; payments: Array<{ transactionRef: string; amount: number }>; view: { open: number } }

const BISTRO = 'Beispiel Bistro AG';

/** The bistro's contact id, its open CHF invoices and what they owe together. */
async function bistro(app: App) {
  const list = (await app.api.send('GET', '/api/invoices')).json as { invoices: View[]; contacts: Array<{ id: string; name: string }> };
  const id = list.contacts.find((c) => c.name === BISTRO)!.id;
  const open = list.invoices.filter((i) => i.customerId === id && i.status === 'issued' && i.kind === 'invoice' && !i.cancelled && i.currency === 'CHF' && i.view.open > 0);
  assert.ok(open.length > 0, 'the demo\'s bistro owes something');
  return { id, open, owed: Math.round(open.reduce((s, i) => s + i.view.open, 0) * 100) / 100 };
}

/** An incoming payment of `amount` on the CHF bank in September, naming the bistro but no invoice. */
function pay(app: App, ref: string, amount: number) {
  const books = app.books();
  books.transactions.push({ ref, bank: 'Raiffeisen', date: '2026-09-20', amount, currency: 'CHF', direction: 'CRDT', description: 'Zahlung offene Posten', counterparty: BISTRO });
  writeIndex(app.api.ws, books);
}

async function paidBy(app: App, ref: string) {
  const list = (await app.api.send('GET', '/api/invoices')).json as { invoices: View[] };
  return list.invoices.flatMap((i) => (i.payments ?? []).filter((p) => p.transactionRef === ref).map((p) => [i.number, p.amount]));
}

test('the bank\'s payment page: «Ausziffern» proposes the contact by name, the person may pick all, «Buchen» allocates and books', { skip: noBrowser, timeout: 180_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  try {
    const b = await bistro(app);
    pay(app, 'E2E-ALLOC-1', b.owed);
    await app.open(`/bank/1021-2026-09/E2E-ALLOC-1?period=2026-Q3`, '[data-testid=link-invoice]');
    await click(page, '[data-testid=link-invoice] [data-act=allocate]');
    await page.waitForSelector('[data-testid=alloc-contact]');
    assert.equal(await page.$eval('[data-testid=alloc-contact]', (e) => (e as HTMLSelectElement).value), b.id, 'code proposes the bistro');
    assert.match(await page.$eval('[data-testid=alloc-by]', (e) => e.textContent ?? ''), /nennt den Namen/);
    const rows = async () => page.$$eval('table.alloc tbody tr', (r) => r.length);
    assert.equal(await rows(), b.open.length, 'the bistro\'s open Rechnungen');
    await page.select('[data-testid=alloc-contact]', '');
    await page.waitForFunction((n) => document.querySelectorAll('table.alloc tbody tr').length > n, {}, b.open.length);
    await page.select('[data-testid=alloc-contact]', b.id);
    await page.waitForFunction((n) => document.querySelectorAll('table.alloc tbody tr').length === n, {}, b.open.length);
    await waitText(page, 'Übrig: CHF 0.00');
    await click(page, '[data-act=alloc-ok]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=alloc-contact]'));
    for (let k = 0; k < 50 && !(await paidBy(app, 'E2E-ALLOC-1')).length; k++) await new Promise((r) => setTimeout(r, 100));
    const got = (await paidBy(app, 'E2E-ALLOC-1')).reduce((s, [, a]) => s + Number(a), 0);
    assert.equal(Math.round(got * 100) / 100, b.owed, 'the payment went over the bistro\'s open Rechnungen');
    assert.ok(app.books().journalEntries!.some((e) => e.transactionRef === 'E2E-ALLOC-1'), 'the payment is booked');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test('a contact\'s «Zahlung ausziffern»: the payment is picked first, then its open Rechnungen', { skip: noBrowser, timeout: 180_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  try {
    const b = await bistro(app);
    pay(app, 'E2E-ALLOC-2', b.owed);
    await app.open(`/invoices/contacts/${b.id}?period=2026`, '[data-act=allocate-contact]');
    await click(page, '[data-act=allocate-contact]');
    await page.waitForSelector('[data-testid=alloc-pick]');
    await page.select('[data-testid=alloc-pick]', 'E2E-ALLOC-2');
    await click(page, '[data-act=alloc-next]');
    await page.waitForSelector('[data-testid=alloc-contact]');
    assert.equal(await page.$eval('[data-testid=alloc-contact]', (e) => (e as HTMLSelectElement).value), b.id, 'the contact it was opened from');
    assert.equal(await page.$$eval('[data-testid=alloc-by]', (e) => e.length), 0, 'given, not proposed');
    await waitText(page, 'Übrig: CHF 0.00');
    await click(page, '[data-act=alloc-ok]');
    for (let k = 0; k < 50 && !(await paidBy(app, 'E2E-ALLOC-2')).length; k++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await paidBy(app, 'E2E-ALLOC-2')).length, b.open.length, 'every open Rechnung of the contact got its part');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
