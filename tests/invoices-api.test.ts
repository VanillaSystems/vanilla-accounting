/**
 * The invoicing routes (src/server/routes/invoices.ts) on the real API server and a temp
 * workspace with the demo's invoicing settings: customers, drafts, issue, the stored PDF, frozen
 * issued invoices, send, comment, reminder draft, cancel, preview. Issuing needs Chromium.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowser } from '../src/invoices/pdf.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

const skip = findBrowser() ? false : 'no Chromium-based browser installed (Chrome, Edge, Brave or Chromium; or set CHROME_PATH)';
let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  mkdirSync(join(api.root, 'logos'));
  copyFileSync(join(DEMO_ROOT, 'logos/logo.svg'), join(api.root, 'logos/logo.svg'));
});
after(() => api?.stop());

const customer = { name: 'Café Exemple Sàrl', address: { street: 'Rue du Marché', number: '12', postcode: '1204', town: 'Genève', country: 'CH' }, language: 'fr', email: 'compta@cafe.example' };
const lines = [{ text: 'Mélange maison 1 kg', quantity: 15, unit: 'pcs', price: 29, vatRate: 2.6 }];

test('customers: created with the workspace terms; an address without town is refused', async () => {
  const { status, json } = await api.send('POST', '/api/customers', customer);
  assert.equal(status, 200, String(json.error));
  assert.equal(json.paymentTermsDays, 30);
  assert.match(String(json.id), /^cu_/);
  const bad = await api.send('POST', '/api/customers', { ...customer, address: { postcode: '1204', country: 'CH' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.invoiceRefusal, 'incomplete');
  assert.deepEqual(bad.json.missing, [{ field: 'customer.address' }], 'the UI names what is missing, never «address braucht postcode»');
  // A Swiss UID has a check digit (r8c-18): 333 is wrong, 338 right; a foreign VAT number is any text.
  const wrongUid = await api.send('POST', '/api/customers', { ...customer, vatId: 'CHE-111.222.333 MWST' });
  assert.equal(wrongUid.status, 400);
  assert.equal(wrongUid.json.invoiceRefusal, 'uid');
  const rightUid = await api.send('POST', '/api/customers', { ...customer, name: 'Muster UID AG', vatId: 'CHE-111.222.338 MWST' });
  assert.equal(rightUid.status, 200, String(rightUid.json.error));
  assert.equal(rightUid.json.vatId, 'CHE-111.222.338 MWST');
  const foreign = await api.send('POST', '/api/customers', { ...customer, name: 'Muster DE GmbH', vatId: 'DE999999999' });
  assert.equal(foreign.status, 200, String(foreign.json.error));
});

test('drafts: created in the customer language, changed, deleted; a draft has no number', async () => {
  const c = (await api.send('GET', '/api/customers')).json as unknown as Array<{ id: string }>;
  const { json: d } = await api.send('POST', '/api/invoices', { customerId: c[0].id, lines });
  assert.deepEqual([d.status, d.language, d.number], ['draft', 'fr', undefined]);
  const patched = await api.send('PATCH', `/api/invoices/${d.id}`, { subject: 'Café', dueDate: '2026-12-01' });
  assert.equal(patched.json.subject, 'Café');
  const detail = await api.send('GET', `/api/invoices/${d.id}`);
  assert.deepEqual(detail.json.missing, [], 'the demo settings and this customer make a complete invoice');
  assert.deepEqual((detail.json.view as { totals: { gross: number } }).totals.gross, 446.31);
  const other = await api.send('POST', '/api/invoices', { customerId: c[0].id, lines });
  assert.equal((await api.send('DELETE', `/api/invoices/${other.json.id}`)).status, 200);
  const list = (await api.send('GET', '/api/invoices')).json.invoices as Array<{ id: string }>;
  assert.deepEqual(list.map((i) => i.id), [d.id], 'a deleted draft is gone from the list');
  assert.equal((await api.send('PATCH', `/api/invoices/${d.id}`, { lines: [{ text: 'x', quantity: 1, price: 1, vatRate: 7.7 }] })).status, 400);
});

test('issue, the PDF as issued, frozen, sent, commented, reminded, cancelled', { skip }, async () => {
  const [d] = (await api.send('GET', '/api/invoices')).json.invoices as Array<{ id: string }>;
  const issued = await api.send('POST', `/api/invoices/${d.id}/issue`);
  assert.equal(issued.status, 200, String(issued.json.error));
  assert.deepEqual([issued.json.number, issued.json.dueDate], ['2026-001', '2026-12-01']);
  const pdf = (issued.json as { pdf: { file: string; sha256: string } }).pdf;

  const res = await api.fetch('/invoices/2026-001.pdf');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pdf.sha256);
  assert.ok(bytes.equals(readFileSync(join(api.root, pdf.file))), 'the stored bytes, not a new print');

  const frozen = await api.send('PATCH', `/api/invoices/${d.id}`, { subject: 'neu' });
  assert.deepEqual([frozen.status, frozen.json.invoiceRefusal], [409, 'notDraft']);
  assert.equal((await api.send('DELETE', `/api/invoices/${d.id}`)).json.invoiceRefusal, 'notDraft', 'issued is cancelled, never deleted');

  const sent = await api.send('POST', `/api/invoices/${d.id}/send`, {});
  assert.deepEqual([sent.json.kind, sent.json.to, sent.json.title], ['invoice', 'compta@cafe.example', 'Facture 2026-001']);
  const note = await api.send('POST', `/api/invoices/${d.id}/comments`, { text: 'paie fin octobre' });
  assert.equal(note.json.author, 'Anna Muster');
  const reminder = await api.send('GET', `/api/invoices/${d.id}/reminder?date=2026-12-10`);
  assert.deepEqual([reminder.json.level, reminder.json.dueDate], [1, '2026-12-20']);
  assert.match(String(reminder.json.intro), /^Notre facture 2026-001/);

  const preview = await api.fetch(`/api/invoices/${d.id}/preview`);
  assert.match(await preview.text(), /<div class="a4 [^"]*has-qr/);

  const cancelled = await api.send('POST', `/api/invoices/${d.id}/cancel`, { date: '2026-12-01', reason: 'Fehler' });
  assert.deepEqual((cancelled.json.invoice as { cancelled: unknown }).cancelled, { date: '2026-12-01', reason: 'Fehler' });
  assert.equal((await api.send('POST', `/api/invoices/${d.id}/credit-note`, { reason: 'x' })).json.invoiceRefusal, 'cancelled');
  const view = (await api.send('GET', `/api/invoices/${d.id}`)).json.view as { status: string; open: number };
  assert.deepEqual([view.status, view.open], ['cancelled', 0]);
});

test('payments without a reference: the proposals list answers', async () => {
  const { status, json } = await api.send('GET', '/api/invoices/payments');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.proposals));
});
