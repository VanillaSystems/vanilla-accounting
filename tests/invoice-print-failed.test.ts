/**
 * Issuing prints the invoice's PDF. When the browser that prints it is there but fails (it will not start, or ends
 * mid-print), the refusal names it in plain words (`invoiceRefusal: 'printFailed'`, the UI's
 * invoice.refusal.printFailed) instead of a bare 500 with the browser's own error, and the invoice stays a draft.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
// A program that exists and exits at once: found as the browser, never prints.
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json', { CHROME_PATH: '/usr/bin/false' }); });
after(() => api?.stop());

test('a browser that fails to print: issue is refused as printFailed, nothing issued', async () => {
  const c = await api.send('POST', '/api/customers', { name: 'Muster Druck AG', address: { street: 'Hauptstrasse', number: '1', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' });
  assert.equal(c.status, 200, String(c.json.error));
  const d = await api.send('POST', '/api/invoices', { customerId: c.json.id, lines: [{ text: 'Beratung', quantity: 2, unit: 'h', price: 160, vatRate: 8.1 }] });
  assert.equal(d.status, 200, String(d.json.error));

  const issued = await api.send('POST', `/api/invoices/${d.json.id}/issue`);
  assert.deepEqual([issued.status, issued.json.invoiceRefusal], [503, 'printFailed'], String(issued.json.error));
  assert.match(String(issued.json.error), /PDF liess sich nicht drucken/);

  const after = await api.send('GET', `/api/invoices/${d.json.id}`);
  assert.deepEqual([after.json.status, after.json.number], ['draft', undefined], 'no number taken, no PDF stored');
});
