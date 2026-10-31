/**
 * End to end: the open quarter's VAT return from «Abrechnung erstellen» on the MWST page to the seal. The review task
 * «Freigegeben» writes the eCH-0217 XML, «Eingereicht» and «Ja, eingereicht» move closedThrough to the quarter's end and
 * write its seal, and from then on the API refuses to change an entry of the quarter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { click, clickText, noBrowser, openApp, waitText } from './support/e2e.js';
import { yearPaths } from '../src/workspace/workspace.js';

test('MWST «Abrechnung erstellen» → «Freigegeben» → XML → «Eingereicht» seals the quarter', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  const filings = yearPaths(api.ws.paths, '2026').filings;
  const ledger = () => JSON.parse(readFileSync(api.ws.paths.ledger, 'utf8')) as { config: { closedThrough: string } };
  try {
    assert.equal(ledger().config.closedThrough, '2026-03-31');
    const q2Entry = app.books().journalEntries!.find((e) => e.date >= '2026-04-01' && e.date <= '2026-06-30')!;

    await app.open('/vat?period=2026-Q2');
    const payable = await page.$eval('.vresult', (e) => (e as HTMLElement).innerText);
    await clickText(page, 'Abrechnung erstellen');
    await page.waitForFunction(() => location.pathname.startsWith('/automation/tasks') || document.querySelector('.toast'));
    await api.rest();

    await app.open('/automation/tasks');
    await page.waitForSelector('[data-testid=return-facts]');
    const proposal = await page.$eval('[data-testid=return-facts]', (e) => (e as HTMLElement).innerText);
    const amount = payable.match(/[\d']+\.\d\d/)![0];
    assert.ok(proposal.includes(amount), `the task proposes the return the MWST page shows (${amount}): ${proposal}`);
    await clickText(page, 'Freigegeben');
    await page.waitForSelector('[data-testid=xml-file]');
    await api.rest();

    assert.equal((await api.send('PATCH', `/api/journal-entries/${q2Entry.id}`, { description: 'nach der Freigabe' })).status, 403, 'an approved quarter takes no change');
    const xml = await api.fetch('/api/filing/2026-Q2');
    assert.equal(xml.status, 200);
    const body = await xml.text();
    assert.match(body, /eCH-0217/);
    assert.match(body, /2026-04-01/);
    assert.match(body, /2026-06-30/);

    await clickText(page, 'Eingereicht');
    await click(page, '[data-testid=confirm-filed] .btn:not(.ghost)');
    await page.waitForFunction(() => !document.querySelector('[data-testid=xml-file]'));
    await api.rest();

    assert.equal(ledger().config.closedThrough, '2026-06-30', 'closedThrough moved to the quarter\'s end');
    assert.ok(existsSync(join(filings, 'seal-Q2.json')), 'the seal is written');
    assert.equal(readFileSync(join(filings, 'mwst-ech0217-2026-Q2.xml'), 'utf8'), body, 'the filed XML is archived as it was offered');
    const refused = await api.send('PATCH', `/api/journal-entries/${q2Entry.id}`, { description: 'nach der Einreichung' });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, 'periodClosed');

    await app.open('/vat?period=2026-Q2');
    await waitText(page, 'eingereicht');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
