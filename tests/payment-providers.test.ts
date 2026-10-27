/**
 * Payment providers (#203): a shop platform's or card terminal's payout is a settlement, not a sale.
 * It is no candidate for any receipt (sets, the pair chain, the model's match, order links), needs
 * none, and is booked bank / the provider's clearing account without VAT, in code. The sales come
 * onto the clearing account from the provider's sales report, each order with its own code (Swiss
 * delivery V81 or the reduced rate its tax shows, abroad V0, a refund with its minus on its own day),
 * the fees from its fee report; order documents go with their sale. A payout booked as sales before
 * is booked again only when every order it can pay is booked from a report; what a payout that stays
 * may hold waits for the person. At a period's close the review shows the clearing account, its month
 * ends, and what the provider paid out after the end (the most the balance may be).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { receiptKnowledge, receiptWait, noReceiptOfItsOwn, settlementAccount } from '../src/booking/receipt-wait.js';
import { clearingCheck, joinSpans, monthEnds, providerOfPayment, type Provider } from '../src/booking/providers.js';
import { amountOf, bookReport, csvRows, dayOf, linkOrdersToSales, readReport, recognizeReport, type ReportContext } from '../src/booking/sales-report.js';
import { mergeProvider, parseProvider } from '../src/knowledge/provider.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { linkReceiptSets } from '../src/intake/receipt-sets.js';
import { searchPairs } from '../src/intake/pairing.js';
import { bookPayoutReports, importSalesReport, payoutPlan, providersOf, recognizeCsv, removeSalesReport, setProviderAccount } from '../src/intake/sales-report-import.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { parseRule } from '../src/booking/rules.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import type { DropSession } from '../src/types/drop.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();

/** Shopify's order export as it writes it: one row per line of an order, the order's figures on its first. */
const ORDERS = [
  'Name,Email,Financial Status,Paid at,Currency,Subtotal,Shipping,Taxes,Total,Lineitem name,Shipping Country,Refunded Amount,Created at,Payment Method',
  '#1001,a@example.ch,paid,2026-07-03 14:22:10 +0200,CHF,100.00,8.10,8.10,108.10,Bohnen 500 g,CH,0.00,2026-07-02 22:10:00 +0200,Shopify Payments',
  '#1001,,,,,,,,,Filter,,,,',
  '#1002,b@example.de,paid,2026-07-05 09:01:00 +0200,CHF,80.00,10.00,0.00,90.00,Bohnen 1 kg,DE,0.00,2026-07-05 08:00:00 +0200,shopify_payments',
  '#1003,c@example.ch,partially_refunded,2026-08-11 10:00:00 +0200,CHF,50.00,4.05,4.05,54.05,Bohnen 250 g,CH,20.00,2026-08-11 09:00:00 +0200,Shopify Payments',
  '#1004,d@example.ch,paid,2026-08-12 10:00:00 +0200,CHF,40.00,0.00,0.00,40.00,Tasse,CH,0.00,2026-08-12 09:00:00 +0200,Shopify Payments',
  '#1000,e@example.ch,paid,2026-06-28 10:00:00 +0200,CHF,30.00,2.43,2.43,32.43,Bohnen 250 g,CH,0.00,2026-06-28 09:00:00 +0200,Shopify Payments',
  '#1005,f@example.ch,paid,2026-07-08 10:00:00 +0200,CHF,50.00,4.05,4.05,54.05,Bohnen 250 g,CH,0.00,2026-07-08 09:00:00 +0200,PayPal Express Checkout',
  '#1006,g@example.ch,paid,2026-07-09 10:00:00 +0200,CHF,50.00,4.05,4.05,54.05,Bohnen 250 g,CH,0.00,2026-07-09 09:00:00 +0200,Bogus',
].join('\n');

/** Shopify Payments' transactions export: a fee per charge. */
const FEES = [
  'Transaction Date,Type,Order,Amount,Fee,Net,Currency',
  '2026-07-03 14:22:10 +0200,charge,#1001,108.10,3.44,104.66,CHF',
  '2026-07-05 09:01:00 +0200,charge,#1002,90.00,2.91,87.09,CHF',
].join('\n');

const SHOPIFY = loadKnowledge(APP_ROOT, DEMO_ROOT).counterparties.find((c) => c.id === 'shopify') as Provider;

/** A copy of the demo whose Shopify file names its clearing account, revenue and fees, with the clearing accounts in its chart. */
function shop(provider = '  clearing: "1093"\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n', extra = ''): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'providers-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), `id: shopify\n${extra}${provider ? `provider:\n${provider}` : ''}`);
  const accounts = join(dir, 'master-data', 'accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }, { number: '1094', name: 'Durchlaufkonto Shopify EUR' }], null, 2));
  return workspaceAt(dir);
}

const payout = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-07-07', amount: 191.75, currency: 'CHF', direction: 'CRDT', description: 'Gutschrift Shopify Payments', counterparty: 'Shopify Payments', ...over });

/** A payout an older run booked as sales, as the demo's generator still does. */
const asSales = (tx: BankTransaction, id = `e-${tx.ref}`): JournalEntry => ({ id, transactionRef: tx.ref, date: tx.date, accountDebit: '1021', accountCredit: '3200', amount: tx.amount, vatCode: 'V81', origin: 'classify', by: { kind: 'model', model: 'm' } });

const lines = (es: readonly JournalEntry[]) => es.map((e) => [e.transactionRef, e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);

const ctxOf = (over: Partial<ReportContext> = {}): ReportContext => ({
  provider: { id: 'shopify', name: 'Shopify' }, clearing: '1093', revenue: '3200', fees: { account: '6840', vat: 'I0' }, receipt: 'rep', base: 'CHF',
  rate: (c, d) => fx.daily(c, d), codes: { domestic: 'V81', rate: 8.1, reduced: [{ code: 'V26', rate: 2.6 }], abroad: 'V0', negative: '-' }, territory: ['CH', 'LI'], agreed: false,
  gateways: SHOPIFY.provider.gateways,
  isClosed: (d) => d <= '2026-06-30', beforeBooks: () => false, newId: (() => { let i = 0; return () => `e${++i}`; })(),
  texts: { sale: (o, c) => `Shopify, Bestellung #${o}, ${c}`, refund: (o) => `Shopify, Rückerstattung #${o}`, fee: (k) => `Shopify, Gebühren ${k}`, reason: (k) => k },
  ...over,
});

const salesOf = (csv: string, facts: Provider['provider'] = SHOPIFY.provider) => {
  const read = readReport(csv, 'sales', facts);
  if ('missing' in read || read.kind !== 'sales') throw new Error(`columns: ${JSON.stringify(read)}`);
  return read;
};

/** A November export of the shop: dates the demo's own payouts never reach. */
const head = 'Name,Paid at,Currency,Taxes,Total,Shipping Country,Refunded Amount,Created at,Payment Method';
const row = (order: string, day: string, total: string, tax: string, country = 'CH', way = 'Shopify Payments') => `#${order},${day} 10:00:00 +0100,CHF,${tax},${total},${country},0.00,${day} 09:00:00 +0100,${way}`;
const NOVEMBER = [head,
  row('2001', '2026-11-02', '108.10', '8.10'),
  row('2002', '2026-11-10', '54.05', '4.05'),
  row('2003', '2026-11-20', '90.00', '0.00', 'DE'),
  row('2004', '2026-11-12', '54.05', '4.05', 'CH', 'PayPal Express Checkout'),
  row('2005', '2026-11-13', '54.05', '4.05', 'CH', 'Bogus'),
  row('2006', '2026-11-14', '54.05', '4.05', 'CH', 'Shopify Payments + gift_card'),
].join('\n');

/** The demo copy with three payouts of November an older run booked as sales: before the report's days, in them, after them. */
function november(ws: Workspace): { pa: BankTransaction; pb: BankTransaction; pc: BankTransaction } {
  const books = loadBooks(ws);
  const pa = payout('PA', { date: '2026-11-04', amount: 100 });
  const pb = payout('PB', { date: '2026-11-18', amount: 52.5 });
  const pc = payout('PC', { date: '2026-11-25', amount: 88 });
  books.transactions.push(pa, pb, pc);
  books.journalEntries.push(asSales(pa), asSales(pb), asSales(pc));
  saveBooks(ws, books);
  return { pa, pb, pc };
}

// ─── The provider's file ─────────────────────────────────────────────────────

test('the app\'s Shopify file names its report columns and the gateway it collects; the accounts belong to the company\'s file, never the app\'s', () => {
  assert.ok(SHOPIFY.provider.reports.sales?.order?.includes('Name'));
  assert.ok(SHOPIFY.provider.reports.sales?.gateway?.includes('Payment Method'));
  assert.deepEqual(SHOPIFY.provider.gateways, ['Shopify Payments']);
  assert.ok(SHOPIFY.provider.reports.fees?.fee?.includes('Fee'));
  assert.equal(SHOPIFY.provider.clearing, undefined, 'the app cannot know a chart');
  assert.match((mergeProvider({ clearing: '1093' }, undefined, true) as { problem: string }).problem, /one company's chart/);
  assert.deepEqual((mergeProvider({ reports: { sales: { order: 'Name', date: 'Paid at', gross: 'Total' } } }, { clearing: '1093' }, true) as { raw: unknown }).raw, { reports: { sales: { order: 'Name', date: 'Paid at', gross: 'Total' } }, clearing: '1093' });
  assert.match((parseProvider({ reports: { sales: { order: 'Name' } } }) as { problem: string }).problem, /needs the columns date, gross/);
  assert.match((parseProvider({ fees: { account: '6840' } }) as { problem: string }).problem, /provider\.fees must be/);
  assert.match((parseProvider({ clearings: '1093' }) as { problem: string }).problem, /provider\.clearings is unknown/);
  assert.match((parseProvider({ reports: { sales: { order: 'Name', date: 'Paid at', gross: 'Total' } }, gateways: ['x'] }) as { problem: string }).problem, /needs the column reports\.sales\.gateway/);
});

test('8. the company\'s file says its own payout days over the app\'s', () => {
  assert.deepEqual((mergeProvider({ payoutDays: 7 }, { payoutDays: 10, clearing: '1093' }, true) as { raw: { payoutDays: number } }).raw.payoutDays, 10);
  const ws = shop('  clearing: "1093"\n  payoutDays: 10\n');
  assert.equal(providersOf(ws).find((p) => p.id === 'shopify')?.provider.payoutDays, 10);
  assert.equal(SHOPIFY.provider.payoutDays, 7, 'the app\'s file alone');
});

// ─── 1. Out of matching ──────────────────────────────────────────────────────

test('a provider\'s payout needs no receipt and has none of its own; money out to the same business (its subscription) still waits for one', () => {
  const ws = shop();
  const context = loadClassifyContext(ws);
  assert.equal(providerOfPayment(payout('P'), [], context.counterparties ?? [])?.id, 'shopify');
  assert.equal(providerOfPayment(payout('S', { direction: 'DBIT', amount: 39, description: 'Card transaction of 39.00 CHF issued by Shopify' }), [], context.counterparties ?? []), undefined);
  const ctx = { free: new Set<string>(), assumesUnread: new Set<string>(), wordings: [], ownIbans: new Set<string>(), settles: settlementAccount(context), inputTax: true };
  assert.deepEqual(receiptWait(payout('P'), { linked: 'none', payout: true }, ctx), { wait: false, why: 'provider' });
  const books = { transactions: [payout('P'), payout('S', { direction: 'DBIT', amount: 39, description: 'Card transaction of 39.00 CHF issued by Shopify' })], receipts: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const none = noReceiptOfItsOwn(books, context, receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root)), fx);
  assert.equal(none(books.transactions[0]), true, 'the payout');
  assert.equal(none(books.transactions[1]), false, 'the subscription');
});

test('10. a plain Stripe payout is not taken for Shopify\'s; a company whose Stripe payouts are Shopify\'s says so in its own file', () => {
  const stripe = payout('ST', { description: 'Received money from Stripe Payments UK Ltd with reference STRIPE 4711', counterparty: undefined });
  assert.equal(providerOfPayment(stripe, [], loadClassifyContext(shop()).counterparties ?? []), undefined);
  const says = shop(undefined, 'match:\n  tx: [ "stripe payments uk" ]\n');
  assert.equal(providerOfPayment(stripe, [], loadClassifyContext(says).counterparties ?? [])?.id, 'shopify');
});

test('the pair chain and the receipt sets link no receipt to a payout: its order pages and its payout document stay unlinked', () => {
  const ws = shop();
  const context = loadClassifyContext(ws);
  // Two documents of the provider that add up to the payout, as a credit to the shop: the shape a set takes for money in.
  const page = (id: string, amount: number): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `Shopify Order #${id} CHF ${amount}`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-07-08T00:00:00Z', location: 'archived', date: '2026-07-04', amount: -amount, currency: 'CHF', vatId: 'CHE-153.004.184', title: { vendor: 'Shopify', what: id } });
  const books = { transactions: [payout('P', { amount: 198.1 })], receipts: [page('1001', 108.1), page('1002', 90)], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const none = noReceiptOfItsOwn(books, context, receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root)), fx);
  const toChf = (a: number) => a;
  assert.equal(searchPairs(books, toChf, () => false, none).byReceipt.get('1001')?.length ?? 0, 0, 'no pair candidate');
  assert.deepEqual(linkReceiptSets(books, { isOpen: () => true, toChf, noReceipt: none }).sets, [], 'no set, though the two add up to it');
  assert.equal(linkReceiptSets(structuredClone(books), { isOpen: () => true, toChf }).sets.length, 1, 'without the provider\'s word they would');
});

// ─── 2. The payout from the clearing account ─────────────────────────────────

test('a payout is booked bank / clearing account without VAT, in code; 6. until the company\'s file names the clearing account it waits for the person, never for a rule or the model', async () => {
  const ws = shop();
  const books = { transactions: [payout('P')], receipts: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const out = await classifyTransactions(books, books.transactions, { fx, context: loadClassifyContext(ws) });
  assert.deepEqual(out.classified, ['P']);
  assert.deepEqual(lines(books.journalEntries), [['P', '2026-07-07', '1021', '1093', 191.75, '']]);
  assert.deepEqual(books.journalEntries[0].by, { kind: 'code', check: 'payoutReport' });

  const bare = shop('');
  const before = { ...books, journalEntries: [] } as Books;
  const asked: string[] = [];
  const held = await classifyTransactions(before, before.transactions, { fx, context: loadClassifyContext(bare), ask: async (prompt: string) => { asked.push(prompt); return '{}'; } } as Parameters<typeof classifyTransactions>[2]);
  assert.deepEqual([held.classified, held.unasked, before.journalEntries, asked], [[], [], [], []], 'nothing booked, the model not asked');
  assert.equal(held.failed[0]?.ref, 'P');
  assert.match(held.failed[0].reason, /Durchlaufkonto fehlt.*knowledge\/suppliers\/shopify\.yaml/);
});

// ─── 2. The sales report ─────────────────────────────────────────────────────

test('code reads an export as it writes it: its separator, quotes, amounts and days', () => {
  assert.deepEqual(csvRows('a;b\n"x;1";"he said ""hi"""\n'), [['a', 'b'], ['x;1', 'he said "hi"']]);
  assert.deepEqual(['1234.50', "1'234.50", '1.234,50', 'CHF 12.00', '-3.20', ''].map(amountOf), [1234.5, 1234.5, 1234.5, 12, -3.2, undefined]);
  assert.deepEqual(['2026-07-03 14:22:10 +0200', '2026-07-03T14:22:10Z', '03.07.2026', '07/03/2026'].map(dayOf), ['2026-07-03', '2026-07-03', '2026-07-03', undefined]);
  assert.deepEqual(recognizeReport(ORDERS, [SHOPIFY]), { provider: 'shopify', kind: 'sales' });
  assert.deepEqual(recognizeReport(FEES, [SHOPIFY]), { provider: 'shopify', kind: 'fees' });
  assert.equal(recognizeReport('Buchungsdatum;Valuta;Betrag;Saldo\n', [SHOPIFY]), undefined, 'a bank\'s CSV is no report');
  const noGateway = ORDERS.split('\n').map((l) => l.split(',').slice(0, -1).join(',')).join('\n');
  assert.deepEqual(readReport(noGateway, 'sales', SHOPIFY.provider), { missing: ['gateway'] }, 'with gateways the column must be there, else no order could be told from one paid elsewhere');
});

test('each order on the clearing account with its own code: a Swiss delivery V81, abroad V0; a domestic order without VAT, one of a filed quarter and a refund without its own day are not booked', () => {
  const read = salesOf(ORDERS);
  assert.equal(read.rows.length, 7, 'the line rows of an order make one');
  const out = bookReport({ journalEntries: [] }, read, ctxOf());
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-1001', '2026-07-03', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-1002', '2026-07-05', '1093', '3200', 90, 'V0'],
    ['SR-shopify-1003', '2026-08-11', '1093', '3200', 54.05, 'V81'],
  ]);
  assert.deepEqual(out.held, [{ order: '1003', why: 'refundDate' }, { order: '1004', why: 'noTax' }], 'a refund is never dated on the order\'s day; a Swiss delivery without VAT is the person\'s');
  assert.equal(out.filed, 1, '#1000 was paid in the filed quarter');
  assert.ok(out.entries.every((e) => e.origin === 'classify' && e.by?.kind === 'code' && e.receipts?.[0] === 'rep'));

  const again = bookReport({ journalEntries: out.entries }, read, ctxOf());
  assert.deepEqual([again.entries, again.known, again.knownRefs], [[], 3, ['SR-shopify-1001', 'SR-shopify-1002', 'SR-shopify-1003']], 'read twice, each order once');
  const changed = bookReport({ journalEntries: out.entries.map((e) => (e.transactionRef === 'SR-shopify-1002' ? { ...e, amount: 85 } : e)) }, read, ctxOf());
  assert.ok(changed.held.some((h) => h.order === '1002' && h.why === 'changed'), 'other figures in the books are named, never booked over');
});

test('3. an order the provider did not collect (PayPal, a test gateway, part gift card) is counted with how it was paid, never booked onto the clearing account', () => {
  const out = bookReport({ journalEntries: [] }, salesOf(ORDERS), ctxOf());
  assert.equal(out.other, 2);
  assert.deepEqual(out.ways, ['PayPal Express Checkout', 'Bogus']);
  assert.ok(!out.entries.some((e) => /100[56]/.test(e.transactionRef)));
  const nov = bookReport({ journalEntries: [] }, salesOf(NOVEMBER), ctxOf({ isClosed: () => false }));
  assert.deepEqual([nov.other, nov.ways], [3, ['PayPal Express Checkout', 'Bogus', 'Shopify Payments + gift_card']]);
  assert.equal(bookReport({ journalEntries: [] }, salesOf(ORDERS), ctxOf({ gateways: undefined })).other, 0, 'a provider whose file names no gateways collects every order');
});

test('5. a refund on its own day: booked when the provider\'s file names the column, also when its sale lies in a filed period; never before its sale', () => {
  const facts = { ...SHOPIFY.provider, reports: { sales: { ...SHOPIFY.provider.reports.sales, refundedAt: ['Refunded at'] } } };
  const csv = [`${head},Refunded at`,
    '#1000,2026-06-28 10:00:00 +0200,CHF,2.43,32.43,CH,10.00,2026-06-28 09:00:00 +0200,Shopify Payments,2026-07-10 08:00:00 +0200',
    '#1003,2026-08-11 10:00:00 +0200,CHF,4.05,54.05,CH,20.00,2026-08-11 09:00:00 +0200,Shopify Payments,2026-08-20 08:00:00 +0200',
    '#1007,2026-08-11 10:00:00 +0200,CHF,4.05,54.05,CH,20.00,2026-08-11 09:00:00 +0200,Shopify Payments,2026-08-01 08:00:00 +0200',
  ].join('\n');
  const out = bookReport({ journalEntries: [] }, salesOf(csv, facts), ctxOf());
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-1000-refund', '2026-07-10', '3200', '1093', 10, '-V81'],
    ['SR-shopify-1003', '2026-08-11', '1093', '3200', 54.05, 'V81'],
    ['SR-shopify-1003-refund', '2026-08-20', '3200', '1093', 20, '-V81'],
    ['SR-shopify-1007', '2026-08-11', '1093', '3200', 54.05, 'V81'],
  ]);
  assert.equal(out.filed, 1, 'the sale of #1000 stays in its filed quarter; its refund paid in July is booked in July');
  assert.deepEqual(out.held, [{ order: '1007', why: 'refundDate' }], 'a refund dated before its sale waits');
});

test('10. a domestic order at the reduced rate its tax shows books the reduced code; a mixed basket waits; Swiss VAT on an export waits, a foreign tax does not', () => {
  const csv = [head,
    row('3001', '2026-07-03', '102.60', '2.60'),
    row('3002', '2026-07-03', '110.70', '5.30'),
    row('3003', '2026-07-03', '108.10', '8.10', 'DE'),
    row('3004', '2026-07-03', '119.00', '19.00', 'DE'),
  ].join('\n');
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf());
  assert.deepEqual(lines(out.entries), [['SR-shopify-3001', '2026-07-03', '1093', '3200', 102.6, 'V26'], ['SR-shopify-3004', '2026-07-03', '1093', '3200', 119, 'V0']]);
  assert.deepEqual(out.held, [{ order: '3002', why: 'rate' }, { order: '3003', why: 'abroadTax' }]);
  assert.deepEqual(bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ codes: { domestic: 'V81', rate: 8.1, abroad: 'V0', negative: '-' } })).held.map((h) => h.order), ['3001', '3002', '3003'], 'a firm whose form takes no reduced code holds it');
});

test('10. a dropped report books the reduced rate with the firm\'s own reduced sale code', () => {
  const ws = shop();
  const done = importSalesReport(ws, Buffer.from([head, row('3201', '2026-12-03', '102.60', '2.60')].join('\n')), 'orders_export.csv');
  assert.ok(done.ok && done.summary.orders === 1);
  assert.deepEqual(lines(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'SR-shopify-3201')), [['SR-shopify-3201', '2026-12-03', '1093', '3200', 102.6, 'V26']]);
});

test('on the agreed basis the order\'s day is the tax point; a firm without codes books gross without one', () => {
  const read = salesOf(ORDERS);
  const agreed = bookReport({ journalEntries: [] }, read, ctxOf({ agreed: true }));
  assert.equal(agreed.entries[0].date, '2026-07-02');
  const plain = bookReport({ journalEntries: [] }, read, ctxOf({ codes: undefined }));
  assert.ok(plain.entries.every((e) => !e.vatCode));
  assert.deepEqual(plain.held, [{ order: '1003', why: 'refundDate' }], 'without codes nothing disagrees; the refund still needs its day');
});

test('the fee report books each fee against the clearing account at the company\'s fee code; one order\'s fees in two currencies are two fees', () => {
  const read = readReport(`${FEES}\n2026-07-03 14:30:00 +0200,charge,#1001,10.00,0.50,9.50,EUR`, 'fees', SHOPIFY.provider);
  if ('missing' in read) throw new Error('columns');
  assert.deepEqual(lines(bookReport({ journalEntries: [] }, read, ctxOf()).entries), [
    ['SF-shopify-1001', '2026-07-03', '6840', '1093', 3.44, 'I0'],
    ['SF-shopify-1002', '2026-07-05', '6840', '1093', 2.91, 'I0'],
    ['SF-shopify-1001-EUR', '2026-07-03', '6840', '1093', 0.5, 'I0'],
  ]);
});

test('a foreign-currency report: each sale at the ESTV daily sell rate of its tax point, the payout at the rate of its day; the EUR clearing account keeps the difference until the year end', async () => {
  const csv = [head, '#3101,2026-07-03 10:00:00 +0200,EUR,8.10,108.10,CH,0.00,2026-07-02 09:00:00 +0200,Shopify Payments'].join('\n');
  const sale = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ clearing: '1094' })).entries[0];
  const r1 = fx.daily('EUR', '2026-07-03');
  assert.ok(r1, 'the rates of July are in the reference file');
  assert.deepEqual([sale.accountDebit, sale.amount, sale.exchangeCurrency, sale.exchangeRate], ['1094', 108.1, 'EUR', r1]);
  const ws = shop('  clearing: "1094"\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
  const tx = payout('PE', { bank: 'Wise', currency: 'EUR', amount: 108.1, date: '2026-07-08' });
  const books = { transactions: [tx], receipts: [], mappings: [], journalEntries: [sale], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  await classifyTransactions(books, [tx], { fx, context: loadClassifyContext(ws) });
  const paid = books.journalEntries.find((e) => e.transactionRef === 'PE')!;
  const r2 = fx.daily('EUR', '2026-07-08')!;
  assert.deepEqual([paid.accountDebit, paid.accountCredit, paid.exchangeCurrency, paid.exchangeRate], ['1023', '1094', 'EUR', r2]);
  const check = clearingCheck({ ...SHOPIFY, provider: { ...SHOPIFY.provider, clearing: '1094' } } as Provider, books, '2026-07-31', 1)!;
  assert.equal(check.currency, 'EUR');
  assert.equal(check.balance, Math.round((108.1 * r1! - 108.1 * r2) * 100) / 100, 'the exchange difference stays on the clearing account');
});

test('4. an order page is linked to its sale, never to the payout; an order name with a dash links too', () => {
  const entries = bookReport({ journalEntries: [] }, salesOf([head, row('A-1002', '2026-07-05', '90.00', '0.00', 'DE')].join('\n')), ctxOf()).entries;
  const books = { receipts: [{ id: 'pg', order: { number: '#A-1002', date: '2026-07-05', currency: 'CHF', gross: 90, shipTo: 'DE', payouts: [], refunds: [] } } as unknown as Receipt], mappings: [] as Books['mappings'], journalEntries: entries };
  const providers = [{ id: 'shopify', provider: { clearing: '1093' } }];
  assert.deepEqual(linkOrdersToSales(books, () => true, providers), [{ receipt: 'pg', sale: 'SR-shopify-A-1002' }]);
  assert.deepEqual(linkOrdersToSales(books, () => true, providers), [], 'once');
});

// ─── The drop: recognised, filed, booked, asked once ─────────────────────────

test('a dropped sales report is filed as a receipt and booked onto the clearing account; the payouts the app booked as sales before are booked again from it', () => {
  const ws = shop();
  const books = loadBooks(ws);
  const old = payout('OLD', { date: '2026-07-07' });
  books.transactions.push(old);
  books.journalEntries.push(asSales(old, 'old'));
  saveBooks(ws, books);
  assert.deepEqual(recognizeCsv(ws, Buffer.from(ORDERS)), { provider: 'shopify', name: 'Shopify', kind: 'sales' });
  const done = importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv');
  assert.ok(done.ok);
  // The demo is filed through Q1, so June's #1000 is booked too; its own Shopify payouts of 5 July and 5 August, booked as sales by its generator, are booked again with OLD: each one's payout days lie in the report's.
  assert.deepEqual([done.summary.orders, done.summary.refunds, done.summary.filed, done.summary.rebooked, done.summary.other, done.summary.held.map((h) => h.why)], [4, 0, 0, 3, 2, ['refundDate', 'noTax']]);
  const after = loadBooks(ws);
  const receipt = after.receipts.find((r) => r.report);
  assert.equal(receipt?.report?.provider, 'shopify');
  assert.equal(receipt?.report?.rebooked?.length, 3, 'the receipt keeps what it booked again, for «Rückgängig»');
  assert.ok(receipt && existsSync(join(ws.paths.root, 'transactional-data', '2026', 'receipts', receipt.filename)), 'the CSV is filed in its year');
  assert.deepEqual(lines(after.journalEntries.filter((e) => e.transactionRef === 'OLD')), [['OLD', '2026-07-07', '1021', '1093', 191.75, '']]);
  assert.equal(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok && loadBooks(ws).journalEntries.length, after.journalEntries.length, 'dropped again, nothing twice');
});

test('1. a payout is booked again only when every order it can pay is booked from a report: one at the edge stays, and the orders it may hold wait', () => {
  const ws = shop();
  const { pa, pb, pc } = november(ws);
  const done = importSalesReport(ws, Buffer.from(NOVEMBER), 'orders_export.csv');
  assert.ok(done.ok);
  assert.equal(done.summary.rebooked, 1);
  assert.deepEqual(done.summary.held, [{ order: '2001', why: 'payout', date: '2026-11-04' }, { order: '2003', why: 'payout', date: '2026-11-25' }], '#2001 may be in the payout of 4.11., #2003 in the one of 25.11.: both stay booked as sales');
  const after = loadBooks(ws);
  const of = (ref: string) => lines(after.journalEntries.filter((e) => e.transactionRef === ref));
  assert.deepEqual(of(pb.ref), [['PB', '2026-11-18', '1021', '1093', 52.5, '']], 'its days, 11. to 18.11., lie in the report');
  assert.deepEqual(of(pa.ref), [['PA', '2026-11-04', '1021', '3200', 100, 'V81']], 'it may pay orders of October, which no report books');
  assert.deepEqual(of(pc.ref), [['PC', '2026-11-25', '1021', '3200', 88, 'V81']], 'it may pay orders after the report\'s last day');
  assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef.startsWith('SR-')).map((e) => e.transactionRef), ['SR-shopify-2002']);
});

test('1. 7. a payout whose days reach into a filed period, or one with an entry in a filed period, is never booked again', () => {
  const ws = shop();
  const p = providersOf(ws).find((x) => x.id === 'shopify')!;
  const early = payout('E', { date: '2026-11-10' });
  const dated = payout('D', { date: '2026-11-20' });
  const free = payout('F', { date: '2026-11-25' });
  const books = {
    transactions: [early, dated, free], receipts: [], mappings: [], bankStatements: [], config: { closedThrough: '2026-11-06' },
    journalEntries: [asSales(early), { ...asSales(dated), date: '2026-11-05', accountDebit: '1093' }, asSales(dated, 'd2'), asSales(free)],
  } as unknown as Books;
  const plan = payoutPlan(books, p, loadClassifyContext(ws), joinSpans([{ from: '2026-11-01', to: '2026-11-30' }]));
  assert.deepEqual([plan.rebook.map((t) => t.ref), plan.kept.map((t) => t.ref)], [['F'], ['E', 'D']]);
});

test('a person\'s booking of a payout stays as she made it, and what it may hold waits', () => {
  const ws = shop();
  const books = loadBooks(ws);
  const mine = payout('MINE', { date: '2026-11-12' });
  books.transactions.push(mine);
  books.journalEntries.push({ ...asSales(mine, 'mine'), origin: 'manual', by: undefined });
  saveBooks(ws, books);
  const done = importSalesReport(ws, Buffer.from(NOVEMBER), 'orders_export.csv');
  assert.ok(done.ok && done.summary.rebooked === 0);
  assert.ok(done.summary.held.some((h) => h.order === '2002' && h.why === 'payout'));
  assert.deepEqual(lines(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'MINE')), [['MINE', '2026-11-12', '1021', '3200', 191.75, 'V81']]);
});

test('4. «Rückgängig» puts back the payouts the report booked again, takes its sales and its order links; one of two overlapping reports leaves the other\'s sales', () => {
  const ws = shop();
  const { pb } = november(ws);
  const books = loadBooks(ws);
  books.receipts.push({ id: 'pg', filename: '20261110-shopify-bestellung-2002.pdf', originalFilename: 'o.pdf', extractedText: 'Shopify Bestellung #2002', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-11T00:00:00Z', location: 'archived', date: '2026-11-10', kind: 'sales-record', order: { number: '#2002', date: '2026-11-10', currency: 'CHF', gross: 54.05, shipTo: 'CH', payouts: [], refunds: [] } });
  saveBooks(ws, books);
  const a = importSalesReport(ws, Buffer.from(NOVEMBER), 'a.csv');
  assert.ok(a.ok && a.summary.proofs === 1);
  const idOf = (file: string) => loadBooks(ws).receipts.find((r) => r.filename === file)!.id;
  const aId = idOf(a.summary.file);
  // B covers 10. to 21.11.: #2002 again and a new order.
  const b = importSalesReport(ws, Buffer.from([head, row('2002', '2026-11-10', '54.05', '4.05'), row('2007', '2026-11-21', '54.05', '4.05')].join('\n')), 'b.csv');
  assert.ok(b.ok && b.summary.known === 1);
  const bId = idOf(b.summary.file);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.transactionRef === 'SR-shopify-2002')?.receipts, [aId, bId].sort(), 'the sale both report is named by both');

  assert.equal(removeSalesReport(ws, aId), true);
  let now = loadBooks(ws);
  assert.deepEqual(now.journalEntries.find((e) => e.transactionRef === 'SR-shopify-2002')?.receipts, [bId], 'B\'s sale stays, with B only');
  assert.deepEqual(lines(now.journalEntries.filter((e) => e.transactionRef === pb.ref)), [['PB', '2026-11-18', '1021', '1093', 52.5, '']], 'B covers its days: it stays booked from the clearing account');
  assert.equal(now.receipts.find((r) => r.id === bId)?.report?.rebooked?.[0]?.ref, 'PB', 'and B keeps the record');

  assert.equal(removeSalesReport(ws, bId), true);
  now = loadBooks(ws);
  assert.equal(now.journalEntries.some((e) => e.transactionRef.startsWith('SR-')), false, '«Rückgängig» takes its bookings back');
  assert.deepEqual(lines(now.journalEntries.filter((e) => e.transactionRef === pb.ref)), [['PB', '2026-11-18', '1021', '3200', 52.5, 'V81']], 'the payout has its booking back, for the next run to book again');
  assert.equal(now.journalEntries.find((e) => e.transactionRef === pb.ref)?.id, `e-${pb.ref}`);
  assert.equal(now.mappings.some((m) => m.receiptId === 'pg'), false, 'the order page\'s link to a sale that is gone goes too');
});

test('the company\'s file lacks the clearing account: the report asks for it once, keeps the answer in that file, and books', () => {
  const ws = shop('  revenue: "3200"\n');
  const first = importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv');
  assert.ok(!first.ok && first.ask?.missing === 'clearing');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '9999' }), { ok: false, refusal: { code: 'unknownAccount', params: { account: '9999' } } });
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '1093' }), { ok: true });
  const file = parse(readFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'utf8')) as { provider: Record<string, unknown> };
  assert.deepEqual(file.provider, { revenue: '3200', clearing: '1093' });
  assert.ok(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok);
  const fees = importSalesReport(shop('  clearing: "1093"\n'), Buffer.from(FEES), 'payment_transactions.csv');
  assert.ok(!fees.ok && fees.ask?.missing === 'fees', 'the fee account is asked for the fee report');
});

test('7. a report that fails on an error is refused in its row with a code; the session is saved and goes on', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  revenue: "3200"\n');
    const accounts = join(api.root, 'master-data', 'accounts.json');
    writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
    // A sealed quarter's entry changed on disk: nothing can be saved (SealBrokenError).
    const file = join(api.root, 'transactional-data', '2026', 'books', 'entries.jsonl');
    const rows = readFileSync(file, 'utf8').split('\n');
    const k = rows.findIndex((l) => l.includes('"date":"2026-01-'));
    rows[k] = rows[k].replace(/"amount":([\d.]+)/, (_m, n: string) => `"amount":${Number(n) + 1}`);
    writeFileSync(file, rows.join('\n'));
    const post = async (path: string, body?: Buffer): Promise<{ status: number; s: DropSession }> => {
      const res = await api.fetch(path, { method: 'POST', body: body ? new Uint8Array(body) : undefined, headers: { 'Content-Type': 'application/octet-stream' } });
      return { status: res.status, s: (await res.json()) as DropSession };
    };
    const { s } = await post('/api/drop');
    const took = await post(`/api/drop/${s.id}/files?name=orders_export.csv`, Buffer.from(NOVEMBER));
    assert.equal(took.status, 200);
    assert.deepEqual(took.s.rows.map((r) => [r.kind, r.state, r.reason]), [['sales-report', 'refused', 'report-failed']]);
    assert.match(took.s.rows[0].message ?? '', /Siegel/);
    const kept = JSON.parse(readFileSync(join(api.root, 'data', 'drop', s.id, 'session.json'), 'utf8')) as DropSession;
    assert.equal(kept.rows[0]?.reason, 'report-failed', 'the session is saved with the refused row');
  } finally {
    await api.stop();
  }
});

test('the match step keeps a payout report\'s figures only when they add up: sales − refunds − fees = paid out', () => {
  const base = { suggestedFilename: '20260731-sumup.pdf', matchedTransactionRefs: [], date: '2026-07-31', description: 'SumUp', amount: 6104.6, currency: 'CHF', confidence: 0.9 };
  assert.deepEqual(parseMatchResult(JSON.stringify({ ...base, payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } }))?.payout, { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 });
  assert.equal(parseMatchResult(JSON.stringify({ ...base, payout: { sales: 1480, refunds: 0, fees: 27.65, paidOut: 1412.35 } }))?.payout, undefined, 'figures that do not add up are no facts');
  assert.equal(parseMatchResult(JSON.stringify(base))?.payout, undefined);
});

test('5. a rule that split a payout into sales and fees (`then.fees`) is refused, saying where it went', () => {
  const facts = { account: () => true, vat: () => 'taken' as const, counterparty: () => true };
  const r = parseRule({ id: 'sumup-umsatz', when: { text: 'SumUp' }, then: { account: '3400', vat: 'V81', fees: { account: '6840', vat: 'I0' } } }, facts);
  assert.deepEqual(r, { ok: false, refusal: { code: 'fees' } });
});

// ─── A card terminal's payout report ─────────────────────────────────────────

/** A demo copy with a card terminal of the company's own (no sales report) and its payout report. */
function terminal(): { ws: Workspace; books: Books; tx: BankTransaction } {
  const ws = shop();
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'terminal.yaml'), 'id: terminal\nname: Terminal AG\nmatch:\n  uid: [ "CHE-111.222.333" ]\n  tx: [ "terminal ag" ]\nprovider:\n  payoutDays: 3\n  clearing: "1093"\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
  const books = loadBooks(ws);
  books.receipts.push({ id: 'po', filename: '20261031-terminal-auszahlung.pdf', originalFilename: 'po.pdf', extractedText: 'Terminal AG CHE-111.222.333 Auszahlung Oktober', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-01T00:00:00Z', location: 'archived', date: '2026-10-31', amount: 1412.35, currency: 'CHF', vatId: 'CHE-111.222.333', payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } });
  const tx = payout('T1', { date: '2026-11-02', amount: 1412.35, description: 'Gutschrift Terminal AG', counterparty: 'Terminal AG' });
  books.transactions.push(tx);
  return { ws, books, tx };
}

test('2. a card terminal\'s payout report books its sales and fees onto the clearing account once, with its payout booked again from there', () => {
  const { ws, books, tx } = terminal();
  // An older rule booked the payout as sales: booked again, the report's sales would otherwise count twice.
  books.journalEntries.push({ ...asSales(tx), by: { kind: 'rule', rule: 'terminal-umsatz' } });
  assert.equal(bookPayoutReports(ws, books, fx), 1);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.receipts?.includes('po'))), [
    ['SR-terminal-po', '2026-10-31', '1093', '3200', 1480, 'V81'],
    ['SR-terminal-po-refund', '2026-10-31', '3200', '1093', 40, '-V81'],
    ['SF-terminal-po', '2026-10-31', '6840', '1093', 27.65, 'I0'],
  ]);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.transactionRef === 'T1')), [['T1', '2026-11-02', '1021', '1093', 1412.35, '']]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'po' && m.transactionRef === 'T1'), 'the report is linked to the payout it states');
  assert.equal(bookPayoutReports(ws, books, fx), 0, 'once');
});

test('2. a payout report books nothing over a payout a person booked, nor for a provider whose sales come from its sales report', () => {
  const { ws, books, tx } = terminal();
  books.journalEntries.push({ ...asSales(tx), origin: 'manual', by: undefined });
  assert.equal(bookPayoutReports(ws, books, fx), 0);
  assert.equal(books.journalEntries.some((e) => e.receipts?.includes('po')), false);
  const shopBooks = loadBooks(shop());
  shopBooks.receipts.push({ id: 'sp', filename: '20260731-shopify-auszahlung.pdf', originalFilename: 'sp.pdf', extractedText: 'Shopify Payments Auszahlung Juli', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-08-01T00:00:00Z', location: 'archived', date: '2026-07-31', amount: 1412.35, currency: 'CHF', vatId: 'CHE-153.004.184', payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } });
  assert.equal(bookPayoutReports(shop(), shopBooks, fx), 0, 'Shopify\'s sales come from its order export only: one source per provider');
});

// ─── 3. The clearing check ───────────────────────────────────────────────────

test('9. the clearing check: the balance at the quarter\'s end, its month ends, and what the provider paid out after it, the most the balance may be', () => {
  assert.deepEqual(monthEnds('2026-09-30', 3), ['2026-07-31', '2026-08-31', '2026-09-30']);
  const p = { ...SHOPIFY, provider: { ...SHOPIFY.provider, clearing: '1093', payoutDays: 5 } } as Provider;
  const e = (id: string, date: string, d: string, c: string, amount: number, ref = id): JournalEntry => ({ id, transactionRef: ref, date, accountDebit: d, accountCredit: c, amount });
  const books = {
    transactions: [payout('P1', { date: '2026-09-10' }), payout('P2', { date: '2026-10-02' }), { ...payout('X', { date: '2026-10-06' }), direction: 'DBIT' as const }],
    journalEntries: [e('s1', '2026-08-30', '1093', '3200', 200, 'SR-shopify-1'), e('s2', '2026-09-29', '1093', '3200', 120, 'SR-shopify-2'), e('p1', '2026-09-10', '1021', '1093', 200, 'P1'), e('p2', '2026-10-02', '1021', '1093', 118, 'P2')],
  };
  const c = clearingCheck(p, books, '2026-09-30', 3)!;
  assert.deepEqual([c.balance, c.months.map((m) => m.balance), c.paidAfter, c.currency], [120, [0, 200, 120], 118, undefined]);
  const early = clearingCheck(p, { ...books, transactions: books.transactions.filter((t) => t.date <= '2026-10-02') }, '2026-09-30', 3)!;
  assert.equal(early.paidAfter, undefined, 'the bank\'s payments through 5 days after the end are not in the books yet');
});
