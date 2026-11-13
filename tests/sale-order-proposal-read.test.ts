/**
 * The orders a provider's order export says it did not collect, read as the sale question reads them
 * (#406): by the app file's columns and gateways, the persona's export of Shopify.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { readReport, collectedBy } from '../src/booking/sales-report.js';
import { parseProvider } from '../src/knowledge/provider.js';
import { orderProposal } from '../src/accounting/sales-without-vat.js';
import type { BankTransaction } from '../src/types/index.js';

const shopify = parseProvider(parse(readFileSync('processes/suppliers/shopify.yaml', 'utf8')).provider);

test('an order paid by bank deposit in an export of Shopify gives the transfer naming it its proposal', () => {
  assert.ok('provider' in shopify);
  const p = shopify.provider;
  const csv = [
    'Name,Paid at,Currency,Taxes,Total,Shipping Country,Payment Method,Refunded Amount,Outstanding Balance,Created at',
    '#1098,2026-07-19 10:00:00 +0200,CHF,3.67,49.00,CH,Shopify Payments,0.00,0.00,2026-07-19 10:00:00 +0200',
    '#1099,2026-07-20 09:00:00 +0200,CHF,12.36,165.00,CH,Bank Deposit,0.00,0.00,2026-07-17 16:20:05 +0200',
  ].join('\n');
  const read = readReport(csv, 'sales', p);
  assert.ok(!('missing' in read) && read.kind === 'sales');
  const elsewhere = read.rows.filter((o) => !collectedBy(o, p.gateways)).map((o) => ({ provider: 'Shopify', order: o.order, gross: o.gross, currency: o.currency, tax: o.tax, shipTo: o.shipTo }));
  assert.deepEqual(elsewhere.map((o) => o.order), ['1099']);
  const tx = { ref: 'T', bank: 'B', date: '2026-07-20', amount: 165, currency: 'CHF', direction: 'CRDT', description: 'Bestellung #1099', counterparty: 'Julia Studer' } as BankTransaction;
  assert.deepEqual(orderProposal(tx, elsewhere), { choice: 'saleDomestic', why: 'order', order: { provider: 'Shopify', name: '#1099', rate: 8.1 } });
});
