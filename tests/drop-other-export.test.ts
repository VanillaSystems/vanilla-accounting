/**
 * A provider's export the app books nothing from, dropped for a report (#406, webshop-ai-7): the
 * payouts list is named as what it is, with the reports the app books from and where the
 * provider's admin exports them (its app file's `otherExports` and `exportedAt`), and set aside;
 * never read as a bank statement of empty lines. A CSV that yields no movement by the columns its
 * header names is no statement either.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { parseProvider } from '../src/knowledge/provider.js';

// The payouts list of the webshop persona (Shopify › Finanzen › Auszahlungen), its first rows.
const PAYOUTS = [
  'Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency',
  '2026-07-01,paid,388.80,0.00,0.00,0.00,-12.18,0.00,376.62,CHF',
  '2026-07-03,paid,888.00,0.00,0.00,0.00,-28.44,0.00,859.56,CHF',
  '2026-07-06,paid,1153.10,0.00,0.00,0.00,-39.30,0.00,1113.80,CHF',
].join('\n');

test('a firm that has the provider: the payouts list is named, with its reports and the menu path its file verified; «trotzdem als Kontoauszug lesen» asks the columns (#406)', async () => {
  const api = await startApi('demo');
  try {
    // The firm's own knowledge names Shopify (a company file of it).
    mkdirSync(join(api.ws.paths.root, 'knowledge/suppliers'), { recursive: true });
    writeFileSync(join(api.ws.paths.root, 'knowledge/suppliers/shopify.yaml'), 'id: shopify\n');
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=payouts_export.csv`, Buffer.from(PAYOUTS));
    const [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.csv, row.read], ['statement-csv', 'duplicate', 'provider-export', undefined, undefined]);
    assert.deepEqual(row.otherExport, { provider: 'shopify', name: 'Shopify', what: 'payouts', reports: ['sales', 'fees'], where: { sales: 'Shopify Admin › Bestellungen › Exportieren' } });
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'take' });
    assert.deepEqual([s.rows[0].state, s.rows[0].reason, s.rows[0].otherExport, s.rows[0].read], ['asks', 'csv-columns', undefined, undefined], 'the way by hand: its columns asked, nothing chosen');
    await rest();
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a firm without the provider in its knowledge: the same file is a CSV whose columns are asked, nothing proposed (#406 review)', async () => {
  const api = await startApi('demo');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=payouts_export.csv`, Buffer.from(PAYOUTS));
    const [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.otherExport, row.read, row.csv?.columns], ['statement-csv', 'asks', 'csv-columns', undefined, undefined, undefined]);
    await rest();
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('S3: a CSV whose day and amount columns yield no movement (every amount zero) asks its columns with nothing chosen, never a table of empty lines', async () => {
  const api = await startApi('demo');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=liste.csv`, Buffer.from('Datum;Text;Betrag\n01.07.2026;Eins;0.00\n03.07.2026;Zwei;0.00'));
    assert.deepEqual([s.rows[0].state, s.rows[0].reason, s.rows[0].read, s.rows[0].csv?.columns], ['asks', 'csv-columns', undefined, undefined]);
    // A bank CSV with a movement is asked as before.
    s = await post(`/api/drop/${s.id}/files?name=bank.csv`, Buffer.from('Datum;Text;Betrag\n01.12.2026;Eins;-12.00\n03.12.2026;Zwei;0.00'));
    assert.deepEqual([s.rows[1].kind, s.rows[1].state], ['statement-csv', 'asks']);
    await rest();
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a provider file names its other exports by two headers or more, and where its reports are exported by report', () => {
  assert.deepEqual(parseProvider({ otherExports: { payouts: ['Payout Date', 'Total'] }, exportedAt: { sales: 'Admin › Orders › Export' } }), { provider: { reports: {}, otherExports: { payouts: ['Payout Date', 'Total'] }, exportedAt: { sales: 'Admin › Orders › Export' } } });
  assert.match((parseProvider({ otherExports: { orders: ['A', 'B'] } }) as { problem: string }).problem, /otherExports.orders is unknown/);
  assert.match((parseProvider({ otherExports: { payouts: ['Total'] } }) as { problem: string }).problem, /at least two headers/);
  assert.match((parseProvider({ exportedAt: { payouts: 'x' } }) as { problem: string }).problem, /exportedAt.payouts is unknown/);
});
