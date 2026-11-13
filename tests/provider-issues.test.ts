/**
 * #459: a month of a provider's fees without its bill names the bill as the provider's file names it
 * and where the provider keeps it, and shows the VAT the bill would show (estimated from the fees at the
 * bill's rate, said as an estimate), never the fees as the VAT. Invented shop and fees.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './support/jurisdiction.js';
import { importSalesReport } from '../src/intake/sales-report-import.js';
import { loadBooks, type Books } from '../src/books/store.js';
import { providerIssuesIn } from '../src/intake/pair-chain.js';
import { billText } from '../src/app/areas/automation/period-issues.js';
import { periodNote } from '../src/server/open-work.js';
import { wordsIn } from '../src/export/texts.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// The month's fees hold the bill's VAT: 269.23 at 8.1 % holds 20.17 (the persona's July, webshop-ai-r3-16).
const FEES = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-02 10:00:00 +0100,charge,#2001,5000.00,200.00,4800.00,CHF', '2026-11-10 10:00:00 +0100,charge,#2002,2000.00,69.23,1930.77,CHF'].join('\n');

function shop(fees = '{ account: "6840", vat: I0 }'): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'provider-issues-'));
  roots.push(dir);
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), `id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n  fees: ${fees}\n`);
  const accounts = join(dir, 'master-data', 'accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
  const ws = workspaceAt(dir);
  assert.ok(importSalesReport(ws, Buffer.from(FEES), 'payment_transactions_export.csv').ok);
  return ws;
}

const de = wordsIn('de').t as unknown as (key: string, vars?: Record<string, string | number>) => string;
const chf = (n: number) => `CHF ${n.toFixed(2)}`;

test('#459 a missing bill is named as the provider\'s file names it, where it is kept, with the VAT it would show as an estimate', () => {
  const ws = shop();
  const [bill] = providerIssuesIn(ws, loadBooks(ws), '2026-12-15').bills;
  assert.deepEqual(bill, {
    provider: 'shopify', name: 'Shopify', month: '2026-11', date: '2026-11-30', fees: 269.23,
    document: 'Shopify Payments Invoice', where: 'Shopify Admin › Einstellungen › Rechnungen', rate: 8.1, vat: 20.17,
  });
  const line = billText(bill, 'November 2026', chf, de);
  assert.equal(line, '«Shopify Payments Invoice» November 2026 von Shopify ist nicht in den Büchern: die MWST auf den Gebühren ist nicht abgezogen, geschätzt CHF 20.17 (8.1 % in CHF 269.23 Gebühren). Shopify stellt sie unter Shopify Admin › Einstellungen › Rechnungen bereit.');
  assert.doesNotMatch(line, /\(CHF 269\.23\) ist nicht abgezogen/, 'the fees are never said to be the VAT');
  // The AI is handed the same facts: the document, where it is, the estimate and the fees apart.
  const books = loadBooks(ws);
  // Q4 is the oldest period not filed once Q3 is.
  const note = periodNote(ws, { ...books, config: { ...books.config, closedThrough: '2026-09-30' } } as Books, [], 'de', '2026-12-15');
  assert.match(note, /- Shopify, 2026-11: «Shopify Payments Invoice», kept by Shopify under «Shopify Admin › Einstellungen › Rechnungen»; the VAT on that month's fees of CHF 269\.23 is about CHF 20\.17 \(estimated at 8\.1 %/);
});

test('#459 the estimate takes the rate of the bill\'s code the company\'s file names', () => {
  const ws = shop('{ account: "6840", vat: I0, billVat: M26-2 }');
  const [bill] = providerIssuesIn(ws, loadBooks(ws), '2026-12-15').bills;
  assert.deepEqual([bill.rate, bill.vat], [2.6, 6.82]);
});

test('#459 a bill its file does not name is said as a monthly bill, with the fees when no rate is known', () => {
  const bill = { provider: 'p', name: 'Pay AG', month: '2026-11', date: '2026-11-30', fees: 50 };
  assert.equal(billText(bill, 'November 2026', chf, de), 'Die Monatsrechnung November 2026 von Pay AG ist nicht in den Büchern: die MWST auf den Gebühren ist nicht abgezogen, Gebühren CHF 50.00');
});
