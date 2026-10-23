/**
 * The agreed basis at the API (MWSTG Art. 40 Abs. 1): issuing an invoice books its VAT event on its
 * date against the receivable, cancelling it books the reversal, and the basis then holds for the
 * year (vatMethodHeld). The real server on a temp workspace whose manifest reports on the agreed
 * basis. Issuing needs Chromium.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from '../src/invoices/pdf.js';
import { loadBooks } from '../src/books/store.js';
import { appFolderIn, MANIFEST_FILE } from '../src/workspace/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

const skip = findBrowser() ? false : 'no Chromium-based browser installed (Chrome, Edge, Brave or Chromium; or set CHROME_PATH)';
let api: ApiServer;
before(async () => {
  const agreed = mkdtempSync(join(tmpdir(), 'belege-agreed-'));
  const manifest = readFileSync(join(appFolderIn(DEMO_ROOT) ?? DEMO_ROOT, MANIFEST_FILE), 'utf8');
  assert.match(manifest, /reporting: received/);
  writeFileSync(join(agreed, MANIFEST_FILE), manifest.replace('reporting: received', 'reporting: agreed'));
  api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: agreed });
});
after(() => api?.stop());

test('agreed basis: issuing books the invoice on its date against the receivable, cancelling reverses it, and the basis holds for the year', { skip }, async () => {
  const c = await api.send('POST', '/api/customers', { name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' });
  assert.equal(c.status, 200, String(c.json.error));
  const d = await api.send('POST', '/api/invoices', { customerId: c.json.id, date: '2026-08-20', lines: [{ text: 'Beratung', quantity: 1, unit: 'flat', price: 1000, vatRate: 8.1 }] });
  assert.equal(d.status, 200, String(d.json.error));
  const issued = await api.send('POST', `/api/invoices/${d.json.id}/issue`);
  assert.equal(issued.status, 200, String(issued.json.error));
  const rows = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]);
  assert.deepEqual(rows(`RE-${issued.json.number}`), [['2026-08-20', '1100', '3300', 1081, 'V81']]);
  assert.ok(loadBooks(api.ws).receipts.some((r) => r.kind === 'sales-record' && r.date === '2026-08-20'), 'the invoice PDF is the event\'s receipt');

  const back = await api.send('PATCH', '/api/workspace', { vat: { registered: true, method: 'effective', reporting: 'received', period: 'quarterly' } });
  assert.deepEqual([back.status, back.json.code], [400, 'vatMethodHeld'], 'the basis holds for the tax period (MWSTG Art. 39 Abs. 3)');

  const cancelled = await api.send('POST', `/api/invoices/${d.json.id}/cancel`, { date: '2026-09-02', reason: 'doppelt' });
  assert.equal(cancelled.status, 200, String(cancelled.json.error));
  assert.deepEqual(rows(`RE-${issued.json.number}-storno`), [['2026-09-02', '3300', '1100', 1081, '-V81']]);
});
