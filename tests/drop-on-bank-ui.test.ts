/**
 * Issue #361, in the real UI on a copy of the demo without an AI: a drop on Kontoauszüge goes
 * through the one drop door as a drop on Belege does. Each file gets its row with its true state,
 * the statement under «Kontoauszüge 1» with the drop's closing summary, the photo a row of its own
 * («noch nicht gelesen», never lost), and the same files reach the books. Before, a drop there read
 * the statement around the dialog and the photos vanished without a word. The movement is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { noBrowser, openApp } from './support/e2e.js';

/** A camt.053 of the demo's Raiffeisen account with one October payment. */
const OCTOBER = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>OCT-361</MsgId><CreDtTm>2026-10-31T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>OCT-361</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">48.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-14</Dt></BookgDt><AcctSvcrRef>REF-OCT-361</AcctSvcrRef><AddtlNtryInf>Kontofuehrung</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
// 2 x 2 pixels: a photo, no text of its own.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC';

/** Drops the statement and the photo on `path`; returns what the dialog says at its end and what the books hold. */
async function dropOn(path: string) {
  const app = await openApp();
  const { page } = app;
  try {
    // Dropped once, as soon as the page is there: a drop before the app's first status answer waits for it, never lost.
    await app.open(path, '#root > *');
    const fellThrough = await page.evaluate((xml, png) => {
      const files = new DataTransfer();
      files.items.add(new File([xml], 'oktober.xml', { type: 'application/xml' }));
      files.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'IMG_4590.png', { type: 'image/png' }));
      return dispatchEvent(new DragEvent('drop', { dataTransfer: files, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    }, OCTOBER, PNG);
    assert.equal(fellThrough, false, 'the drop never falls through to the browser');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=drop-row]').length === 2 && !!document.querySelector('[data-testid=drop-summary]'), { timeout: 120_000 });
    const seen = await page.evaluate(() => ({
      rows: [...document.querySelectorAll<HTMLElement>('[data-testid=drop-row]')].map((r) => `${r.dataset.file} ${r.dataset.state}`),
      tabs: [...document.querySelectorAll<HTMLElement>('.wftabs button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()),
      summary: document.querySelector<HTMLElement>('[data-testid=drop-summary]')!.innerText,
      openStatement: !!document.querySelector('[data-testid=drop-row][data-file="oktober.xml"] [data-testid=drop-open-file]'),
    }));
    // Closing the window by hand opens the statement the drop read in, on Kontoauszüge (as the add button does).
    await page.click('[data-testid=drop-close]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-dialog]'));
    await new Promise((r) => setTimeout(r, 500));
    const books = app.books();
    const photo = books.receipts.find((r) => r.originalFilename === 'IMG_4590.pdf');
    const inbox = readdirSync(app.api.ws.paths.inbox).filter((f) => f.startsWith('IMG_4590'));
    assert.deepEqual(app.errors, []);
    return { ...seen, at: new URL(page.url()).pathname, payment: books.transactions.some((t) => t.ref === 'REF-OCT-361'), photo: photo ? photo.location : inbox.join(',') || 'missing' };
  } finally {
    await app.stop();
  }
}

test('a statement and a photo dropped on Kontoauszüge each get their row, as on Belege, and reach the books the same way', { skip: noBrowser, timeout: 400_000 }, async () => {
  const bank = await dropOn('/bank?period=2026-Q4');
  assert.deepEqual(bank.rows, ['oktober.xml statement', 'IMG_4590.png unread'], 'the photo has its row, said not read: no AI on this Mac');
  assert.ok(bank.tabs.includes('Kontoauszüge 1'), bank.tabs.join(' / '));
  assert.match(bank.summary, /^1 Zahlung eingelesen, 14\.10\.2026 – 14\.10\.2026/);
  assert.match(bank.summary, /1 Beleg wartet aufs Lesen: Fotos und Scans liest nur eine KI, auf diesem Mac ist keine eingerichtet\./);
  assert.equal(bank.openStatement, true, 'the statement row opens its statement');
  assert.match(bank.at, /^\/bank\/files\/1021\/.+\.xml$/, 'closing on Kontoauszüge selects the statement just read');
  assert.equal(bank.payment, true);
  assert.notEqual(bank.photo, 'missing', 'the photo is in the books or the inbox');

  const receipts = await dropOn('/receipts?period=2026-Q4');
  assert.deepEqual({ ...receipts, at: '' }, { ...bank, at: '' }, 'the same rows, counts and files as the drop on Belege');
  assert.match(receipts.at, /^\/receipts/, 'closing elsewhere leaves the page where it is');
});
