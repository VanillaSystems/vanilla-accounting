/**
 * #405: a provider's sales and fee reports are receipts of their own (CSV files in the year's
 * receipts/), each linked to every sale and fee it booked. A later drop (the provider's monthly
 * bills as PDFs) ran the read step, which rebuilt the receipts from the PDFs it found: the reports
 * and their links went, while their entries still named them. Invented shop, orders and bills.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookHeldOrder, importSalesReport } from '../src/intake/sales-report-import.js';
import { loadBooks, moduleActor, OwnershipError, PERSON, release, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import { providerIssuesIn } from '../src/intake/pair-chain.js';
import { countIssues, periodIssues } from '../src/app/areas/automation/period-issues.js';
import { openLines, openPeriodState } from '../src/app/areas/automation/open-period.js';
import { approvalWithheld } from '../src/app/areas/automation/filing-summary.js';
import './support/jurisdiction.js';

const head = 'Name,Paid at,Currency,Taxes,Total,Shipping Country,Refunded Amount,Created at,Payment Method';
const row = (order: string, day: string, total: string, tax: string) => `#${order},${day} 10:00:00 +0100,CHF,${tax},${total},CH,0.00,${day} 09:00:00 +0100,Shopify Payments`;
const ORDERS = [head, row('2001', '2026-11-02', '108.10', '8.10'), row('2002', '2026-11-10', '54.05', '4.05')].join('\n');
const FEES = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-02 10:00:00 +0100,charge,#2001,108.10,3.44,104.66,CHF', '2026-11-10 10:00:00 +0100,charge,#2002,54.05,1.82,52.23,CHF'].join('\n');

function shop(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'report-kept-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
  const accounts = join(dir, 'master-data', 'accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
  return workspaceAt(dir);
}

test('#405 a later drop of PDFs keeps the sales and fee reports as receipts, with every link to the sales and fees they booked', async () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok);
  assert.ok(importSalesReport(ws, Buffer.from(FEES), 'payment_transactions_export.csv').ok);
  const before = loadBooks(ws);
  const reports = before.receipts.filter((r) => r.report).map((r) => r.id).sort();
  const links = before.mappings.filter((m) => reports.includes(m.receiptId));
  assert.equal(reports.length, 2);
  assert.equal(links.length, 4, 'two sales and two fees, each linked to its report');

  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'bill.pdf'), await textPdf(['Muster Papeterie AG', 'Rechnung 4711 vom 12.11.2026', 'Papier', 'Total CHF 32.40 inkl. MWST 8.1% CHF 2.43']));
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['match', matchStep]] });

  const after = loadBooks(ws);
  assert.ok(after.receipts.some((r) => r.originalFilename === 'bill.pdf'), 'the dropped bill is read');
  assert.deepEqual(after.receipts.filter((r) => r.report).map((r) => r.id).sort(), reports, 'the reports are still receipts');
  assert.deepEqual(after.mappings.filter((m) => reports.includes(m.receiptId)), links, 'and their links stand');
  for (const r of after.receipts.filter((x) => x.report)) assert.ok(existsSync(join(ws.paths.root, 'transactional-data', '2026', 'receipts', r.filename)));
});

/** Shopify's order export as it writes it, with its line items and the tax per rate. */
const FULL = 'Name,Email,Financial Status,Paid at,Fulfillment Status,Fulfilled at,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Shipping Method,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Lineitem taxable,Billing Name,Billing City,Billing Zip,Billing Country,Shipping Name,Shipping City,Shipping Zip,Shipping Country,Cancelled at,Payment Method,Refunded Amount,Outstanding Balance,Id,Tax 1 Name,Tax 1 Value,Tax 2 Name,Tax 2 Value,Source';
const first = (order: string, day: string, subtotal: string, shipping: string, taxes: string, total: string, qty: string, price: string, tax1: string, tax2 = ',') =>
  `#${order},k@example.ch,paid,${day} 21:03:57 +0100,fulfilled,,CHF,${subtotal},${shipping},${taxes},${total},,0.00,PostPac Priority,${day} 21:03:57 +0100,${qty},Kanne,${price},,true,K,Chur,7000,CH,K,Chur,7000,CH,,Shopify Payments,0.00,0.00,58${order},${tax1},${tax2},web`;
const more = (order: string, day: string, qty: string, price: string) => `#${order},k@example.ch,,,,,,,,,,,,,${day} 21:03:57 +0100,${qty},Tee,${price},,true,,,,,,,,,,,,,,,,,,`;

test('#405 books an earlier run damaged get the reports back on the next run: the receipts from their files, the links from the entries that name them, what the report holds', async () => {
  const ws = shop();
  const csv = [FULL,
    first('2102', '2026-11-13', '101.00', '7.00', '6.12', '108.00', '1', '68.00', 'CH MWST 8.1%,5.28', 'CH MWST 2.6%,0.84'), more('2102', '2026-11-13', '2', '16.50'),
    first('2103', '2026-11-14', '54.05', '0.00', '4.05', '54.05', '1', '54.05', 'CH MWST 8.1%,4.05'),
  ].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  assert.ok(importSalesReport(ws, Buffer.from(FEES), 'payment_transactions_export.csv').ok);
  const whole = loadBooks(ws);
  const reports = whole.receipts.filter((r) => r.report).map(({ indexedAt: _i, ...r }) => r).sort((a, b) => a.id.localeCompare(b.id));
  const links = whole.mappings.filter((m) => reports.some((r) => r.id === m.receiptId));
  // As a run before the fix left them: the reports and their links gone, the entries naming them, the files in receipts/.
  const damaged = loadBooks(ws);
  update(damaged, PERSON, (b) => { b.receipts = b.receipts.filter((r) => !r.report); b.mappings = b.mappings.filter((m) => !reports.some((r) => r.id === m.receiptId)); });
  saveBooks(ws, damaged);
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'bill.pdf'), await textPdf(['Muster Papeterie AG', 'Rechnung 4711 vom 12.11.2026', 'Total CHF 32.40 inkl. MWST 8.1% CHF 2.43']));
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]] });
  const after = loadBooks(ws);
  assert.deepEqual(after.receipts.filter((r) => r.report).map(({ indexedAt: _i, originalFilename: _o, ...r }) => r).sort((a, b) => a.id.localeCompare(b.id)), reports.map(({ originalFilename: _o, ...r }) => r), 'each report its receipt again, with what it holds (its original name is lost)');
  assert.deepEqual(after.mappings.filter((m) => reports.some((r) => r.id === m.receiptId)).sort((a, b) => a.transactionRef.localeCompare(b.transactionRef)), [...links].sort((a, b) => a.transactionRef.localeCompare(b.transactionRef)));
  assert.equal(after.journalEntries.length, whole.journalEntries.length, 'nothing booked twice');
});

test('#405 a held order and a month of fees without its bill are open items of their period: in the list, the counts, the sidebar\'s state, and the review withholds «Freigegeben» while the order is held', () => {
  const ws = shop();
  // The app's Shopify file knows its monthly Payments Invoice (proves: vat-correction).
  const csv = [FULL,
    first('2102', '2026-11-13', '101.00', '7.00', '6.12', '108.00', '1', '68.00', 'CH MWST 8.1%,5.28', 'CH MWST 2.6%,0.84'), more('2102', '2026-11-13', '2', '16.50'),
    first('2103', '2026-11-14', '54.05', '0.00', '4.05', '54.05', '1', '54.05', 'CH MWST 8.1%,4.05'),
  ].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  assert.ok(importSalesReport(ws, Buffer.from(FEES), 'payment_transactions_export.csv').ok);
  const books = loadBooks(ws);
  const issues = providerIssuesIn(ws, books, '2026-12-15');
  const report = books.receipts.find((r) => r.report?.kind === 'sales')!;
  assert.deepEqual(issues.held, [{ provider: 'shopify', name: 'Shopify', receipt: report.id, order: '2102', why: 'rate', date: '2026-11-13', gross: 108, currency: 'CHF' }]);
  assert.deepEqual(issues.bills, [{ provider: 'shopify', name: 'Shopify', month: '2026-11', date: '2026-11-30', fees: 5.26 }]);
  assert.deepEqual(providerIssuesIn(ws, books, '2026-11-20').bills, [], 'a month not over yet has no bill to miss');

  const list = periodIssues(books, [], '2026-10-01', '2026-12-31', [], new Map(), '2026-12-15', new Map(), issues);
  assert.deepEqual(list.filter((i) => i.kind === 'held' || i.kind === 'bill').map((i) => i.kind), ['held', 'bill']);
  assert.deepEqual([countIssues(list).held, countIssues(list).bills], [1, 1]);
  assert.deepEqual(periodIssues(books, [], '2026-07-01', '2026-09-30', [], new Map(), '2026-12-15', new Map(), issues).filter((i) => i.kind === 'held' || i.kind === 'bill'), [], 'nothing of another period');
  // The sidebar's state is about the oldest period not filed: the demo's Q4 once Q3 is filed.
  const state = openPeriodState({ ...books, config: { ...books.config, closedThrough: '2026-09-30' } }, [], [], [], { today: '2026-12-15', vatRegistered: true, length: 'quarter', dueDays: 60 }, new Map(), new Map(), issues);
  assert.deepEqual(openLines(state).filter((l) => l.kind === 'held' || l.kind === 'bills').map((l) => [l.kind, l.n]), [['held', 1], ['bills', 1]]);

  const review = { workflow: 'vat-filing', step: 'review', reads: { return: { from: '2026-10-01', to: '2026-12-31', figures: {} } } } as never;
  assert.deepEqual(approvalWithheld(review, [], books, issues), { rates: [], questions: 0, held: 1, outcome: 'approved' });

  // Booked by the person under the sale's ref, the order is no longer open.
  const booked = { ...books, journalEntries: [...books.journalEntries, { id: 'h', transactionRef: 'SR-shopify-2102', date: '2026-11-13', accountDebit: '1093', accountCredit: '3200', amount: 108, origin: 'manual' as const }] };
  assert.deepEqual(providerIssuesIn(ws, booked, '2026-12-15').held, []);
  assert.equal(approvalWithheld(review, [], booked, providerIssuesIn(ws, booked, '2026-12-15')), undefined);
  // The month's bill in the books: its fees' VAT can be deducted, nothing is missing.
  const bill = { ...report, id: 'bill', filename: 'b.pdf', kind: undefined, report: undefined, date: '2026-12-02', extractedText: 'Shopify Payments Invoice for November 2026' };
  assert.deepEqual(providerIssuesIn(ws, { ...books, receipts: [...books.receipts, bill] }, '2026-12-15').bills, [], 'a bill of the first days of December is November\'s');
});

test('#405 «Aufteilen»: the person books a held cart by its parts, each at the firm\'s code of its rate, once they add up to its gross; the report then knows it as booked', () => {
  const ws = shop();
  const csv = [FULL,
    first('2102', '2026-11-13', '101.00', '7.00', '6.12', '108.00', '1', '68.00', 'CH MWST 8.1%,5.28', 'CH MWST 2.6%,0.84'), more('2102', '2026-11-13', '2', '16.50'),
  ].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  const tryIt = (parts: Array<{ amount: number; rate: number }>) => { const b = loadBooks(ws); return update(b, PERSON, (x) => bookHeldOrder(ws, x, id, '2102', parts)); };
  assert.deepEqual(tryIt([{ amount: 75, rate: 8.1 }, { amount: 30, rate: 2.6 }]), { ok: false, why: 'sum' });
  assert.deepEqual(tryIt([{ amount: 75, rate: 8.1 }, { amount: 33, rate: 7.7 }]), { ok: false, why: 'rate' });
  const books = loadBooks(ws);
  const done = update(books, PERSON, (x) => bookHeldOrder(ws, x, id, '2102', [{ amount: 75, rate: 8.1 }, { amount: 33, rate: 2.6 }]));
  saveBooks(ws, books);
  assert.ok(done.ok);
  const after = loadBooks(ws);
  assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === 'SR-shopify-2102').map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.origin]).sort((a, b) => Number(b[3]) - Number(a[3])), [
    ['2026-11-13', '1093', '3200', 75, 'V81', 'manual'],
    ['2026-11-13', '1093', '3200', 33, 'V26', 'manual'],
  ]);
  assert.equal(after.receipts.find((r) => r.id === id)?.report?.held, undefined, 'the report holds it no more');
  assert.deepEqual(providerIssuesIn(ws, after, '2026-12-15').held, []);
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  const again = loadBooks(ws);
  assert.equal(again.journalEntries.filter((e) => e.transactionRef === 'SR-shopify-2102').length, 2, 'dropped again: booked once');
  assert.equal(again.receipts.find((r) => r.id === id)?.report?.held, undefined, 'and not held again');
});

test('#405 a receipt whose file changed under its name: the run ends, the new read is the receipt, its links and the bookings that name it go along; a later run is fine', async () => {
  const ws = shop();
  const rdir = join(ws.paths.root, 'transactional-data', '2026', 'receipts');
  const run = () => runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]] });
  await run();
  const b0 = loadBooks(ws);
  const closed = b0.config.closedThrough ?? '';
  const pick = b0.receipts.find((r) => r.location === 'archived' && r.filename.endsWith('.pdf') && existsSync(join(rdir, r.filename)) && (r.date ?? '') > closed
    && b0.mappings.some((m) => m.receiptId === r.id && (b0.transactions.find((t) => t.ref === m.transactionRef)?.date ?? '') > closed)
    && !b0.journalEntries.some((e) => e.receipts?.includes(r.id) && e.origin === 'manual'))!;
  assert.ok(pick, 'a linked receipt of the open period');
  const links = b0.mappings.filter((m) => m.receiptId === pick.id).map((m) => m.transactionRef).sort();
  const naming = b0.journalEntries.filter((e) => e.receipts?.includes(pick.id)).map((e) => e.id).sort();
  writeFileSync(join(rdir, pick.filename), await textPdf(['Muster AG', 'Rechnung 99 vom 12.11.2026', 'Total CHF 10.00 inkl. MWST 8.1% CHF 0.75']));
  await run();
  const b1 = loadBooks(ws);
  const now = b1.receipts.find((r) => r.filename === pick.filename && r.id !== pick.id);
  assert.ok(now, 'the new read is in the books');
  assert.equal(b1.receipts.some((r) => r.id === pick.id), false, 'the old record went, on purpose');
  assert.deepEqual(b1.mappings.filter((m) => m.receiptId === now!.id).map((m) => m.transactionRef).sort(), links, 'its links carried');
  assert.deepEqual(b1.journalEntries.filter((e) => e.receipts?.includes(now!.id)).map((e) => e.id).sort(), naming, 'and the bookings that named it');
  await run();
  assert.ok(loadBooks(ws).receipts.some((r) => r.id === now!.id), 'a later run is fine');
});

test('#405 the write door holds no receipt of books without a home (a clone, as a dry run makes)', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok);
  const clone = structuredClone(loadBooks(ws));
  const id = clone.receipts.find((r) => r.report)!.id;
  update(clone, moduleActor('intake'), (b) => { b.receipts = b.receipts.filter((r) => r.id !== id); });
  assert.equal(clone.receipts.some((r) => r.id === id), false);
});

test('#405 only a cart whose rates the report cannot tell apart withholds «Freigegeben»; another reason is shown, not withheld for; «Aufteilen» takes the rate holds only; one in a filed period is no open item', () => {
  const ws = shop();
  const csv = [FULL, first('2102', '2026-11-13', '101.00', '7.00', '6.12', '108.00', '1', '68.00', 'CH MWST 8.1%,5.28', 'CH MWST 2.6%,0.84'), more('2102', '2026-11-13', '2', '16.50')].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok);
  const books = loadBooks(ws);
  const report = books.receipts.find((r) => r.report)!;
  const review = { workflow: 'vat-filing', step: 'review', reads: { return: { from: '2026-10-01', to: '2026-12-31', figures: {} } } } as never;
  // As a test order would be held: no payment in the payments export.
  const asTest = { ...books, receipts: books.receipts.map((r) => (r.id === report.id ? { ...r, report: { ...r.report!, held: [{ ...r.report!.held![0], why: 'noPayment' as const }] } } : r)) };
  const issues = providerIssuesIn(ws, asTest, '2026-12-15');
  assert.deepEqual(issues.held.map((h) => h.why), ['noPayment'], 'shown');
  assert.equal(approvalWithheld(review, [], asTest, issues), undefined, 'not withheld for');
  saveBooks(ws, asTest as never);
  assert.deepEqual(update(loadBooks(ws), PERSON, (x) => bookHeldOrder(ws, x, report.id, '2102', [{ amount: 108, rate: 8.1 }])), { ok: false, why: 'notRate' });
  // Its day in a filed period: named on the report, no open item, nothing withheld.
  const filed = { ...books, config: { ...books.config, closedThrough: '2026-11-30' } };
  const inFiled = providerIssuesIn(ws, filed, '2026-12-15');
  assert.deepEqual(inFiled.held.map((h) => [h.order, h.filed]), [['2102', true]]);
  assert.deepEqual(periodIssues(filed, [], '2026-10-01', '2026-12-31', [], new Map(), '2026-12-15', new Map(), inFiled).filter((i) => i.kind === 'held'), []);
  assert.equal(approvalWithheld(review, [], filed, inFiled), undefined);
  assert.deepEqual(inFiled.bills, [], 'a month of a filed period has no missing bill');
});

test('#405 a refund of a cart the person split is held for her to book by hand, never skipped', () => {
  const ws = shop();
  const order = (refunded: string) => [FULL, first('2102', '2026-11-13', '101.00', '7.00', '6.12', '108.00', '1', '68.00', 'CH MWST 8.1%,5.28', 'CH MWST 2.6%,0.84').replace('Shopify Payments,0.00,0.00', `Shopify Payments,${refunded},0.00`), more('2102', '2026-11-13', '2', '16.50')].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(order('0.00')), 'orders_export.csv').ok);
  const id = loadBooks(ws).receipts.find((r) => r.report)!.id;
  const books = loadBooks(ws);
  assert.ok(update(books, PERSON, (x) => bookHeldOrder(ws, x, id, '2102', [{ amount: 75, rate: 8.1 }, { amount: 33, rate: 2.6 }])).ok);
  saveBooks(ws, books);
  assert.ok(importSalesReport(ws, Buffer.from(order('20.00')), 'orders_export_refund.csv').ok);
  const after = loadBooks(ws);
  const held = after.receipts.filter((r) => r.report).flatMap((r) => r.report!.held ?? []);
  assert.deepEqual(held.map((h) => [h.order, h.why]), [['2102', 'refundSplit']]);
  assert.deepEqual(providerIssuesIn(ws, after, '2026-12-15').held.map((h) => h.why), ['refundSplit'], 'an open item while the sale is booked');
  assert.equal(after.journalEntries.filter((e) => e.transactionRef.startsWith('SR-shopify-2102')).length, 2, 'nothing booked by code');
});

test('#405 the write door: a module removes no receipt whose file still lies in receipts/ and no link whose receipt and payment stand, unless it releases them', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok);
  const report = loadBooks(ws).receipts.find((r) => r.report)!;
  const intake = moduleActor('intake');

  assert.throws(() => update(loadBooks(ws), intake, (b) => { b.receipts = b.receipts.filter((r) => r.id !== report.id); }), (e: Error) => e instanceof OwnershipError && /receipt .* removed/.test(e.message));
  assert.throws(() => update(loadBooks(ws), intake, (b) => { b.mappings = b.mappings.filter((m) => m.receiptId !== report.id); }), (e: Error) => e instanceof OwnershipError && /link SR-shopify-2001 → /.test(e.message));
  const freed = loadBooks(ws);
  update(freed, intake, (b) => { const gone = b.mappings.filter((m) => m.receiptId === report.id); release(b, { mappings: gone }); b.mappings = b.mappings.filter((m) => !gone.includes(m)); });
  assert.equal(freed.mappings.some((m) => m.receiptId === report.id), false, 'released on purpose: let go');
  update(loadBooks(ws), PERSON, (b) => { b.receipts = b.receipts.filter((r) => r.id !== report.id); });

  rmSync(join(ws.paths.root, 'transactional-data', '2026', 'receipts', report.filename));
  const fileGone = loadBooks(ws);
  update(fileGone, intake, (b) => { b.receipts = b.receipts.filter((r) => r.id !== report.id); b.mappings = b.mappings.filter((m) => m.receiptId !== report.id); });
  assert.equal(fileGone.receipts.some((r) => r.id === report.id), false, 'a receipt whose file the person took out of receipts/ goes with it, and its links');
});
