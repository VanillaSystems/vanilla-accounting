/**
 * The browser that prints PDFs may end on its own (an installed Google Chrome was seen ending 12 to 31 s after its start):
 * the next PDF starts another instead of failing with «Connection closed» until the server restarts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser, printPdf, startedBrowser } from '../src/invoices/pdf.js';
import { browserPath } from './support/browser.js';

const skip = browserPath ? false : 'no Chromium-based browser installed (Chrome, Edge, Brave or Chromium; or set CHROME_PATH)';
after(() => closeBrowser());

const html = '<!doctype html><html><body><p>Seite</p></body></html>';
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

async function killStartedBrowser(waitForDisconnect: boolean): Promise<void> {
  const browser = await startedBrowser();
  assert.ok(browser, 'a browser was started by the first PDF');
  const gone = new Promise((ok) => browser.once('disconnected', ok));
  assert.ok(browser.process()?.kill('SIGKILL'), 'the started browser process was killed by its handle');
  if (waitForDisconnect) await gone;
}

test('a PDF after the browser ended (its disconnect seen) starts another browser', { skip, timeout: 120_000 }, async () => {
  assert.ok(isPdf(await printPdf(html, '2026-10-31T10:00:00')));
  const first = await startedBrowser();
  await killStartedBrowser(true);
  assert.ok(isPdf(await printPdf(html, '2026-10-31T10:00:00')), 'the second PDF printed');
  assert.notEqual(await startedBrowser(), first, 'a new browser prints');
});

test('a PDF right after the browser was killed, before its disconnect is seen, still prints', { skip, timeout: 120_000 }, async () => {
  assert.ok(isPdf(await printPdf(html, '2026-10-31T10:00:00')));
  await killStartedBrowser(false);
  assert.ok(isPdf(await printPdf(html, '2026-10-31T10:00:00')), 'the PDF printed');
});
