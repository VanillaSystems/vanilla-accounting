/**
 * End to end: invoicing through the real UI on a copy of the demo. A draft is issued (its PDF printed, stored with its
 * SHA-256 and served under the invoice's link) and recorded as sent; a part of it is credited and the credit note
 * issued (its price corrected by typing); an incoming payment an open invoice proposes is confirmed, which books its revenue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { click, clickText, noBrowser, openApp, waitText } from './support/e2e.js';
import { writeIndex } from './support/workspace.js';

/** The demo's draft for Muster Hotel GmbH; the next number is 2026-008. */
const DRAFT = 'in_8rkN6yKIRdjB';
/** The demo's overdue invoice 2026-003 of Beispiel Bistro AG, nothing paid. */
const OPEN = 'in_glJAMD-ee_Jz';

interface InvoiceView { id: string; number?: string; kind: string; status: string; pdf?: { file: string; sha256: string }; payments: Array<{ transactionRef: string; amount: number }>; sent?: Array<{ channel: string }>; view: { open: number; totals: { gross: number } } }

test('a draft is issued with its stored PDF and sent; a part is credited; a proposed payment is confirmed and booked', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  const invoice = async (id: string) => (await api.send('GET', `/api/invoices/${id}`)).json as unknown as InvoiceView;
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    await app.open(`/invoices/draft-${DRAFT}?period=2026`);
    await click(page, '[data-act=issue]');
    await waitText(page, 'Rechnung 2026-008 ausgestellt');
    await page.waitForFunction(() => location.pathname === '/invoices/2026-008');
    const issued = await invoice(DRAFT);
    assert.equal(issued.status, 'issued');
    assert.equal(issued.number, '2026-008');
    assert.equal(issued.pdf?.file, 'transactional-data/2026/invoices/2026-008.pdf');
    const stored = readFileSync(join(api.root, issued.pdf!.file));
    assert.equal(stored.subarray(0, 5).toString(), '%PDF-');
    assert.equal(sha(stored), issued.pdf!.sha256, 'the stored PDF is the one its SHA-256 names');
    const href = await page.$eval('.detail a.dl', (a) => a.getAttribute('href')!);
    const served = Buffer.from(await (await fetch(app.ui + href)).arrayBuffer());
    assert.equal(sha(served), issued.pdf!.sha256, 'the download link serves the stored PDF');

    await click(page, '[data-act=send]');
    await click(page, '.isend [data-act=download]');
    await waitText(page, 'Rechnung 2026-008 als gesendet erfasst');
    assert.deepEqual((await invoice(DRAFT)).sent?.map((s) => s.channel), ['download']);

    await click(page, '[data-act=credit]');
    await clickText(page, 'Teilbetrag', '.icredit button[role=radio]');
    await page.type('.icredit input.mono', '50');
    await page.type('.icredit input:not(.mono)', 'Rabatt');
    await click(page, '[data-act=credit-ok]');
    await page.waitForFunction(() => /^\/invoices\/draft-/.test(location.pathname));
    const creditDraft = async () => (await (await api.send('GET', '/api/invoices')).json.invoices as InvoiceView[]).find((i) => i.kind === 'credit-note' && i.status === 'draft')!;
    assert.equal((await creditDraft()).view.totals.gross, -50, 'the part credited is the amount asked, VAT included (F04)');
    // Typed at once after the click: the select-all the click schedules must not eat the minus.
    await page.click('[data-ed="l:0:price"]');
    await page.keyboard.type('-40');
    await page.keyboard.press('Tab');
    for (let k = 0; k < 50 && (await creditDraft()).view.totals.gross === -50; k++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await creditDraft()).view.totals.gross, -40, 'the corrected price keeps its minus and its VAT included');
    await click(page, '[data-act=issue]');
    await waitText(page, 'Gutschrift 2026-009 ausgestellt');
    const credit = (await (await api.send('GET', '/api/invoices')).json.invoices as InvoiceView[]).find((i) => i.number === '2026-009')!;
    assert.equal(credit.kind, 'credit-note');
    assert.equal(credit.status, 'issued');
    assert.match(readFileSync(join(api.root, credit.pdf!.file)).subarray(0, 5).toString(), /%PDF-/);
    assert.equal((await invoice(DRAFT)).view.open, Math.round((issued.view.totals.gross - 40) * 100) / 100, 'the credit note lowers what is open');

    // A payment of 2026-003's open amount from its customer, without a reference: the invoice proposes it.
    const due = (await invoice(OPEN)).view.open;
    const books = app.books();
    books.transactions.push({ ref: 'E2E-PAY-1', bank: 'Raiffeisen', date: '2026-10-20', amount: due, currency: 'CHF', direction: 'CRDT', description: 'Zahlung Beispiel Bistro AG', counterparty: 'Beispiel Bistro AG' });
    writeIndex(api.ws, books);
    await app.open('/invoices/2026-003?period=2026');
    await clickText(page, 'Zahlung bestätigen');
    await page.waitForSelector('[data-testid=linked-payment]');
    assert.deepEqual((await invoice(OPEN)).payments.map((p) => [p.transactionRef, p.amount]), [['E2E-PAY-1', due]]);
    const revenue = app.books().journalEntries!.filter((e) => e.transactionRef === 'E2E-PAY-1');
    assert.ok(revenue.length > 0, 'the confirmed payment is booked');
    assert.equal(Math.round(revenue.reduce((s, e) => s + e.amount, 0) * 100) / 100, due, 'for the whole amount');
    assert.ok(revenue.every((e) => e.accountDebit === '1021' && /^V/.test(e.vatCode ?? '')), `on the bank against revenue with a sale code: ${JSON.stringify(revenue)}`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
