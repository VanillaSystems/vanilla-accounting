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
import { mixedCart } from '../src/booking/sales-report.js';
import { heldReasonText } from '../src/app/lib/held-reason.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import en from '../src/app/i18n/locales/en.js';
import fr from '../src/app/i18n/locales/fr.js';
import it from '../src/app/i18n/locales/it.js';

import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

/** Each locale as the UI fills it: `has` and `say` as isKey and tWith give them. */
const LANGS = Object.entries({ de, en, fr, it }).map(([code, l]) => {
  const lang = { code, messages: l.messages };
  return { code, has: (k: string) => k in l.messages, say: (k: string, v: Record<string, string | number>) => formatIn(lang, k as never, v) };
});

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

/**
 * The review's probes of #437, seeded: random carts of 2 to 9 lines at 8.1 % and 2.6 %, each line of 1 to `most` pieces, the
 * export's tax per rate rounded the three ways a provider may round it: each line's tax rounded and summed (`line`), the rate's
 * total rounded once (`total`), each piece's tax rounded and times the quantity (`unit`). Code never books a split other than the
 * true one; an order it cannot tell apart waits.
 */
test('#416 random carts, any rounding of the tax per rate, quantities above one: never a wrong split booked', () => {
  const rates = [{ code: 'V81', rate: 8.1 }, { code: 'V26', rate: 2.6 }];
  for (const [model, most] of [['line', 1], ['total', 1], ['line', 6], ['total', 6], ['unit', 6]] as const) {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let wrong = 0, right = 0, held = 0;
    const examples: unknown[] = [];
    for (let t = 0; t < 30000; t++) {
      const n = 2 + Math.floor(rnd() * 8);
      const items = Array.from({ length: n }, () => ({ unit: (1 + Math.floor(rnd() * 60)) * 50 + (rnd() < 0.5 ? 0 : Math.floor(rnd() * 50)), q: 1 + Math.floor(rnd() * most), r: rnd() < 0.5 ? 8.1 : 2.6 }));
      if (new Set(items.map((l) => l.r)).size < 2) continue;
      const at = (r: number) => items.filter((l) => l.r === r);
      const f = (r: number, rp: number) => (rp * r) / (100 + r);
      const tax = (r: number) => (model === 'line' ? at(r).reduce((s, l) => s + Math.round(f(r, l.unit * l.q)), 0)
        : model === 'unit' ? at(r).reduce((s, l) => s + Math.round(f(r, l.unit)) * l.q, 0)
          : Math.round(f(r, at(r).reduce((s, l) => s + l.unit * l.q, 0))));
      const truth = [8.1, 2.6].map((r) => at(r).reduce((s, l) => s + l.unit * l.q, 0));
      const got = mixedCart({ gross: items.reduce((s, l) => s + l.unit * l.q, 0) / 100, items: items.map((l) => (l.unit * l.q) / 100), units: items.map((l) => l.q), taxes: [{ rate: 8.1, amount: tax(8.1) / 100 }, { rate: 2.6, amount: tax(2.6) / 100 }] }, rates);
      if (!Array.isArray(got)) { held++; continue; }
      const rp = got.map((x) => Math.round(x.gross * 100));
      if (rp[0] === truth[0] && rp[1] === truth[1]) right++;
      else { wrong++; if (examples.length < 3) examples.push({ items, truth, rp }); }
    }
    console.log(`#416 probe, ${model}, up to ${most} pieces: booked right ${right}, wrong ${wrong}, held ${held}`);
    assert.equal(wrong, 0, `${model}, up to ${most}: ${JSON.stringify(examples)}`);
  }
});

test('#416 more line items than code tries: held with its own reason that names the limit, and «Aufteilen» takes it', () => {
  const ws = shop();
  // A teapot at 68.00 (8.1 %) and twelve teas at 2.75 (2.6 %): thirteen lines.
  const teas = Array.from({ length: 12 }, () => more('2105', '2026-11-12', '1', '2.75'));
  const csv = [FULL, first({ order: '2105', day: '2026-11-12', subtotal: '101.00', shipping: '0.00', taxes: '5.94', total: '101.00', qty: '1', price: '68.00', tax1: 'CH MWST 8.1%,5.10', tax2: 'CH MWST 2.6%,0.84' }), ...teas].join('\n');
  const done = importSalesReport(ws, Buffer.from(csv), 'orders_export.csv');
  assert.ok(done.ok);
  assert.deepEqual(lines(ws, 'SR-shopify-2105'), []);
  assert.deepEqual(heldOf(ws), [['2105', 'rateTooMany']]);
  assert.deepEqual(done.summary.held.map((h) => h.why), ['rateTooMany']);
  const held = loadBooks(ws).receipts.find((r) => r.report)!.report!.held![0];
  assert.deepEqual([held.rates, held.most], [2, 12], 'kept with its number of rates and the limit at that many');
  for (const l of LANGS) {
    const said = heldReasonText(held, l.has, l.say);
    assert.ok(said.includes('2105') && said.includes('12') && !said.includes('{'), `${l.code}: ${said}`);
  }
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  const books = loadBooks(ws);
  assert.ok(update(books, PERSON, (x) => bookHeldOrder(ws, x, id, '2105', [{ amount: 68, rate: 8.1 }, { amount: 33, rate: 2.6 }])).ok, '«Aufteilen» takes it');
});

test('#416 a code split booked on the order\'s day moves onto the day a payments export later says it was charged; her split by hand stays', () => {
  const fees = (day: string) => ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', `${day} 10:00:00 +0100,charge,#2101,101.00,3.20,97.80,CHF`].join('\n');
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.deepEqual(lines(ws).map((l) => l[0]), ['2026-11-12', '2026-11-12']);
  assert.ok(importSalesReport(ws, Buffer.from(fees('2026-11-13')), 'payment_transactions_export.csv').ok);
  assert.deepEqual(lines(ws), [
    ['2026-11-13', '1093', '3200', 68, 'V81', 'classify'],
    ['2026-11-13', '1093', '3200', 33, 'V26', 'classify'],
  ]);
  const report = loadBooks(ws).receipts.find((r) => r.report?.kind === 'sales')!.id;
  for (const e of loadBooks(ws).journalEntries.filter((x) => x.transactionRef === 'SR-shopify-2101')) assert.deepEqual(e.receipts, [report], 'still the sales report\'s');
  assert.ok(loadBooks(ws).mappings.some((m) => m.transactionRef === 'SR-shopify-2101' && m.receiptId === report));

  const hand = shop();
  assert.ok(importSalesReport(hand, Buffer.from(cart({ discount: '5.00' })), 'orders_export.csv').ok);
  const id = loadBooks(hand).receipts.find((r) => r.report)!.id;
  const books = loadBooks(hand);
  assert.ok(update(books, PERSON, (x) => bookHeldOrder(hand, x, id, '2101', [{ amount: 70, rate: 8.1 }, { amount: 31, rate: 2.6 }])).ok);
  saveBooks(hand, books);
  const hers = lines(hand);
  assert.ok(importSalesReport(hand, Buffer.from(fees('2026-11-13')), 'payment_transactions_export.csv').ok);
  assert.deepEqual(lines(hand), hers, 'her «Aufteilen» stays on her day');
});

/** A payments export that says order 2101 was charged on `day`. */
const charge2101 = (day: string) => ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', `${day} 10:00:00 +0100,charge,#2101,101.00,3.20,97.80,CHF`].join('\n');
const closeThrough = (ws: Workspace, day: string) => {
  const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8'));
  ledger.config.closedThrough = day;
  writeFileSync(ws.paths.ledger, JSON.stringify(ledger, null, 2));
};

test('#416 agreed basis: a code split stays on the order\'s day whatever day it was charged', () => {
  const ws = shop();
  const manifest = join(ws.paths.root, 'belege.workspace.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('reporting: received', 'reporting: agreed'));
  const agreed = workspaceAt(ws.paths.root);
  assert.ok(importSalesReport(agreed, Buffer.from(cart()), 'orders_export.csv').ok);
  assert.deepEqual(lines(agreed).map((l) => l[0]), ['2026-11-12', '2026-11-12']);
  assert.ok(importSalesReport(agreed, Buffer.from(charge2101('2026-11-13')), 'payment_transactions_export.csv').ok);
  assert.deepEqual(lines(agreed).map((l) => l[0]), ['2026-11-12', '2026-11-12'], 'the tax point is the order\'s day');
});

test('#416 a code split a person or the AI linked a receipt to stays on its day', () => {
  for (const by of ['human', 'llm'] as const) {
    const ws = shop();
    assert.ok(importSalesReport(ws, Buffer.from(cart()), 'orders_export.csv').ok);
    const books = loadBooks(ws);
    const other = books.receipts.find((r) => !r.report)!.id;
    update(books, PERSON, (b) => { b.mappings.push({ transactionRef: 'SR-shopify-2101', receiptId: other, by }); });
    saveBooks(ws, books);
    assert.ok(importSalesReport(ws, Buffer.from(charge2101('2026-11-13')), 'payment_transactions_export.csv').ok);
    assert.deepEqual(lines(ws).map((l) => l[0]), ['2026-11-12', '2026-11-12'], by);
  }
});

test('#416 a code split of a filed period, or charged on a filed day, is never moved', () => {
  const filed = shop();
  assert.ok(importSalesReport(filed, Buffer.from(cart()), 'orders_export.csv').ok);
  closeThrough(filed, '2026-11-12');
  assert.ok(importSalesReport(filed, Buffer.from(charge2101('2026-11-13')), 'payment_transactions_export.csv').ok);
  assert.deepEqual(lines(filed).map((l) => [l[0], l[3]]), [['2026-11-12', 68], ['2026-11-12', 33]], 'its lines filed: as filed, nothing beside them');

  const day = shop();
  assert.ok(importSalesReport(day, Buffer.from(cart()), 'orders_export.csv').ok);
  closeThrough(day, '2026-11-05');
  assert.ok(importSalesReport(day, Buffer.from(charge2101('2026-11-03')), 'payment_transactions_export.csv').ok);
  assert.deepEqual(lines(day).map((l) => [l[0], l[3]]), [['2026-11-12', 68], ['2026-11-12', 33]], 'never moved into a filed period');
});

test('#416 the limit at three rates is its own: seven items, named so', () => {
  const rates = [{ code: 'V81', rate: 8.1 }, { code: 'V26', rate: 2.6 }, { code: 'V38', rate: 3.8 }];
  const taxes = [{ rate: 8.1, amount: 1 }, { rate: 2.6, amount: 1 }, { rate: 3.8, amount: 1 }];
  assert.deepEqual(mixedCart({ gross: 8, items: Array(8).fill(1), taxes }, rates), { tooMany: true, rates: 3, most: 7 });
  for (const l of LANGS) {
    const said = heldReasonText({ order: '2106', why: 'rateTooMany', rates: 3, most: 7 }, l.has, l.say);
    assert.ok(said.includes('3') && said.includes('7') && !said.includes('12'), `${l.code}: ${said}`);
  }
});

test('#416 a held reason this build has no words for (stored by a newer one) reads as a plain sentence, never throws', () => {
  for (const l of LANGS) {
    const said = heldReasonText({ order: '2107', why: 'somethingNewer' }, l.has, l.say);
    assert.ok(said.includes('2107') && !said.includes('drop.held'), `${l.code}: ${said}`);
  }
});
