/**
 * The period a page shows (F10, F17), in the real UI on a copy of the demo (filed through Q1 2026, its
 * newest payment on 30.09.2026): without a period in the link a page shows the newest data's quarter,
 * not the oldest unfiled one; one click on a quarter in the picker applies it, and the calendar's days
 * are there only after «Benutzerdefiniert»; MWST opens on the oldest return not filed
 * (#341), and a later one names it as a fact, a link to it; an invoice issued while another quarter is shown stays in the list, in its own period; a
 * receipt opened while it is still read follows into its period once its date is known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, clickText, noBrowser, openApp } from './support/e2e.js';
import { filingKeyOf, localToday } from '../src/accounting/periods.js';
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textPdf } from './support/text-pdf.js';
import { writeIndex } from './support/workspace.js';

/** A camt.053 of the demo's Raiffeisen account with one October payment. */
const OCTOBER = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>OCT-1</MsgId><CreDtTm>2026-10-31T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>OCT-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">48.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-14</Dt></BookgDt><AcctSvcrRef>REF-OCT-1</AcctSvcrRef><AddtlNtryInf>Kontofuehrung</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

/** The demo's draft for Muster Hotel GmbH; the next number is 2026-008. */
const DRAFT = 'in_8rkN6yKIRdjB';

test('pages open on the newest data, the picker applies a quarter in one click, an issued invoice stays in view', { skip: noBrowser, timeout: 180_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  const periodButton = () => page.$eval('[data-testid=period-picker]', (b) => (b as HTMLElement).innerText.trim());
  try {
    await app.open('/journal');
    assert.match(await periodButton(), /Q3 2026/, 'the newest payment is of Q3, Q2 is the oldest unfiled');

    await app.open('/invoices');
    await page.waitForFunction(() => /Q4 2026/.test(document.querySelector<HTMLElement>('[data-testid=period-picker]')?.innerText ?? ''));
    assert.ok(await page.$('.rows .row.inv[data-id="2026-007"]'), 'Rechnungen opens where its newest invoice is, 01.10.2026');

    await app.open('/journal');
    await click(page, '[data-testid=period-picker]');
    await page.waitForSelector('.pp');
    assert.equal(await page.$('.pp [data-day]'), null, 'no calendar days before «Benutzerdefiniert»');
    await clickText(page, 'Q2 2026', '.pp .pi');
    await page.waitForFunction(() => location.search === '?period=2026-Q2' && !document.querySelector('.pp'));
    assert.match(await periodButton(), /Q2 2026/, 'one click applied it');

    await click(page, '[data-testid=period-picker]');
    await clickText(page, 'Benutzerdefiniert', '.pp .pi');
    await page.waitForSelector('.pp [data-day]');
    await page.keyboard.press('Escape');

    // MWST alone opens where the return's work is (#341): the oldest return not filed, here Q2.
    await app.open('/vat');
    await page.waitForFunction(() => /Q2 2026/.test(document.querySelector<HTMLElement>('[data-testid=period-picker]')?.innerText ?? ''));
    assert.equal(await page.$('[data-testid=earlier-open]'), null, 'nothing earlier is open');
    // A later return still names the earlier one not filed as a fact, a link to it.
    await app.open('/vat?period=2026-Q3');
    const earlier = await page.waitForSelector('[data-testid=earlier-open]');
    assert.match(await earlier!.evaluate((b) => (b as HTMLElement).innerText), /^Q2 2026 nicht eingereicht · fällig/);
    await earlier!.evaluate((b) => (b as HTMLElement).click());
    await page.waitForFunction(() => /Q2 2026/.test(document.querySelector<HTMLElement>('[data-testid=period-picker]')?.innerText ?? ''));

    await app.open(`/invoices/draft-${DRAFT}?period=2026-Q2`);
    await click(page, '[data-act=issue]');
    await page.waitForFunction(() => location.pathname === '/invoices/2026-008');
    await page.waitForFunction(() => !!document.querySelector('.rows .row.inv[data-id="2026-008"]'));
    assert.match(await periodButton(), new RegExp(filingKeyOf(localToday(), 'quarter').replace(/(\d+)-(Q\d)/, '$2 $1')), 'the list shows the invoice in its own period');

    await app.open('/journal?period=2026-Q2');
    await page.evaluate((xml) => {
      const files = new DataTransfer();
      files.items.add(new File([xml], 'oktober.xml', { type: 'application/xml' }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: files, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    }, OCTOBER);
    await page.waitForSelector('[data-testid=drop-row][data-file="oktober.xml"]', { timeout: 60_000 });
    await page.waitForFunction(() => /Q4 2026/.test(document.querySelector<HTMLElement>('[data-testid=period-picker]')?.innerText ?? ''), { timeout: 30_000 });
    assert.ok(!new URL(page.url()).search.includes('2026-Q2'), 'the page behind the drop window moved to where the statement landed');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test('a receipt opened while it is still read follows into its period once its date is known', { skip: noBrowser, timeout: 180_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  try {
    const inbox = api.ws.paths.inbox;
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'spaet.pdf'), await textPdf(['Druckerei Muster AG', 'Rechnung D-17', 'Datum: 12.05.2026', 'Total CHF 86.40']));
    const waiting = (await api.send('GET', '/api/inbox')).json as unknown as Array<{ id: string; filename: string }>;
    const id = waiting.find((f) => f.filename === 'spaet.pdf')!.id;
    await app.open(`/receipts/${id}`);
    assert.match(await page.$eval('[data-testid=period-picker]', (b) => (b as HTMLElement).innerText), /Q3 2026/);

    // What reading it does: the receipt in the books with its date, the file out of the inbox.
    const archived = join(api.root, 'transactional-data/2026/receipts/spaet.pdf');
    renameSync(join(inbox, 'spaet.pdf'), archived);
    const books = app.books();
    books.receipts.push({
      id, filename: 'spaet.pdf', originalFilename: 'spaet.pdf', extractedText: 'Druckerei Muster AG', extractionMethod: 'pdftotext',
      fileSize: statSync(archived).size, indexedAt: new Date().toISOString(), location: 'archived', date: '2026-05-12', amount: 86.4, currency: 'CHF',
    });
    writeIndex(api.ws, books);

    await page.waitForFunction(() => location.search === '?period=2026-Q2', { timeout: 30_000 });
    assert.equal(new URL(page.url()).pathname, `/receipts/${id}`, 'the receipt stays selected');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
