/**
 * End to end: a receipt of the open quarter without its payment is linked in the link dialog, which books the payment
 * with it; «Lösen» in the Zahlung section takes the link back and the booking with it. The real UI on the real API on
 * a copy of the demo, the stub model booking what a model would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { click, noBrowser, openApp } from './support/e2e.js';
import { writeIndex } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
/** The demo's Swiss Post receipt (8.1 % Swiss VAT) and its payment of 20.04.2026, CHF 116.40. */
const RECEIPT = '8055b79c27150473';
const PAYMENT = '90000000025';

test('a receipt is linked to its payment in the dialog and booked with it; «Lösen» undoes both', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await openApp('demo/vanilla-accounting', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_BIN: '', CODEX_BIN: '' });
  const { page, api } = app;
  const linked = () => app.books().mappings.some((m) => m.receiptId === RECEIPT && m.transactionRef === PAYMENT);
  const booking = () => (app.books().journalEntries ?? []).filter((e) => e.transactionRef === PAYMENT);
  try {
    // The payment as an inbox run booked it (the demo's bookings carry no origin, a person's, which a link never replaces);
    // unlinked, the booking that claimed the receipt's tax goes and the payment waits for a receipt.
    const books = app.books();
    Object.assign(books.journalEntries!.find((e) => e.transactionRef === PAYMENT)!, { origin: 'classify', receipts: [RECEIPT] });
    writeIndex(api.ws, books);
    assert.equal((await api.send('POST', '/api/mapping/remove', { receiptId: RECEIPT, transactionRef: PAYMENT })).status, 200);
    await api.rest();
    assert.equal(linked(), false);
    assert.deepEqual(booking(), [], 'without its receipt the payment waits unbooked');

    await app.open(`/receipts/${RECEIPT}?period=2026-Q2`);
    await click(page, '.addlink');
    await page.waitForSelector(`.linkdlg .o[data-ref="${PAYMENT}"]`);
    assert.equal(await page.$eval('.linkdlg .o[data-ref]', (e) => e.getAttribute('data-ref')), PAYMENT, 'the dialog ranks the payment first');
    await click(page, `.linkdlg .o[data-ref="${PAYMENT}"]`);
    await page.waitForSelector('[data-testid=go-payment]');
    await api.rest();

    assert.equal(linked(), true, 'the books hold the link');
    const [entry, ...more] = booking();
    assert.deepEqual(more, []);
    assert.equal(entry.amount, 116.4);
    assert.equal(entry.accountCredit, '1021');
    assert.equal(entry.vatCode, 'I81', 'booked with the input tax the receipt shows');
    assert.deepEqual(entry.receipts, [RECEIPT]);

    await click(page, '.tx .un');
    await page.waitForSelector('[data-testid=go-payment]', { hidden: true });
    await api.rest();
    assert.equal(linked(), false, '«Lösen» took the link back');
    assert.deepEqual(booking(), [], 'and the booking that claimed the receipt\'s tax');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
