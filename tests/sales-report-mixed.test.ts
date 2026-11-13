/**
 * #416: an order of a provider's order export whose one tax column shows two VAT rates (tea at 2.6 %,
 * a teapot at 8.1 %) is booked by code from its line items, a line per rate, when exactly one way of
 * putting the items at the rates fits: the items add up to what was charged, no shipping, no discount,
 * nothing refunded. Every other such order waits for «Aufteilen». Invented shop and orders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookHeldOrder, importSalesReport, removeSalesReport } from '../src/intake/sales-report-import.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

function shop(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'mixed-cart-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
  const accounts = join(dir, 'master-data', 'accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
  return workspaceAt(dir);
}

/** Shopify's order export as it writes it, with its line items and the tax per rate. */
const FULL = 'Name,Email,Financial Status,Paid at,Fulfillment Status,Fulfilled at,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Shipping Method,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Lineitem taxable,Billing Name,Billing City,Billing Zip,Billing Country,Shipping Name,Shipping City,Shipping Zip,Shipping Country,Cancelled at,Payment Method,Refunded Amount,Outstanding Balance,Id,Tax 1 Name,Tax 1 Value,Tax 2 Name,Tax 2 Value,Source';
interface First { order: string; day: string; subtotal: string; shipping: string; taxes: string; total: string; qty: string; price: string; tax1: string; tax2?: string; discount?: string; refunded?: string }
const first = (o: First) =>
  `#${o.order},k@example.ch,paid,${o.day} 21:03:57 +0100,fulfilled,,CHF,${o.subtotal},${o.shipping},${o.taxes},${o.total},,${o.discount ?? '0.00'},PostPac Priority,${o.day} 21:03:57 +0100,${o.qty},Kanne,${o.price},,true,K,Chur,7000,CH,K,Chur,7000,CH,,Shopify Payments,${o.refunded ?? '0.00'},0.00,58${o.order},${o.tax1},${o.tax2 ?? ','},web`;
const more = (order: string, day: string, qty: string, price: string) => `#${order},k@example.ch,,,,,,,,,,,,,${day} 21:03:57 +0100,${qty},Tee,${price},,true,,,,,,,,,,,,,,,,,,`;

/** A teapot at 68.00 (8.1 %) and two teas at 16.50 (2.6 %): 101.00, tax 5.10 and 0.84. */
const CART: First = { order: '2101', day: '2026-11-12', subtotal: '101.00', shipping: '0.00', taxes: '5.94', total: '101.00', qty: '1', price: '68.00', tax1: 'CH MWST 8.1%,5.10', tax2: 'CH MWST 2.6%,0.84' };
const cart = (change: Partial<First> = {}) => [FULL, first({ ...CART, ...change }), more('2101', '2026-11-12', '2', '16.50')].join('\n');
const lines = (ws: Workspace, ref = 'SR-shopify-2101') => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.origin]).sort((a, b) => Number(b[3]) - Number(a[3]));
const heldOf = (ws: Workspace) => loadBooks(ws).receipts.filter((r) => r.report?.kind === 'sales').flatMap((r) => r.report!.held ?? []).map((h) => [h.order, h.why]);

test('#416 a cart of two rates is booked by its line items, a line per rate at its sale code, under the order\'s sale ref; the drop row and the entries say it was split by its items', () => {
  const ws = shop();
  const done = importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv');
  assert.ok(done.ok);
  assert.deepEqual(lines(ws), [
    ['2026-11-12', '1093', '3200', 68, 'V81', 'classify'],
    ['2026-11-12', '1093', '3200', 33, 'V26', 'classify'],
  ]);
  assert.deepEqual(heldOf(ws), []);
  assert.equal(done.summary.orders, 1);
  assert.deepEqual(done.summary.split, ['2101'], 'the drop row names the order split by its items');
  for (const e of loadBooks(ws).journalEntries.filter((x) => x.transactionRef === 'SR-shopify-2101')) assert.match(e.reason ?? '', /Positionen/, 'the entry\'s reason says it was split by its items');
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  assert.ok(loadBooks(ws).mappings.some((m) => m.transactionRef === 'SR-shopify-2101' && m.receiptId === id), 'linked to its report as every sale');
  const again = importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv');
  assert.ok(again.ok);
  assert.equal(lines(ws).length, 2, 'dropped again: nothing twice');
  assert.deepEqual(again.summary.split, []);
});

test('#416 rounding: a rate\'s tax a Rappen off its items still fits; items a Rappen off what was charged do not', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(cart({ taxes: '5.93', tax1: 'CH MWST 8.1%,5.09' })), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws).map((l) => [l[3], l[4]]), [[68, 'V81'], [33, 'V26']]);
  const off = shop();
  assert.ok(importSalesReport(off, Buffer.from(cart({ total: '101.01', subtotal: '101.01' })), 'orders_export.csv').ok);
  assert.deepEqual(lines(off), []);
  assert.deepEqual(heldOf(off), [['2101', 'rate']]);
});

test('#416 two ways of putting the items at the rates both fit: held for «Aufteilen», never guessed', () => {
  const ws = shop();
  // 10.00 and 10.01: each at 8.1 % carries 0.75, each at 2.6 % 0.25.
  const csv = [FULL, first({ order: '2104', day: '2026-11-12', subtotal: '20.01', shipping: '0.00', taxes: '1.00', total: '20.01', qty: '1', price: '10.00', tax1: 'CH MWST 8.1%,0.75', tax2: 'CH MWST 2.6%,0.25' }), more('2104', '2026-11-12', '1', '10.01')].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws, 'SR-shopify-2104'), []);
  assert.deepEqual(heldOf(ws), [['2104', 'rate']]);
});

test('#416 shipping, a discount or a refund: held for «Aufteilen»', () => {
  for (const change of [{ shipping: '7.00', total: '108.00' }, { discount: '5.00' }, { refunded: '20.00' }]) {
    const ws = shop();
    assert.ok(importSalesReport(ws, Buffer.from(cart(change)), 'orders_export.csv').ok);
    assert.deepEqual(lines(ws), [], JSON.stringify(change));
    assert.deepEqual(heldOf(ws), [['2101', 'rate']], JSON.stringify(change));
  }
});

test('#416 a refund in the payments export only: held, never split', () => {
  const ws = shop();
  const fees = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-12 10:00:00 +0100,charge,#2101,101.00,3.20,97.80,CHF', '2026-11-20 10:00:00 +0100,refund,#2101,-16.50,0.00,-16.50,CHF'].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(fees), 'payment_transactions_export.csv').ok);
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws), []);
});

test('#416 a refund of a cart split by code is held for the person to book by hand, never booked by code nor skipped', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.equal(lines(ws).length, 2);
  assert.ok(importSalesReport(ws, Buffer.from(cart({ refunded: '16.50' })), 'orders_export_refund.csv').ok);
  assert.deepEqual(heldOf(ws), [['2101', 'refundSplit']]);
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-shopify-2101')).length, 2, 'nothing booked by code');
});

test('#416 an order of a filed period is never booked', () => {
  const ws = shop();
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  ledger.config.closedThrough = '2026-11-30';
  writeFileSync(ws.paths.ledger, JSON.stringify(ledger, null, 2));
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws), []);
});

test('#416 an order she split by hand stays exactly as she booked it', () => {
  const ws = shop();
  // Held at first (a discount the export showed), split by her at other amounts than its items say.
  assert.ok(importSalesReport(ws, Buffer.from(cart({ discount: '5.00' })), 'orders_export.csv').ok);
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  const books = loadBooks(ws);
  assert.ok(update(books, PERSON, (x) => bookHeldOrder(ws, x, id, '2101', [{ amount: 70, rate: 8.1 }, { amount: 31, rate: 2.6 }])).ok);
  saveBooks(ws, books);
  const hers = lines(ws);
  const ids = loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'SR-shopify-2101').map((e) => e.id).sort();
  // The export without the discount now: code could split it, but she did.
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws), hers);
  assert.deepEqual(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'SR-shopify-2101').map((e) => e.id).sort(), ids);
  assert.deepEqual(heldOf(ws), []);
});

test('#416 an order held before (books of 0.4.1) is booked on the next drop of a report; «Rückgängig» of the report takes its lines back', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  // As an earlier build left it: the order held for its rates, nothing booked.
  const old = loadBooks(ws);
  update(old, PERSON, (b) => {
    b.journalEntries = b.journalEntries.filter((e) => e.transactionRef !== 'SR-shopify-2101');
    b.mappings = b.mappings.filter((m) => m.transactionRef !== 'SR-shopify-2101');
    const r = b.receipts.find((x) => x.id === id)!;
    r.report = { ...r.report!, held: [{ order: '2101', why: 'rate', date: '2026-11-12', gross: 101, currency: 'CHF', shipTo: 'CH' }] };
  });
  saveBooks(ws, old);
  assert.deepEqual(lines(ws), []);
  // The payments export dropped next takes the sales report again.
  const fees = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-12 10:00:00 +0100,charge,#2101,101.00,3.20,97.80,CHF'].join('\n');
  const done = importSalesReport(ws, Buffer.from(fees), 'payment_transactions_export.csv');
  assert.ok(done.ok);
  assert.deepEqual(lines(ws).map((l) => [l[0], l[3], l[4]]), [['2026-11-12', 68, 'V81'], ['2026-11-12', 33, 'V26']]);
  assert.deepEqual(heldOf(ws), []);
  assert.deepEqual(done.summary.split, ['2101'], 'the payments export\'s row names it too');
  assert.ok(removeSalesReport(ws, id));
  assert.deepEqual(lines(ws), [], '«Rückgängig» takes them back like the report\'s other sales');
});
