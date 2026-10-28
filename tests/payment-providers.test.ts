/**
 * Payment providers (#203): a shop platform's or card terminal's payout is a settlement, not a sale.
 * It is no candidate for any receipt (sets, the pair chain, the model's match, order links), needs
 * none, and is booked bank / the provider's clearing account without VAT, in code. The sales come
 * onto the clearing account from the provider's sales report, each order with its own code (Swiss
 * delivery V81 or the reduced rate its tax shows, abroad V0, a refund with its minus on its own day),
 * the fees from its fee report; order documents go with their sale. All of it from the company's
 * cut-over day (`provider.since`) on: before it everything stays as it was booked, and no existing
 * entry is ever booked again. What the books carry from elsewhere after it (an older sale on the
 * clearing account, a payout booked as sales) holds the rows it may be, so no sale counts twice and
 * none is lost: it waits, named, on the report's receipt. At a period's close the review shows the
 * clearing account, its month ends, what the provider paid out after the end (the most the balance
 * may be) and a balance below zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { receiptKnowledge, receiptWait, noReceiptOfItsOwn, settlementAccount } from '../src/booking/receipt-wait.js';
import { clearingCheck, monthEnds, payoutWaitOf, providerOfPayment, type Provider } from '../src/booking/providers.js';
import { amountOf, bookReport, csvRows, dayOf, linkOrdersToSales, paymentFacts, readReport, recognizeReport, type ReportContext } from '../src/booking/sales-report.js';
import { mergeProvider, parseProvider } from '../src/knowledge/provider.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { linkReceiptSets } from '../src/intake/receipt-sets.js';
import { searchPairs } from '../src/intake/pairing.js';
import { bookPayoutReports, bookReportCorrection, HELD_NAMED, importSalesReport, providersOf, recognizeCsv, removeSalesReport, setProviderAccount } from '../src/intake/sales-report-import.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { parseRule } from '../src/booking/rules.js';
import { loadBooks, PERSON, saveBooks, updateSaved, type Books } from '../src/books/store.js';
import { readQuestions } from '../src/questions/store.js';
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

/** The company's Shopify file of the tests: its clearing account, cut-over day, revenue and fees. */
const FILE = (since = '2026-11-01') => `  clearing: "1093"\n  since: ${since}\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n`;

/** A copy of the demo whose Shopify file names its clearing account, cut-over day, revenue and fees, with the clearing accounts in its chart. */
function shop(provider = FILE(), extra = ''): Workspace {
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
  gateways: SHOPIFY.provider.gateways, since: '2026-07-01', from: '2026-07-01',
  isClosed: (d) => d <= '2026-06-30', beforeBooks: () => false, newId: (() => { let i = 0; return () => `e${++i}`; })(),
  texts: { sale: (o, c) => `Shopify, Bestellung #${o}, ${c}`, refund: (o) => `Shopify, Rückerstattung #${o}`, foreignTax: (o, c) => `Shopify, ausländische MWST #${o}, ${c}`, fee: (k) => `Shopify, Gebühren ${k}`, cent: (c, g) => `cent ${c} ${g}`, reason: (k) => k },
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

/** Revenue on 3200 between two days, in the books' currency: what a double count or a lost sale changes. */
const revenueOf = (es: readonly JournalEntry[], from = '2026-11-01', to = '2026-11-30') => Math.round(es.filter((e) => e.date >= from && e.date <= to).reduce((s, e) => s + (e.accountCredit === '3200' ? e.amount : 0) - (e.accountDebit === '3200' ? e.amount : 0), 0) * 100) / 100;
/** The balance of an account over the books' entries from a day on. */
const balanceOf = (es: readonly JournalEntry[], account: string, from = '2026-11-01') => Math.round(es.filter((e) => e.date >= from).reduce((s, e) => s + (e.accountDebit === account ? e.amount : 0) - (e.accountCredit === account ? e.amount : 0), 0) * 100) / 100;
const E = (id: string, ref: string, date: string, d: string, c: string, amount: number, vatCode?: string, over: Partial<JournalEntry> = {}): JournalEntry => ({ id, transactionRef: ref, date, accountDebit: d, accountCredit: c, amount, ...(vatCode ? { vatCode } : {}), origin: 'classify', ...over });
/** The books of `ws` with these payments and entries added. */
function seed(ws: Workspace, txs: BankTransaction[], entries: JournalEntry[]): void {
  const books = loadBooks(ws);
  books.transactions.push(...txs);
  books.journalEntries.push(...entries);
  saveBooks(ws, books);
}
const heldOf = (ws: Workspace) => loadBooks(ws).receipts.find((r) => r.report)?.report?.held ?? [];

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
  const ws = shop(FILE('2026-07-01'));
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
  const stripe = payout('ST', { description: 'Received money from Stripe Example Ltd with reference STRIPE 4711', counterparty: undefined });
  assert.equal(providerOfPayment(stripe, [], loadClassifyContext(shop(FILE('2026-07-01'))).counterparties ?? []), undefined);
  const says = shop(FILE('2026-07-01'), 'match:\n  tx: [ "stripe example" ]\n');
  assert.equal(providerOfPayment(stripe, [], loadClassifyContext(says).counterparties ?? [])?.id, 'shopify');
});

test('the pair chain and the receipt sets link no receipt to a payout: its order pages and its payout document stay unlinked', () => {
  const ws = shop(FILE('2026-07-01'));
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

test('a payout on or after the cut-over day is booked bank / clearing account without VAT, in code; 6. until the company\'s file names the clearing account and the cut-over day it waits for the person, never for a rule or the model', async () => {
  const ws = shop(FILE('2026-07-01'));
  const books = { transactions: [payout('P')], receipts: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const out = await classifyTransactions(books, books.transactions, { fx, context: loadClassifyContext(ws) });
  assert.deepEqual(out.classified, ['P']);
  assert.deepEqual(lines(books.journalEntries), [['P', '2026-07-07', '1021', '1093', 191.75, '']]);
  assert.deepEqual(books.journalEntries[0].by, { kind: 'code', check: 'payoutReport' });

  for (const [file, words] of [['', /Durchlaufkonto fehlt.*knowledge\/suppliers\/shopify\.yaml/], ['  clearing: "1093"\n', /Umstellungstag fehlt.*provider\.since/]] as const) {
    const before = { ...books, journalEntries: [] } as Books;
    const asked: string[] = [];
    const held = await classifyTransactions(before, before.transactions, { fx, context: loadClassifyContext(shop(file)), ask: async (prompt: string) => { asked.push(prompt); return '{}'; } } as Parameters<typeof classifyTransactions>[2]);
    assert.deepEqual([held.classified, held.unasked, before.journalEntries, asked], [[], [], [], []], 'nothing booked, the model not asked');
    assert.equal(held.failed[0]?.ref, 'P');
    assert.match(held.failed[0].reason, words);
  }
});

test('since: a payout before the cut-over day is no provider\'s payout to the app: it is booked like any payment, and one booked so stays as it is', async () => {
  const ws = shop(FILE('2026-07-08'));
  const counterparties = loadClassifyContext(ws).counterparties ?? [];
  assert.equal(providerOfPayment(payout('P', { date: '2026-07-07' }), [], counterparties), undefined, 'the day before');
  assert.equal(providerOfPayment(payout('P', { date: '2026-07-08' }), [], counterparties)?.id, 'shopify', 'the day itself');
  const books = { transactions: [payout('P', { date: '2026-07-07' })], receipts: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const out = await classifyTransactions(books, books.transactions, { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.unasked, books.journalEntries], [[], ['P'], []], 'without a model it waits as any payment does: no clearing account, nothing booked by code');
  assert.match((parseProvider({ since: 'soon' }) as { problem: string }).problem, /provider\.since must be a day/);
  assert.deepEqual(parseProvider({ since: new Date('2026-10-01T00:00:00Z') }), { provider: { reports: {}, since: '2026-10-01' } }, 'an unquoted day in YAML');
  assert.match((mergeProvider({ since: '2026-10-01' }, undefined, true) as { problem: string }).problem, /one company's chart/, 'the cut-over day is the company\'s');
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

test('each order on the clearing account with its own code: a Swiss delivery V81, abroad V0; a domestic order without VAT, one of a filed quarter and a refunded order whose refund has no day are not booked', () => {
  const read = salesOf(ORDERS);
  assert.equal(read.rows.length, 7, 'the line rows of an order make one');
  const out = bookReport({ journalEntries: [] }, read, ctxOf());
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-1001', '2026-07-03', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-1002', '2026-07-05', '1093', '3200', 90, 'V0'],
  ]);
  assert.deepEqual(out.held, [{ order: '1003', why: 'refundDate' }, { order: '1004', why: 'noTax' }], 'a refund is never dated on the order\'s day, and its sale waits with it (#214); a Swiss delivery without VAT is the person\'s');
  assert.equal(out.filed, 1, '#1000 was paid in the filed quarter');
  assert.ok(out.entries.every((e) => e.origin === 'classify' && e.by?.kind === 'code' && e.receipts?.[0] === 'rep'));

  const again = bookReport({ journalEntries: out.entries }, read, ctxOf());
  assert.deepEqual([again.entries, again.known, again.knownRefs], [[], 2, ['SR-shopify-1001', 'SR-shopify-1002']], 'read twice, each order once');
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
  ]);
  assert.equal(out.filed, 1, 'the sale of #1000 stays in its filed quarter; its refund paid in July is booked in July');
  assert.deepEqual(out.held, [{ order: '1007', why: 'refundDate' }], 'a refund dated before its sale waits, its sale with it');
});

test('10. a domestic order at the reduced rate its tax shows books the reduced code; a mixed basket waits; Swiss VAT on an export waits; a foreign tax goes onto its own account', () => {
  const csv = [head,
    row('3001', '2026-07-03', '102.60', '2.60'),
    row('3002', '2026-07-03', '110.70', '5.30'),
    row('3003', '2026-07-03', '108.10', '8.10', 'DE'),
    row('3004', '2026-07-03', '119.00', '19.00', 'DE'),
  ].join('\n');
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ foreignTax: '2201' }));
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-3001', '2026-07-03', '1093', '3200', 102.6, 'V26'],
    ['SR-shopify-3004', '2026-07-03', '1093', '3200', 100, 'V0'],
    ['SR-shopify-3004', '2026-07-03', '1093', '2201', 19, ''],
  ]);
  assert.deepEqual(out.held, [{ order: '3002', why: 'rate' }, { order: '3003', why: 'abroadTax' }]);
  assert.deepEqual(bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ codes: { domestic: 'V81', rate: 8.1, abroad: 'V0', negative: '-' }, foreignTax: '2201' })).held.map((h) => h.order), ['3001', '3002', '3003'], 'a firm whose form takes no reduced code holds it');
});

// ─── Foreign VAT on an export (#206) ─────────────────────────────────────────

/** Exports with a refund column of their own day: Germany 19 %, France 20 %, a Swiss rate abroad, no tax, Switzerland. */
const EXPORTS_FACTS = { ...SHOPIFY.provider, reports: { sales: { ...SHOPIFY.provider.reports.sales, refundedAt: ['Refunded at'] } } };
const exportRow = (order: string, total: string, tax: string, country: string, refunded = '0.00', refundedAt = '') => `#${order},2026-07-10 10:00:00 +0200,CHF,${tax},${total},${country},${refunded},2026-07-10 09:00:00 +0200,Shopify Payments,${refundedAt}`;
const EXPORTS = [`${head},Refunded at`,
  exportRow('4001', '119.00', '19.00', 'DE'),
  exportRow('4002', '240.00', '40.00', 'FR', '30.00', '2026-07-20 08:00:00 +0200'),
  exportRow('4003', '108.10', '8.10', 'AT'),
  exportRow('4004', '75.00', '0.00', 'US'),
  exportRow('4005', '64.00', '', 'JP'),
  exportRow('4006', '54.05', '4.05', 'CH'),
].join('\n');
const exportsOf = () => salesOf(EXPORTS, EXPORTS_FACTS);

test('#206 an export with a foreign VAT: the net at the export code onto revenue, the tax onto the company\'s account without a code; a refund split in the sale\'s share, the minus on the net', () => {
  const out = bookReport({ journalEntries: [] }, exportsOf(), ctxOf({ foreignTax: '2201' }));
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-4001', '2026-07-10', '1093', '3200', 100, 'V0'],
    ['SR-shopify-4001', '2026-07-10', '1093', '2201', 19, ''],
    ['SR-shopify-4002', '2026-07-10', '1093', '3200', 200, 'V0'],
    ['SR-shopify-4002', '2026-07-10', '1093', '2201', 40, ''],
    // 30.00 × 40 / 240 = 5.00 back off the foreign tax, 25.00 off the export.
    ['SR-shopify-4002-refund', '2026-07-20', '3200', '1093', 25, '-V0'],
    ['SR-shopify-4002-refund', '2026-07-20', '2201', '1093', 5, ''],
    ['SR-shopify-4004', '2026-07-10', '1093', '3200', 75, 'V0'],
    ['SR-shopify-4005', '2026-07-10', '1093', '3200', 64, 'V0'],
    ['SR-shopify-4006', '2026-07-10', '1093', '3200', 54.05, 'V81'],
  ]);
  assert.deepEqual(out.held, [{ order: '4003', why: 'abroadTax' }], 'Swiss VAT on an export still waits as it did');
  assert.deepEqual([out.orders, out.refunds], [5, 1]);
  assert.equal(out.links.filter((m) => m.transactionRef === 'SR-shopify-4001').length, 1, 'one link per sale, however many lines');
  // The clearing account takes the whole gross less the refund: what the provider pays out.
  assert.equal(balanceOf(out.entries, '1093', '2026-07-01'), 119 + 240 - 30 + 75 + 64 + 54.05);
  assert.equal(balanceOf(out.entries, '2201', '2026-07-01'), -(19 + 40 - 5), 'the foreign tax owed abroad, none of it revenue');
});

test('#206 a refund of an export with a foreign VAT is split to the cent, the rest on the export', () => {
  const csv = [`${head},Refunded at`, exportRow('4101', '119.00', '19.00', 'DE', '30.00', '2026-07-21 08:00:00 +0200')].join('\n');
  const out = bookReport({ journalEntries: [] }, salesOf(csv, EXPORTS_FACTS), ctxOf({ foreignTax: '2201' }));
  // 30.00 × 19 / 119 = 4.789… → 4.79; 30.00 − 4.79 = 25.21.
  assert.deepEqual(lines(out.entries.filter((e) => e.transactionRef.endsWith('-refund'))), [
    ['SR-shopify-4101-refund', '2026-07-21', '3200', '1093', 25.21, '-V0'],
    ['SR-shopify-4101-refund', '2026-07-21', '2201', '1093', 4.79, ''],
  ]);
});

test('#206 without the company\'s account for foreign tax an export with a foreign VAT waits, its refund with it; never booked gross at the export code', () => {
  const out = bookReport({ journalEntries: [] }, exportsOf(), ctxOf());
  assert.deepEqual(out.held, [{ order: '4001', why: 'foreignTax' }, { order: '4002', why: 'foreignTax' }, { order: '4003', why: 'abroadTax' }]);
  assert.ok(!out.entries.some((e) => /SR-shopify-400[123]/.test(e.transactionRef)), 'nothing of them booked');
  assert.deepEqual(lines(out.entries.filter((e) => /400[45]/.test(e.transactionRef))), [
    ['SR-shopify-4004', '2026-07-10', '1093', '3200', 75, 'V0'],
    ['SR-shopify-4005', '2026-07-10', '1093', '3200', 64, 'V0'],
  ], 'an export without tax, or without a tax column, stays V0 on the gross');
});

test('#206 a report dropped again books each export once; one whose figures changed waits as changed; an export booked gross at V0 before stays as booked', () => {
  const ctx = () => ctxOf({ foreignTax: '2201' });
  const first = bookReport({ journalEntries: [] }, exportsOf(), ctx());
  const again = bookReport({ journalEntries: first.entries }, exportsOf(), ctx());
  assert.deepEqual(again.entries, [], 'read twice, nothing booked again');
  assert.deepEqual(again.knownRefs, ['SR-shopify-4001', 'SR-shopify-4002', 'SR-shopify-4002-refund', 'SR-shopify-4004', 'SR-shopify-4005', 'SR-shopify-4006']);
  assert.deepEqual(again.held, [{ order: '4003', why: 'abroadTax' }]);
  const edited = EXPORTS.replace('#4001,2026-07-10 10:00:00 +0200,CHF,19.00,119.00', '#4001,2026-07-10 10:00:00 +0200,CHF,20.00,120.00');
  const changed = bookReport({ journalEntries: first.entries }, salesOf(edited, EXPORTS_FACTS), ctx());
  assert.deepEqual(changed.held.filter((h) => h.order === '4001'), [{ order: '4001', why: 'changed' }]);
  assert.ok(!changed.entries.some((e) => e.transactionRef === 'SR-shopify-4001'));
  const gross = [E('old', 'SR-shopify-4001', '2026-07-10', '1093', '3200', 119, 'V0')];
  const old = bookReport({ journalEntries: gross }, exportsOf(), ctx());
  assert.deepEqual([old.held.filter((h) => h.order === '4001'), old.entries.filter((e) => e.transactionRef === 'SR-shopify-4001')], [[], []], 'the gross the app booked before this fix is known as booked, never booked again');
  assert.ok(old.knownRefs.includes('SR-shopify-4001'));
  assert.deepEqual(bookReport({ journalEntries: gross }, exportsOf(), ctxOf()).held.filter((h) => h.order === '4001'), [], 'known so without the account for foreign tax too');
});

test('#206 an export booked gross at V0 before, in a filed quarter: known, and its refund paid in the open period is booked as the sale was, gross at -V0', () => {
  const csv = [`${head},Refunded at`, `#4101,2026-06-10 10:00:00 +0200,CHF,19.00,119.00,DE,30.00,2026-06-10 09:00:00 +0200,Shopify Payments,2026-07-21 08:00:00 +0200`].join('\n');
  const filed = [E('old', 'SR-shopify-4101', '2026-06-10', '1093', '3200', 119, 'V0')];
  const out = bookReport({ journalEntries: filed }, salesOf(csv, EXPORTS_FACTS), ctxOf({ foreignTax: '2201' }));
  assert.deepEqual(out.held, [], 'nothing held: the filed sale is no change to resolve');
  assert.deepEqual(lines(out.entries), [['SR-shopify-4101-refund', '2026-07-21', '3200', '1093', 30, '-V0']], 'no tax share off an account the sale never credited');
  assert.deepEqual(bookReport({ journalEntries: [...filed, ...out.entries] }, salesOf(csv, EXPORTS_FACTS), ctxOf({ foreignTax: '2201' })).entries, [], 'dropped again: nothing booked again');
});

test('#206 an entry from elsewhere that booked an export the old way (its gross at V0, naming no order, on its day) holds it; one naming the order with the net books it', () => {
  const csv = (day: string) => salesOf([head, row('1975', day, '119.00', '19.00', 'DE')].join('\n'));
  const ctx = (entries: JournalEntry[]) => ctxOf({ foreignTax: '2201', since: '2026-11-01', from: '2026-10-25', legacy: { entries } });
  const gross = bookReport({ journalEntries: [] }, csv('2026-10-30'), ctx([E('o', 'OLD-1', '2026-10-30', '1093', '3200', 119, 'V0')]));
  assert.deepEqual([gross.orders, gross.held, gross.entries], [0, [{ order: '1975', why: 'legacy' }], []], 'never 100 at V0 and 19 booked again beside the gross');
  const net = bookReport({ journalEntries: [] }, csv('2026-11-03'), ctx([E('o', 'M-1', '2026-11-03', '1093', '3200', 100, 'V0', { description: 'Shopify #1975' })]));
  assert.deepEqual([net.orders, net.known, net.held, net.entries], [0, 1, [], []], 'a hand booking naming the order with the net is its booking');
});

test('#206 a domestic sale the books carry beside a person\'s Storno and rebooking of it is known, never held as changed', () => {
  const es = [E('a', 'SR-shopify-2001', '2026-11-02', '1093', '3200', 108.1, 'V81'), E('b', 'SR-shopify-2001', '2026-11-05', '3200', '1093', 108.1, '-V81', { origin: 'manual' }), E('c', 'SR-shopify-2001', '2026-11-05', '1093', '3200', 108.1, 'V81', { origin: 'manual' })];
  const out = bookReport({ journalEntries: es }, salesOf([head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), ctxOf());
  assert.deepEqual([out.known, out.held, out.entries], [1, [], []]);
});

test('#206 the company\'s file names the account for foreign tax; the app\'s file may not; a dropped report books with it and refuses an account the chart lacks', () => {
  assert.equal((parseProvider({ foreignTax: '2201' }) as { provider: { foreignTax?: string } }).provider.foreignTax, '2201');
  assert.match((parseProvider({ foreignTax: '' }) as { problem: string }).problem, /provider\.foreignTax must be an account number/);
  assert.match((mergeProvider({ foreignTax: '2201' }, undefined, true) as { problem: string }).problem, /one company's chart/);
  const csv = Buffer.from([head, row('4201', '2026-12-03', '119.00', '19.00', 'DE')].join('\n'));
  const ws = shop(`${FILE()}  foreignTax: "2201"\n`);
  const done = importSalesReport(ws, csv, 'orders_export.csv');
  assert.ok(done.ok && done.summary.orders === 1);
  assert.deepEqual(lines(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'SR-shopify-4201')).sort((x, y) => String(x[3]).localeCompare(String(y[3]))), [
    ['SR-shopify-4201', '2026-12-03', '1093', '2201', 19, ''],
    ['SR-shopify-4201', '2026-12-03', '1093', '3200', 100, 'V0'],
  ]);
  const without = shop();
  assert.ok(importSalesReport(without, csv, 'orders_export.csv').ok);
  assert.deepEqual(heldOf(without), [{ order: '4201', why: 'foreignTax' }], 'kept on the report\'s receipt with why');
  const unknown = importSalesReport(shop(`${FILE()}  foreignTax: "2299"\n`), csv, 'orders_export.csv');
  assert.ok(!unknown.ok && /2299/.test(unknown.message));
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
  const ws = shop('  clearing: "1094"\n  since: 2026-07-01\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
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

test('a dropped sales report is filed as a receipt and books the orders from the cut-over day on; one a payout before the day may have paid waits, older ones are counted, and that payout stays as it was booked', () => {
  const ws = shop();
  const old = payout('OLD', { date: '2026-10-29', amount: 54.05 });
  seed(ws, [old], [asSales(old, 'old')]);
  assert.deepEqual(recognizeCsv(ws, Buffer.from(NOVEMBER)), { provider: 'shopify', name: 'Shopify', kind: 'sales' });
  const csv = `${NOVEMBER}\n${row('1999', '2026-10-28', '54.05', '4.05')}\n${row('1990', '2026-10-20', '54.05', '4.05')}`;
  const done = importSalesReport(ws, Buffer.from(csv), 'orders_export.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.beforeSince, done.summary.since, done.summary.other, done.summary.reach, done.summary.held], [3, 1, '2026-11-01', 3, '2026-10-25', [{ order: '1999', why: 'legacy' }]], '#1999 of 28.10. may be in the payout of 29.10., booked as sales: it waits, never booked twice; #1990 lies before 1.11. less 7 payout days');
  const after = loadBooks(ws);
  assert.deepEqual(lines(after.journalEntries.filter((e) => e.transactionRef.startsWith('SR-'))).sort(), [
    ['SR-shopify-2001', '2026-11-02', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-2002', '2026-11-10', '1093', '3200', 54.05, 'V81'],
    ['SR-shopify-2003', '2026-11-20', '1093', '3200', 90, 'V0'],
  ]);
  assert.deepEqual(lines(after.journalEntries.filter((e) => e.transactionRef === 'OLD')), [['OLD', '2026-10-29', '1021', '3200', 54.05, 'V81']], 'untouched');
  const receipt = after.receipts.find((r) => r.report);
  assert.ok(receipt && existsSync(join(ws.paths.root, 'transactional-data', '2026', 'receipts', receipt.filename)), 'the CSV is filed in its year');
  assert.deepEqual(receipt?.report?.held, [{ order: '1999', why: 'legacy' }], 'kept for the person');
  assert.equal(importSalesReport(ws, Buffer.from(csv), 'orders_export.csv').ok && loadBooks(ws).journalEntries.length, after.journalEntries.length, 'dropped again, nothing twice');
});

// ─── The cut-over: sales collected before the day and paid out after it ──────

/** The SR- entries of the books, per ref: a double count shows as two. */
const reportRefs = (es: readonly JournalEntry[]) => es.filter((e) => e.transactionRef.startsWith('SR-')).map((e) => e.transactionRef).sort();

test('cut-over a. the old way per order on the clearing account up to the day: an order of since−2 paid out on since+3 is booked once by the report; the old ones are not booked again', () => {
  const ws = shop();
  const p0 = payout('P0', { date: '2026-10-29', amount: 30 });
  const p1 = payout('P1', { date: '2026-11-04', amount: 94.05 });
  seed(ws, [p0, p1], [
    E('o1', 'SHOPIFY-1995', '2026-10-26', '1093', '3200', 30, 'V81'), E('o2', 'SHOPIFY-1996', '2026-10-28', '1093', '3200', 40, 'V81'),
    E('p0', 'P0', '2026-10-29', '1021', '1093', 30), E('p1', 'P1', '2026-11-04', '1021', '1093', 94.05),
  ]);
  const done = importSalesReport(ws, Buffer.from([head, row('1995', '2026-10-26', '30.00', '2.25'), row('1996', '2026-10-28', '40.00', '3.00'), row('1997', '2026-10-30', '54.05', '4.05'), row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.known, done.summary.beforeSince, done.summary.held], [2, 2, 0, []], 'the old entries name their orders: known, not held');
  const es = loadBooks(ws).journalEntries;
  assert.deepEqual(reportRefs(es), ['SR-shopify-1997', 'SR-shopify-2001'], '#1997 once, the old orders not again');
  assert.equal(revenueOf(es, '2026-10-25'), 232.15, 'every sale once: no double count, no lost sale');
  assert.equal(balanceOf(es, '1093', '2026-10-25'), 108.1, 'the clearing account holds only #2001, not paid out yet');
  assert.deepEqual(lines(es.filter((e) => e.transactionRef === 'SR-shopify-1997')), [['SR-shopify-1997', '2026-10-30', '1093', '3200', 54.05, 'V81']], 'dated by its own tax point, before the cut-over day');
});

test('cut-over b. a payout booked as sales the old way on since−1 holds the orders before its day; an order of since−1 paid out on since+2 is booked', () => {
  const ws = shop();
  const old = payout('PG', { date: '2026-10-31', amount: 110 });
  const next = payout('PN', { date: '2026-11-02', amount: 20 });
  seed(ws, [old, next], [asSales(old, 'pg'), E('pn', 'PN', '2026-11-02', '1021', '1093', 20)]);
  const done = importSalesReport(ws, Buffer.from([head, row('1981', '2026-10-27', '50.00', '3.75'), row('1982', '2026-10-30', '60.00', '4.50'), row('1983', '2026-10-31', '20.00', '1.50')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.held], [1, [{ order: '1981', why: 'legacy' }, { order: '1982', why: 'legacy' }]]);
  const es = loadBooks(ws).journalEntries;
  assert.deepEqual(reportRefs(es), ['SR-shopify-1983']);
  assert.equal(revenueOf(es, '2026-10-25'), 110 + 20, 'the old payout\'s 110 as booked, #1983 once');
  assert.equal(balanceOf(es, '1093', '2026-10-25'), 0, 'the first payout after the day comes out even');
  assert.deepEqual(lines(es.filter((e) => e.transactionRef === 'PG')), [['PG', '2026-10-31', '1021', '3200', 110, 'V81']], 'never booked again');

  // A payout of those days not booked yet may still be booked as sales: what it may pay waits too.
  const open = shop();
  seed(open, [old, next], [E('pn', 'PN', '2026-11-02', '1021', '1093', 20)]);
  const waits = importSalesReport(open, Buffer.from([head, row('1982', '2026-10-30', '60.00', '4.50'), row('1983', '2026-10-31', '20.00', '1.50')].join('\n')), 'o.csv');
  assert.ok(waits.ok);
  assert.deepEqual([waits.summary.orders, waits.summary.held], [1, [{ order: '1982', why: 'legacy' }]]);
});

test('cut-over c. an order more than the payout days before the day is counted, never booked; the company\'s payout days reach further', () => {
  const csv = [head, row('1970', '2026-10-22', '54.05', '4.05'), row('2001', '2026-11-02', '108.10', '8.10')].join('\n');
  const ws = shop();
  const done = importSalesReport(ws, Buffer.from(csv), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.beforeSince, done.summary.reach], [1, 1, '2026-10-25']);
  assert.deepEqual(reportRefs(loadBooks(ws).journalEntries), ['SR-shopify-2001']);
  const longer = shop(`${FILE()}  payoutDays: 14\n`);
  const reached = importSalesReport(longer, Buffer.from(csv), 'o.csv');
  assert.ok(reached.ok);
  assert.deepEqual([reached.summary.orders, reached.summary.beforeSince, reached.summary.reach], [2, 0, '2026-10-18']);
});

test('cut-over d. a row of a filed period before the day is never booked, whatever the payout days; a refund of the open period is', () => {
  const csv = [head, row('1960', '2026-06-28', '54.05', '4.05'), row('1961', '2026-07-01', '20.00', '1.50')].join('\n');
  const read = salesOf(csv);
  read.rows[0].refunded = 10;
  read.rows[0].refundedAt = '2026-07-04';
  const out = bookReport({ journalEntries: [] }, read, ctxOf({ since: '2026-07-03', from: '2026-06-26' }));
  assert.equal(out.filed, 1);
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-1960-refund', '2026-07-04', '3200', '1093', 10, '-V81'],
    ['SR-shopify-1961', '2026-07-01', '1093', '3200', 20, 'V81'],
  ]);
});

test('cut-over e. the clearing check right after the first payout from the clearing account: even, never below zero', () => {
  const ws = shop();
  const old = payout('PG', { date: '2026-10-30', amount: 50 });
  const first = payout('PN', { date: '2026-11-03', amount: 128.1 });
  const later = { ...payout('X', { date: '2026-11-12', amount: 5 }), direction: 'DBIT' as const };
  seed(ws, [old, first, later], [asSales(old, 'pg'), E('pn', 'PN', '2026-11-03', '1021', '1093', 128.1)]);
  const done = importSalesReport(ws, Buffer.from([head, row('1981', '2026-10-28', '50.00', '3.75'), row('1983', '2026-10-31', '20.00', '1.50'), row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.held], [2, [{ order: '1981', why: 'legacy' }]]);
  const p = providersOf(ws).find((x) => x.id === 'shopify')!;
  const books = loadBooks(ws);
  const right = clearingCheck(p, books, '2026-11-03')!;
  assert.deepEqual([right.balance, right.below], [0, undefined], 'the payout of 3.11. pays #1983 and #2001, both on the account');
  const day = clearingCheck(p, books, '2026-10-31')!;
  assert.deepEqual([day.balance, day.below, day.paidAfter], [20, undefined, 128.1], 'on the eve: #1983 waits for its payout, within what was paid after');
});

test('A. an older per-order sale on the clearing account (SHOPIFY-<n>) books its order: known, never booked again nor held; one with another amount holds it, named on the receipt', () => {
  const ws = shop();
  const p = payout('PB', { date: '2026-11-18', amount: 54.05 });
  seed(ws, [p], [E('s1', 'SHOPIFY-2002', '2026-11-10', '1093', '3200', 54.05, 'V81', { origin: undefined }), E('pb', 'PB', '2026-11-18', '1021', '1093', 54.05)]);
  const before = revenueOf(loadBooks(ws).journalEntries);
  const csv = [head, row('2002', '2026-11-10', '54.05', '4.05'), row('2010', '2026-11-25', '20.00', '1.50')].join('\n');
  const done = importSalesReport(ws, Buffer.from(csv), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.known, done.summary.held], [1, 1, []]);
  const es = loadBooks(ws).journalEntries;
  assert.equal(revenueOf(es), before + 20, '#2002 counted once (its old entry), #2010 booked: no double count, no lost sale');
  assert.equal(balanceOf(es, '1093'), 20, 'the clearing account holds only what is unpaid');
  assert.deepEqual(heldOf(ws), [], 'nothing for the person');

  const other = shop();
  seed(other, [p], [E('s1', 'SHOPIFY-2002', '2026-11-10', '1093', '3200', 50, 'V81', { origin: undefined }), E('pb', 'PB', '2026-11-18', '1021', '1093', 54.05)]);
  const differs = importSalesReport(other, Buffer.from(csv), 'o.csv');
  assert.ok(differs.ok);
  assert.deepEqual([differs.summary.orders, differs.summary.held], [1, [{ order: '2002', why: 'legacy' }]], 'the person decides');
  assert.deepEqual(heldOf(other), [{ order: '2002', why: 'legacy' }], 'kept on the receipt for the person');
});

test('B. older sales on the clearing account that name no order hold every order up to their day; later orders are booked', () => {
  const ws = shop();
  const p = payout('PX', { date: '2026-11-18', amount: 108.1 });
  seed(ws, [p], [E('o1', 'PX', '2026-11-09', '1093', '3200', 54.05, 'V81'), E('o2', 'PX', '2026-11-12', '1093', '3200', 54.05, 'V81'), E('o3', 'PX', '2026-11-18', '1021', '1093', 108.1)]);
  const before = revenueOf(loadBooks(ws).journalEntries);
  const done = importSalesReport(ws, Buffer.from([head, row('3002', '2026-11-11', '54.05', '4.05'), row('3003', '2026-11-30', '20.00', '1.50')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.held], [1, [{ order: '3002', why: 'legacy' }]]);
  const es = loadBooks(ws).journalEntries;
  assert.equal(revenueOf(es), before + 20, '#3002 may be one of the old entries: it waits, never booked twice; #3003 is booked');
  assert.deepEqual(lines(es.filter((e) => e.transactionRef === 'PX')).length, 3, 'the old entries stay as they are');
});

test('C. a payout a person booked as sales after the cut-over day holds what it may pay (every row up to its day); later orders are booked; her booking stays', () => {
  const ws = shop();
  const p = payout('MP', { date: '2026-11-25', amount: 54.05 });
  seed(ws, [p], [E('m1', 'MP', '2026-11-25', '1021', '3200', 54.05, 'V81', { origin: 'manual' })]);
  const before = revenueOf(loadBooks(ws).journalEntries);
  const done = importSalesReport(ws, Buffer.from([head, row('2002', '2026-11-10', '54.05', '4.05'), row('2009', '2026-11-28', '10.00', '0.75')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual(done.summary.held, [{ order: '2002', why: 'legacy' }]);
  const es = loadBooks(ws).journalEntries;
  assert.equal(revenueOf(es), before + 10, '#2002 is in her payout: counted once; #2009 after it is booked');
  assert.deepEqual(lines(es.filter((e) => e.transactionRef === 'MP')), [['MP', '2026-11-25', '1021', '3200', 54.05, 'V81']]);
});

test('D. a partial export beside a payout the AI booked as sales: what that payout may hold waits, the rest is booked, the payout stays', () => {
  const ws = shop();
  const p = payout('PF', { date: '2026-11-18', amount: 300 });
  seed(ws, [p], [E('f1', 'PF', '2026-11-18', '1021', '3200', 300, 'V81', { by: { kind: 'model', model: 'm' } })]);
  const done = importSalesReport(ws, Buffer.from([head, row('4001', '2026-11-01', '54.05', '4.05'), row('4002', '2026-11-30', '54.05', '4.05')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.held], [1, [{ order: '4001', why: 'legacy' }]]);
  const es = loadBooks(ws).journalEntries;
  assert.equal(revenueOf(es), 300 + 54.05, 'the payout\'s 300 as booked, #4002 once; #4001 waits');
  assert.deepEqual(lines(es.filter((e) => e.transactionRef === 'PF')), [['PF', '2026-11-18', '1021', '3200', 300, 'V81']], 'never booked again');
});

test('G. fee report and sales report in either order book the same: no fee lost, none twice; beside a payout booked as sales the fees it may hold wait', async () => {
  const fees = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-12 10:00:00 +0100,charge,#8001,108.10,3.44,104.66,CHF'].join('\n');
  const sales = [head, row('8001', '2026-11-12', '108.10', '8.10'), row('8002', '2026-11-30', '10.00', '0.75')].join('\n');
  const run = async (order: Array<[string, string]>) => {
    const ws = shop();
    const p = payout('PG', { date: '2026-11-18', amount: 104.66 });
    const books = loadBooks(ws);
    books.transactions.push(p);
    await classifyTransactions(books, [p], { fx, context: loadClassifyContext(ws) });
    saveBooks(ws, books);
    for (const [csv, name] of order) assert.ok(importSalesReport(ws, Buffer.from(csv), name).ok);
    return loadBooks(ws).journalEntries;
  };
  const a = await run([[fees, 'fees.csv'], [sales, 'o.csv']]);
  const b = await run([[sales, 'o.csv'], [fees, 'fees.csv']]);
  const shape = (es: readonly JournalEntry[]) => lines(es.filter((e) => e.transactionRef.startsWith('S') || e.transactionRef === 'PG')).sort();
  assert.deepEqual(shape(a), shape(b), 'the order of the drops does not matter');
  assert.deepEqual(shape(a), [
    ['PG', '2026-11-18', '1021', '1093', 104.66, ''],
    ['SF-shopify-8001', '2026-11-12', '6840', '1093', 3.44, 'I0'],
    ['SR-shopify-8001', '2026-11-12', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-8002', '2026-11-30', '1093', '3200', 10, 'V81'],
  ]);
  assert.equal(balanceOf(a, '1093'), 10, 'sale less fee less payout: only #8002 is unpaid');

  const ws = shop();
  const p = payout('PG', { date: '2026-11-18', amount: 104.66 });
  seed(ws, [p], [E('pg', 'PG', '2026-11-18', '1021', '3200', 104.66, 'V81', { by: { kind: 'model', model: 'm' } })]);
  const f = importSalesReport(ws, Buffer.from(fees), 'fees.csv');
  assert.ok(f.ok && f.summary.fees === 0);
  assert.deepEqual(f.summary.held, [{ order: '8001', why: 'legacy' }], 'the payout booked as sales holds the fee it nets');
});

// ─── Refund days and test-mode orders from the payments report (#214) ───────

/** A November export with refunds, the order export's own refund column absent (Shopify's has none). */
const refundRow = (order: string, day: string, total: string, tax: string, refunded: string, country = 'CH') => `#${order},${day} 10:00:00 +0100,CHF,${tax},${total},${country},${refunded},${day} 09:00:00 +0100,Shopify Payments`;
const REFUNDED = [head,
  refundRow('9001', '2026-11-03', '108.10', '8.10', '108.10'),
  refundRow('9002', '2026-11-04', '119.00', '19.00', '30.00', 'DE'),
  refundRow('9003', '2026-11-05', '54.05', '4.05', '20.00'),
  refundRow('9004', '2026-11-06', '54.05', '4.05', '54.05'),
  refundRow('9005', '2026-11-07', '54.05', '4.05', '0.00'),
  refundRow('9006', '2026-11-08', '32.40', '2.40', '0.00'),
].join('\n');
/** Shopify Payments' transactions export of those days: a charge per order it collected, a refund row on the day the money went back; #9005 has none (a test-mode order). */
const PAYMENTS = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency,Payout ID',
  '2026-11-03 10:00:00 +0100,charge,#9001,108.10,3.44,104.66,CHF,P1',
  '2026-11-04 10:00:00 +0100,charge,#9002,119.00,3.75,115.25,CHF,P1',
  '2026-11-05 10:00:00 +0100,charge,#9003,54.05,1.87,52.18,CHF,P1',
  '2026-11-06 10:00:00 +0100,charge,#9004,54.05,1.87,52.18,CHF,P1',
  '2026-11-08 10:00:00 +0100,charge,#9006,32.40,1.24,31.16,CHF,P1',
  '2026-11-09 10:00:00 +0100,refund,#9001,-108.10,0.00,-108.10,CHF,P2',
  '2026-11-12 10:00:00 +0100,refund,#9002,-30.00,0.00,-30.00,CHF,P2',
].join('\n');
const paymentsOf = (csv: string, facts: Provider['provider'] = SHOPIFY.provider) => {
  const read = readReport(csv, 'fees', facts);
  if ('missing' in read || read.kind !== 'fees') throw new Error(`columns: ${JSON.stringify(read)}`);
  return paymentFacts([read.payments]);
};
const NOV = { isClosed: () => false, since: '2026-11-01', from: '2026-11-01', foreignTax: '2201' };

test('#214 a refund is dated by the payments report\'s refund row, an export\'s split as its sale; an undated refund holds its sale, a fully refunded order without a row stays held; an order no transaction names waits', () => {
  const out = bookReport({ journalEntries: [] }, salesOf(REFUNDED), ctxOf({ ...NOV, payments: paymentsOf(PAYMENTS) }));
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-9001', '2026-11-03', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-9001-refund', '2026-11-09', '3200', '1093', 108.1, '-V81'],
    ['SR-shopify-9002', '2026-11-04', '1093', '3200', 100, 'V0'],
    ['SR-shopify-9002', '2026-11-04', '1093', '2201', 19, ''],
    // 30.00 × 19 / 119 = 4.79 back off the foreign tax, 25.21 off the export (#207).
    ['SR-shopify-9002-refund', '2026-11-12', '3200', '1093', 25.21, '-V0'],
    ['SR-shopify-9002-refund', '2026-11-12', '2201', '1093', 4.79, ''],
    ['SR-shopify-9006', '2026-11-08', '1093', '3200', 32.4, 'V81'],
  ]);
  assert.deepEqual(out.held, [{ order: '9003', why: 'refundDate' }, { order: '9004', why: 'refundDate' }, { order: '9005', why: 'noPayment' }]);
  assert.deepEqual([out.orders, out.refunds], [3, 2]);
  assert.equal(revenueOf(out.entries), 100 + 32.4 - 25.21, 'a fully refunded order adds no sale; held ones none');

  const without = bookReport({ journalEntries: [] }, salesOf(REFUNDED), ctxOf(NOV));
  assert.deepEqual(without.held, [{ order: '9001', why: 'refundDate' }, { order: '9002', why: 'refundDate' }, { order: '9003', why: 'refundDate' }, { order: '9004', why: 'refundDate' }], 'without the payments report every refunded order waits, its sale with it; #9005 counts as collected');
  assert.deepEqual(lines(without.entries).map((l) => l[0]), ['SR-shopify-9005', 'SR-shopify-9006']);

  const again = bookReport({ journalEntries: out.entries }, salesOf(REFUNDED), ctxOf({ ...NOV, payments: paymentFacts([...[PAYMENTS, PAYMENTS].map((c) => readReport(c, 'fees', SHOPIFY.provider)).map((r) => ('payments' in r ? r.payments : undefined))]) }));
  assert.deepEqual(again.entries, [], 'read again beside an overlapping payments report: no refund twice');

  // A refund that falls short of the refunded amount leaves the rest undated: the order waits.
  const short = PAYMENTS.replace('-30.00,0.00,-30.00', '-10.00,0.00,-10.00');
  assert.ok(bookReport({ journalEntries: [] }, salesOf(REFUNDED), ctxOf({ ...NOV, payments: paymentsOf(short) })).held.some((h) => h.order === '9002' && h.why === 'refundDate'));
});

test('#214 a test column flags an order or a transaction: no sale, no fee, no refund', () => {
  const facts = { ...SHOPIFY.provider, reports: { sales: { ...SHOPIFY.provider.reports.sales, test: ['Test'] }, fees: { ...SHOPIFY.provider.reports.fees, test: ['Test'] } } };
  const sales = salesOf([`${head},Test`, `${refundRow('9101', '2026-11-03', '54.05', '4.05', '0.00')},false`, `${refundRow('9102', '2026-11-03', '54.05', '4.05', '0.00')},true`].join('\n'), facts);
  const out = bookReport({ journalEntries: [] }, sales, ctxOf(NOV));
  assert.deepEqual([lines(out.entries).map((l) => l[0]), out.test], [['SR-shopify-9101'], 1]);
  const fees = readReport(['Transaction Date,Type,Order,Amount,Fee,Net,Currency,Test', '2026-11-03 10:00:00 +0100,charge,#9101,54.05,1.87,52.18,CHF,false', '2026-11-03 10:00:00 +0100,charge,#9102,54.05,1.87,52.18,CHF,true'].join('\n'), 'fees', facts);
  assert.ok(!('missing' in fees) && fees.kind === 'fees');
  assert.deepEqual([fees.rows.map((r) => r.order), fees.payments?.orders], [['9101'], ['9101']]);
});

test('#214 sales report and payments report in either order give the same books but for an order no transaction names: booked first, it stays booked and is asked about; dropped again, nothing changes', () => {
  const run = (order: Array<[string, string]>) => {
    const ws = shop(`${FILE()}  foreignTax: "2201"\n`);
    const said = order.map(([csv, name]) => { const r = importSalesReport(ws, Buffer.from(csv), name); assert.ok(r.ok, JSON.stringify(r)); return r.summary; });
    return { ws, said };
  };
  const shape = (ws: Workspace) => lines(loadBooks(ws).journalEntries.filter((e) => /^S[RF]-/.test(e.transactionRef))).sort();
  const a = run([[REFUNDED, 'o.csv'], [PAYMENTS, 'p.csv']]);
  const b = run([[PAYMENTS, 'p.csv'], [REFUNDED, 'o.csv']]);
  const no9005 = (ls: ReturnType<typeof shape>) => ls.filter((l) => l[0] !== 'SR-shopify-9005');
  assert.deepEqual(no9005(shape(a.ws)), shape(b.ws), 'the order of the drops does not matter for every other order');
  assert.deepEqual(shape(b.ws).filter((l) => String(l[0]).startsWith('SR-')).map((l) => l[0]).sort(), ['SR-shopify-9001', 'SR-shopify-9001-refund', 'SR-shopify-9002', 'SR-shopify-9002', 'SR-shopify-9002-refund', 'SR-shopify-9002-refund', 'SR-shopify-9006']);
  assert.ok(shape(a.ws).some((l) => l[0] === 'SR-shopify-9005'), 'a sale booked before the payments report is never taken back by code');
  assert.deepEqual([a.said[0].orders, a.said[1].orders, a.said[1].refunds, a.said[1].unpaid], [2, 2, 2, 1], 'the sales report alone booked #9005 and #9006; the payments report booked #9001 and #9002 with their refunds and names #9005 as unpaid');
  assert.deepEqual(heldOf(a.ws), [{ order: '9003', why: 'refundDate' }, { order: '9004', why: 'refundDate' }]);
  assert.deepEqual(heldOf(b.ws), [{ order: '9003', why: 'refundDate' }, { order: '9004', why: 'refundDate' }, { order: '9005', why: 'noPayment' }], 'not booked yet, it waits');

  // The person is asked on the booking itself, once.
  const sale = loadBooks(a.ws).journalEntries.find((e) => e.transactionRef === 'SR-shopify-9005')!;
  const asked = () => readQuestions(a.ws).filter((q) => q.topic === 'reportPayment');
  assert.deepEqual(asked().map((q) => [q.on, q.status, q.origin, q.choices.length]), [[{ kind: 'entry', id: sale.id }, 'open', 'booking', 0]]);
  assert.match(asked()[0].text, /^Keine Zahlung im Zahlungsbericht: Verkauf zurücknehmen\?/);
  assert.equal(readQuestions(b.ws).filter((q) => q.topic === 'reportPayment').length, 0, 'nothing booked, nothing to ask');

  const before = shape(a.ws);
  for (const [csv, name] of [[REFUNDED, 'o.csv'], [PAYMENTS, 'p.csv'], [REFUNDED, 'o2.csv']] as const) assert.ok(importSalesReport(a.ws, Buffer.from(csv), name).ok);
  assert.deepEqual(shape(a.ws), before, 'dropped again, in any order: the same books');
  assert.equal(asked().length, 1, 'asked once, never again');

  // The person deletes the booking by hand: the question is withdrawn on the next taking.
  const books = loadBooks(a.ws);
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== 'SR-shopify-9005');
  saveBooks(a.ws, books);
  assert.ok(importSalesReport(a.ws, Buffer.from(PAYMENTS), 'p.csv').ok);
  assert.deepEqual(asked().map((q) => q.status), ['closed']);
});

/** Four paid orders, two refunded: the probes of the review of #221 (invented figures). */
const PAID = [head,
  refundRow('9300', '2026-11-02', '54.05', '4.05', '54.05'),
  refundRow('9301', '2026-11-03', '108.10', '8.10', '0.00'),
  refundRow('9302', '2026-11-05', '108.10', '8.10', '0.00'),
  refundRow('9303', '2026-11-07', '54.05', '4.05', '54.05'),
].join('\n');
const salesRefs = (ws: Workspace) => [...new Set(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-')).map((e) => e.transactionRef))].sort();
const bothOrders = (sales: string, payments: string, check: (ws: Workspace, first: 'sales' | 'payments') => void) => {
  for (const first of ['sales', 'payments'] as const) {
    const ws = shop(`${FILE()}  foreignTax: "2201"\n`);
    for (const [csv, name] of first === 'sales' ? [[sales, 'o.csv'], [payments, 'p.csv']] : [[payments, 'p.csv'], [sales, 'o.csv']]) assert.ok(importSalesReport(ws, Buffer.from(csv), name).ok);
    check(ws, first);
  }
};

test('#214 a payments export of refunds only covers no day: every paid sale is booked and stays, the refunds on their days', () => {
  const refundsOnly = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
    '2026-11-04 10:00:00 +0100,refund,#9300,-54.05,0.00,-54.05,CHF',
    '2026-11-09 10:00:00 +0100,refund,#9303,-54.05,0.00,-54.05,CHF'].join('\n');
  bothOrders(PAID, refundsOnly, (ws, first) => {
    assert.deepEqual(salesRefs(ws), ['SR-shopify-9300', 'SR-shopify-9300-refund', 'SR-shopify-9301', 'SR-shopify-9302', 'SR-shopify-9303', 'SR-shopify-9303-refund'], first);
    assert.deepEqual(heldOf(ws), [], first);
    assert.equal(readQuestions(ws).length, 0, `${first}: nothing to ask`);
  });
});

test('#214 an order on the first or last day of a payments export is never held nor asked about: one payout\'s export, or one cut mid-day, covers that day only partly', () => {
  const onePayout = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency,Payout ID',
    '2026-11-03 10:00:00 +0100,charge,#9301,108.10,3.44,104.66,CHF,P1',
    '2026-11-05 09:00:00 +0100,charge,#9399,10.00,0.50,9.50,CHF,P1'].join('\n');
  // #9302 of 11-05 went to the next payout, or was paid after the export was cut that morning.
  bothOrders([head, refundRow('9301', '2026-11-03', '108.10', '8.10', '0.00'), refundRow('9302', '2026-11-05', '108.10', '8.10', '0.00')].join('\n'), onePayout, (ws, first) => {
    assert.deepEqual(salesRefs(ws), ['SR-shopify-9301', 'SR-shopify-9302'], first);
    assert.deepEqual(heldOf(ws), [], first);
    assert.equal(readQuestions(ws).length, 0, first);
  });
});

test('#214 refund rows: only the type «refund» is one (a refund_failure is none, nor widens the days); refunds beyond the refunded amount, or a refund the order export says is 0, hold the order', () => {
  const sales = salesOf([head, refundRow('9401', '2026-11-03', '54.05', '4.05', '54.05')].join('\n'));
  const failed = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
    '2026-11-03 10:00:00 +0100,charge,#9401,54.05,1.87,52.18,CHF',
    '2026-11-05 10:00:00 +0100,refund,#9401,-54.05,0.00,-54.05,CHF',
    '2026-11-06 10:00:00 +0100,refund_failure,#9401,54.05,0.00,54.05,CHF'].join('\n');
  const out = bookReport({ journalEntries: [] }, sales, ctxOf({ ...NOV, payments: paymentsOf(failed) }));
  assert.deepEqual(lines(out.entries), [['SR-shopify-9401', '2026-11-03', '1093', '3200', 54.05, 'V81'], ['SR-shopify-9401-refund', '2026-11-05', '3200', '1093', 54.05, '-V81']]);
  assert.equal(revenueOf(out.entries), 0, 'refunded once, never twice');
  assert.equal(paymentsOf(failed)!.inside('2026-11-05'), false, 'the charges cover 11-03 only');

  const zero = salesOf([head, refundRow('9501', '2026-11-03', '54.05', '4.05', '0.00')].join('\n'));
  const refunded = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
    '2026-11-03 10:00:00 +0100,charge,#9501,54.05,1.87,52.18,CHF',
    '2026-11-05 10:00:00 +0100,refund,#9501,-54.05,0.00,-54.05,CHF'].join('\n');
  const z = bookReport({ journalEntries: [] }, zero, ctxOf({ ...NOV, payments: paymentsOf(refunded) }));
  assert.deepEqual([z.entries, z.held], [[], [{ order: '9501', why: 'refundMismatch' }]], 'a refund the order export says is none: the order waits, sale and all');
  const booked = bookReport({ journalEntries: [] }, zero, ctxOf(NOV)).entries;
  const later = bookReport({ journalEntries: booked }, zero, ctxOf({ ...NOV, payments: paymentsOf(refunded) }));
  assert.deepEqual([later.entries, later.held], [[], [{ order: '9501', why: 'refundMismatch' }]], 'booked already: the sale stays, no refund is booked, the order waits');

  const twice = PAYMENTS.replace('2026-11-12 10:00:00 +0100,refund,#9002,-30.00', '2026-11-10 10:00:00 +0100,refund,#9002,-30.00,0.00,-30.00,CHF,P2\n2026-11-12 10:00:00 +0100,refund,#9002,-30.00');
  const over = bookReport({ journalEntries: [] }, salesOf(REFUNDED), ctxOf({ ...NOV, payments: paymentsOf(twice) }));
  assert.ok(over.held.some((h) => h.order === '9002' && h.why === 'refundMismatch'), 'two refunds of 30.00 on an order refunded 30.00: held');
  assert.ok(!over.entries.some((e) => e.transactionRef.startsWith('SR-shopify-9002')));
});

test('#214 a sale the books carry is never taken back by code: a person\'s link on it, her own entry, a filed one all stay', () => {
  for (const variant of ['link', 'person', 'filed'] as const) {
    const ws = shop(`${FILE()}  foreignTax: "2201"\n`);
    assert.ok(importSalesReport(ws, Buffer.from(REFUNDED), 'o.csv').ok);
    const b = loadBooks(ws);
    if (variant === 'link') {
      b.receipts.push({ id: 'doc', filename: '20261107-x.pdf', originalFilename: 'x.pdf', extractedText: 'x', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-11T00:00:00Z', location: 'archived', date: '2026-11-07', kind: 'invoice' } as Receipt);
      b.mappings.push({ transactionRef: 'SR-shopify-9005', receiptId: 'doc', by: 'human' });
    } else if (variant === 'person') b.journalEntries = b.journalEntries.map((e) => (e.transactionRef === 'SR-shopify-9005' ? { ...e, origin: 'manual' as const, by: { kind: 'person' } as JournalEntry['by'] } : e));
    else b.config.closedThrough = '2026-11-07';
    saveBooks(ws, b);
    assert.ok(importSalesReport(ws, Buffer.from(PAYMENTS), 'p.csv').ok);
    const a = loadBooks(ws);
    assert.equal(a.journalEntries.filter((e) => e.transactionRef === 'SR-shopify-9005').length, 1, variant);
    if (variant === 'link') assert.deepEqual(a.mappings.filter((m) => m.transactionRef === 'SR-shopify-9005' && m.by === 'human').length, 1, 'her link stays, never dangling');
  }
});

test('#214 «Rückgängig» of a payments export takes the sales reports again: what it held is booked, the app\'s refunds it dated go back, its question is withdrawn; a refund a person linked stays', () => {
  const idOf = (ws: Workspace, kind: 'sales' | 'fees') => loadBooks(ws).receipts.find((r) => r.report?.kind === kind)!.id;

  // Payments report first: #9005 waits for it. Without it, #9005 is booked; #9001 and #9002 stay booked, their refunds go back and wait for a day.
  const a = shop(`${FILE()}  foreignTax: "2201"\n`);
  for (const [csv, name] of [[PAYMENTS, 'p.csv'], [REFUNDED, 'o.csv']]) assert.ok(importSalesReport(a, Buffer.from(csv), name).ok);
  assert.equal(removeSalesReport(a, idOf(a, 'fees')), true);
  assert.deepEqual(salesRefs(a), ['SR-shopify-9001', 'SR-shopify-9002', 'SR-shopify-9005', 'SR-shopify-9006']);
  assert.equal(loadBooks(a).journalEntries.some((e) => e.transactionRef.startsWith('SF-')), false, 'its fees go');
  assert.deepEqual(heldOf(a), [{ order: '9001', why: 'refundDate' }, { order: '9002', why: 'refundDate' }, { order: '9003', why: 'refundDate' }, { order: '9004', why: 'refundDate' }]);

  // Sales report first: #9005 booked and asked about; «Rückgängig» withdraws the question.
  const b = shop(`${FILE()}  foreignTax: "2201"\n`);
  for (const [csv, name] of [[REFUNDED, 'o.csv'], [PAYMENTS, 'p.csv']]) assert.ok(importSalesReport(b, Buffer.from(csv), name).ok);
  const books = loadBooks(b);
  books.receipts.push({ id: 'doc', filename: '20261109-gutschrift.pdf', originalFilename: 'g.pdf', extractedText: 'x', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-11T00:00:00Z', location: 'archived', date: '2026-11-09', kind: 'invoice' } as Receipt);
  books.mappings.push({ transactionRef: 'SR-shopify-9001-refund', receiptId: 'doc', by: 'human' });
  saveBooks(b, books);
  assert.equal(readQuestions(b).filter((q) => q.topic === 'reportPayment' && q.status === 'open').length, 1);
  assert.equal(removeSalesReport(b, idOf(b, 'fees')), true);
  assert.deepEqual(salesRefs(b), ['SR-shopify-9001', 'SR-shopify-9001-refund', 'SR-shopify-9002', 'SR-shopify-9005', 'SR-shopify-9006'], 'the refund a person linked a receipt to stays');
  assert.deepEqual(readQuestions(b).filter((q) => q.topic === 'reportPayment').map((q) => q.status), ['closed']);
});

test('4. «Rückgängig» takes only the report\'s own entries and links: no payout changes; one of two overlapping reports leaves the other\'s sales; a person\'s change of one keeps it all', () => {
  const ws = shop();
  const p = payout('PB', { date: '2026-11-18', amount: 52.5 });
  seed(ws, [p], [asSales(p)]);
  const books = loadBooks(ws);
  books.receipts.push({ id: 'pg', filename: '20261110-shopify-bestellung-2002.pdf', originalFilename: 'o.pdf', extractedText: 'Shopify Bestellung #2002', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-11T00:00:00Z', location: 'archived', date: '2026-11-10', kind: 'sales-record', order: { number: '#2002', date: '2026-11-10', currency: 'CHF', gross: 54.05, shipTo: 'CH', payouts: [], refunds: [] } });
  saveBooks(ws, books);
  const before = loadBooks(ws).journalEntries.filter((e) => !e.transactionRef.startsWith('SR-'));
  const a = importSalesReport(ws, Buffer.from([head, row('2002', '2026-11-20', '54.05', '4.05')].join('\n')), 'a.csv');
  assert.ok(a.ok && a.summary.orders === 1 && a.summary.proofs === 1);
  const idOf = (file: string) => loadBooks(ws).receipts.find((r) => r.filename === file)!.id;
  const aId = idOf(a.summary.file);
  const b = importSalesReport(ws, Buffer.from([head, row('2002', '2026-11-20', '54.05', '4.05'), row('2007', '2026-11-21', '54.05', '4.05')].join('\n')), 'b.csv');
  assert.ok(b.ok && b.summary.known === 1);
  const bId = idOf(b.summary.file);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.transactionRef === 'SR-shopify-2002')?.receipts, [aId, bId].sort(), 'the sale both report is named by both');

  assert.equal(removeSalesReport(ws, aId), true);
  let now = loadBooks(ws);
  assert.deepEqual(now.journalEntries.find((e) => e.transactionRef === 'SR-shopify-2002')?.receipts, [bId], 'B\'s sale stays, with B only');

  // V4: a person's change of one of B's entries: nothing of B is taken back.
  const changed = loadBooks(ws);
  changed.journalEntries = changed.journalEntries.map((e) => (e.transactionRef === 'SR-shopify-2007' ? { ...e, origin: 'manual' as const, by: { kind: 'person' } as JournalEntry['by'] } : e));
  saveBooks(ws, changed);
  assert.equal(removeSalesReport(ws, bId), false);
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-')).length, 2, 'refused: everything stays');
  const back = loadBooks(ws);
  back.journalEntries = back.journalEntries.map((e) => (e.transactionRef === 'SR-shopify-2007' ? { ...e, origin: 'classify' as const, by: { kind: 'code', check: 'payoutReport' } as JournalEntry['by'] } : e));
  saveBooks(ws, back);

  assert.equal(removeSalesReport(ws, bId), true);
  now = loadBooks(ws);
  assert.equal(now.journalEntries.some((e) => e.transactionRef.startsWith('SR-')), false, '«Rückgängig» takes its bookings back');
  assert.deepEqual(lines(now.journalEntries.filter((e) => !e.transactionRef.startsWith('SR-'))), lines(before), 'every other entry as it was, the payout booked as sales included');
  assert.equal(now.mappings.some((m) => m.receiptId === 'pg'), false, 'the order page\'s link to a sale that is gone goes too');
});

test('6. what a report holds is kept on its receipt and shown there; the drop row names the first ones, the receipt the first HELD_KEPT', () => {
  const ws = shop();
  const many = Array.from({ length: HELD_NAMED + 2 }, (_, i) => row(String(5000 + i), '2026-11-10', '54.05', '0.00'));
  const done = importSalesReport(ws, Buffer.from([head, ...many].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.held.length, done.summary.heldMore], [HELD_NAMED, 2], 'the row names ten and counts the rest');
  assert.equal(heldOf(ws).length, HELD_NAMED + 2, 'the receipt keeps them all (up to HELD_KEPT)');
  assert.ok(heldOf(ws).every((h) => h.why === 'noTax'));
});

test('the company\'s file lacks the clearing account: the report asks for it once with the cut-over day, keeps both in that file, and books; a profit-and-loss account or a day of a filed period is refused', () => {
  const ws = shop('  revenue: "3200"\n');
  const first = importSalesReport(ws, Buffer.from(NOVEMBER), 'orders_export.csv');
  assert.ok(!first.ok && first.ask?.missing === 'clearing');
  assert.equal(first.ask?.since, '2026-04-01', 'the first day of the open period proposed');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '9999' }), { ok: false, refusal: { code: 'unknownAccount', params: { account: '9999' } } });
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '3200' }), { ok: false, refusal: { code: 'clearingNotBalance', params: { account: '3200' } } }, 'note 9: a revenue account holds nothing the provider owes');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '1093', since: '2026-03-31' }), { ok: false, refusal: { code: 'sinceNotOpen', params: { since: '2026-03-31', from: '2026-04-01' } } });
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '1093' }), { ok: true });
  const second = importSalesReport(ws, Buffer.from(NOVEMBER), 'orders_export.csv');
  assert.ok(!second.ok && second.ask?.missing === 'since' && second.ask.since === '2026-04-01', 'a file with the account but no day asks for the day');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { since: '2026-11-01' }), { ok: true });
  const file = parse(readFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'utf8')) as { provider: Record<string, unknown> };
  assert.deepEqual(file.provider, { revenue: '3200', clearing: '1093', since: '2026-11-01' });
  assert.ok(importSalesReport(ws, Buffer.from(NOVEMBER), 'orders_export.csv').ok);
  const fees = importSalesReport(shop('  clearing: "1093"\n  since: 2026-11-01\n'), Buffer.from(FEES), 'payment_transactions.csv');
  assert.ok(!fees.ok && fees.ask?.missing === 'fees', 'the fee account is asked for the fee report');
});

test('7. a report that fails on an error is refused in its row with a code; the session is saved and goes on', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n');
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

test('the drop row asks the clearing account with the cut-over day, the first open day proposed; a revenue account is refused with its code; the answer books the report', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  revenue: "3200"\n');
    const accounts = join(api.root, 'master-data', 'accounts.json');
    writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
    const post = async (path: string, body?: Buffer | object): Promise<{ status: number; s: DropSession & { code?: string } }> => {
      const json = body && !Buffer.isBuffer(body);
      const res = await api.fetch(path, { method: 'POST', body: json ? JSON.stringify(body) : body ? new Uint8Array(body as Buffer) : undefined, headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' } });
      return { status: res.status, s: (await res.json()) as DropSession & { code?: string } };
    };
    const { s } = await post('/api/drop');
    const took = await post(`/api/drop/${s.id}/files?name=orders_export.csv`, Buffer.from(NOVEMBER));
    const row = took.s.rows[0];
    assert.deepEqual([row.state, row.reason, row.askProvider?.missing, row.askProvider?.since], ['unclear', 'provider-account', 'clearing', '2026-04-01']);
    const wrong = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'provider', account: '3200', since: '2026-11-01' });
    assert.deepEqual([wrong.status, wrong.s.code], [400, 'clearingNotBalance']);
    const answered = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'provider', account: '1093', since: '2026-11-01' });
    assert.equal(answered.status, 200);
    assert.deepEqual([answered.s.rows[0].state, answered.s.rows[0].report?.orders, answered.s.rows[0].report?.since], ['taken', 3, '2026-11-01']);
    assert.match(readFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'utf8'), /since: 2026-11-01/);
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
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'terminal.yaml'), 'id: terminal\nname: Terminal AG\nmatch:\n  uid: [ "CHE-111.222.333" ]\n  tx: [ "terminal ag" ]\nprovider:\n  payoutDays: 3\n  clearing: "1093"\n  since: 2026-10-01\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n');
  const books = loadBooks(ws);
  books.receipts.push({ id: 'po', filename: '20261031-terminal-auszahlung.pdf', originalFilename: 'po.pdf', extractedText: 'Terminal AG CHE-111.222.333 Auszahlung Oktober', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-01T00:00:00Z', location: 'archived', date: '2026-10-31', amount: 1412.35, currency: 'CHF', vatId: 'CHE-111.222.333', payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } });
  const tx = payout('T1', { date: '2026-11-02', amount: 1412.35, description: 'Gutschrift Terminal AG', counterparty: 'Terminal AG' });
  books.transactions.push(tx);
  return { ws, books, tx };
}

test('2. a card terminal\'s payout report books its sales and fees onto the clearing account once, beside its payout booked from there', async () => {
  const { ws, books, tx } = terminal();
  assert.equal(bookPayoutReports(ws, books, fx), 0, 'its payout is not booked yet: nothing');
  await classifyTransactions(books, [tx], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.transactionRef === 'T1')), [['T1', '2026-11-02', '1021', '1093', 1412.35, '']]);
  assert.equal(bookPayoutReports(ws, books, fx), 1);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.receipts?.includes('po'))), [
    ['SR-terminal-po', '2026-10-31', '1093', '3200', 1480, 'V81'],
    ['SR-terminal-po-refund', '2026-10-31', '3200', '1093', 40, '-V81'],
    ['SF-terminal-po', '2026-10-31', '6840', '1093', 27.65, 'I0'],
  ]);
  assert.ok(books.mappings.some((m) => m.receiptId === 'po' && m.transactionRef === 'T1'), 'the report is linked to the payout it states');
  assert.equal(bookPayoutReports(ws, books, fx), 0, 'once');
});

test('2. a payout report books nothing beside a payout booked as sales (by a rule or a person: never booked again), before the cut-over day, nor for a provider whose sales come from its sales report', () => {
  for (const by of [{ by: { kind: 'rule', rule: 'terminal-umsatz' } }, { origin: 'manual', by: undefined }] as Array<Partial<JournalEntry>>) {
    const { ws, books, tx } = terminal();
    books.journalEntries.push({ ...asSales(tx), ...by });
    assert.equal(bookPayoutReports(ws, books, fx), 0);
    assert.equal(books.journalEntries.some((e) => e.receipts?.includes('po')), false);
    assert.deepEqual(lines(books.journalEntries.filter((e) => e.transactionRef === 'T1')), [['T1', '2026-11-02', '1021', '3200', 1412.35, 'V81']], 'its booking stays');
  }
  const { ws, books, tx } = terminal();
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'terminal.yaml'), readFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'terminal.yaml'), 'utf8').replace('since: 2026-10-01', 'since: 2026-11-01'));
  books.journalEntries.push({ id: 't1', transactionRef: tx.ref, date: tx.date, accountDebit: '1021', accountCredit: '1093', amount: tx.amount });
  assert.equal(bookPayoutReports(ws, books, fx), 0, 'a report of 31.10. lies before the cut-over day');
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
  assert.equal(c.below, undefined);
  const early = clearingCheck(p, { ...books, transactions: books.transactions.filter((t) => t.date <= '2026-10-02') }, '2026-09-30', 3)!;
  assert.equal(early.paidAfter, undefined, 'the bank\'s payments through 5 days after the end are not in the books yet');
  // 5: a sale collected before the cut-over day and paid after it: the payout takes the account below zero, a difference whatever was paid after.
  const short = clearingCheck(p, { ...books, journalEntries: [...books.journalEntries, e('p0', '2026-09-20', '1021', '1093', 150, 'P1')] }, '2026-09-30', 3)!;
  assert.deepEqual([short.balance, short.below], [-30, true]);
});

// ─── Third review ────────────────────────────────────────────────────────────

/** A payout Stripe makes for Shopify, as Wise writes it: the bank names Stripe, the reference Shopify. */
const viaStripe = (ref: string, reference: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  payout(ref, { date: '2026-11-04', amount: 108.1, description: `Received money from Stripe Example Ltd with reference ${reference}`, counterparty: undefined, ...over });
/** A model that books every payment it is asked about as gross sales: what rule 9a does with a payout it does not know. */
const asSalesModel = (amount: number) => async (prompt: string) => JSON.stringify(Object.fromEntries([...prompt.matchAll(/### Transaction \d+: (\S+)/g)].map((m) => [m[1], { entries: [{ accountDebit: '', accountCredit: '3200', amount, vat: 'charged', vatRate: 8.1, description: 'Shopify payout' }], reason: 'rule 9a' }])));
/** A payment out on a later day: the bank's payments of the days before it are in the books. */
const later = (date: string): BankTransaction => ({ ...payout(`X-${date}`, { date, amount: 5, description: 'Kartenzahlung Bäckerei', counterparty: 'Bäckerei' }), direction: 'DBIT' });

test('R7a. a payout whose reference begins with the provider\'s word is the provider\'s, though the bank names another payer: booked bank / clearing account, its order once; a plain Stripe payout is not Shopify\'s', async () => {
  const ws = shop();
  const counterparties = loadClassifyContext(ws).counterparties ?? [];
  assert.equal(providerOfPayment(viaStripe('ST1', 'Shopify 98765'), [], counterparties)?.id, 'shopify', 'with reference Shopify …');
  assert.equal(providerOfPayment(viaStripe('ST1', 'Shopify 98765', { description: 'Gutschrift Stripe Example Ltd', reference: 'SHOPIFY* 98765' }), [], counterparties)?.id, 'shopify', 'the remittance field');
  assert.equal(providerOfPayment(viaStripe('ST2', 'STRIPE 4711', { counterparty: 'Stripe Example Ltd' }), [], counterparties), undefined, 'a plain Stripe payout');
  assert.equal(providerOfPayment(viaStripe('ST3', 'Shopifyish 1'), [], counterparties), undefined, 'a whole word only');

  const done = importSalesReport(ws, Buffer.from([head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(done.ok && done.summary.orders === 1);
  const books = loadBooks(ws);
  const st = viaStripe('ST1', 'Shopify 98765');
  books.transactions.push(st);
  const out = await classifyTransactions(books, [st], { fx, context: loadClassifyContext(ws), ask: asSalesModel(108.1) } as Parameters<typeof classifyTransactions>[2]);
  assert.deepEqual(out.classified, ['ST1']);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.transactionRef === 'ST1')), [['ST1', '2026-11-04', '1021', '1093', 108.1, '']], 'from the clearing account, never as sales');
  assert.equal(revenueOf(books.journalEntries), 108.1, 'the sale once');
  assert.equal(balanceOf(books.journalEntries, '1093'), 0);
});

test('R7b. the bank\'s payments of the report\'s days are in, no payout of the provider is recognised: the report books nothing and says why, naming what was looked at; «Trotzdem übernehmen» books it and the clearing check shows the difference; the payout\'s name in match.tx by hand books each sale once', () => {
  const ws = shop();
  const st = viaStripe('ST2', 'STRIPE 4711', { counterparty: 'Stripe Example Ltd' });
  seed(ws, [st, later('2026-11-10')], [E('st', 'ST2', '2026-11-04', '1021', '3200', 108.1, 'V81', { by: { kind: 'model', model: 'm' } })]);
  const csv = [head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n');
  const held = importSalesReport(ws, Buffer.from(csv), 'o.csv');
  assert.ok(!held.ok);
  assert.equal(held.ask, undefined, 'no question whose answer would be written into the file');
  assert.deepEqual(held.unseen, { provider: 'shopify', name: 'Shopify', since: '2026-11-01', through: '2026-11-09', banks: ['Raiffeisen CHF'], file: 'knowledge/suppliers/shopify.yaml' });
  assert.match(held.message, /Keine Auszahlung von Shopify erkannt: die Zahlungen der Bank sind bis 2026-11-09 da \(Raiffeisen CHF\).*match\.tx.*Trotzdem übernehmen/);
  const untouched = loadBooks(ws);
  assert.deepEqual([reportRefs(untouched.journalEntries), untouched.receipts.filter((r) => r.report).length], [[], 0], 'nothing booked, nothing filed');

  const anyway = importSalesReport(ws, Buffer.from(csv), 'o.csv', { anyway: true });
  assert.ok(anyway.ok && anyway.summary.orders === 1, 'taken anyway');
  const books = loadBooks(ws);
  const check = clearingCheck(providersOf(ws).find((p) => p.id === 'shopify')!, books, '2026-11-30', 1)!;
  assert.equal(check.balance, 108.1, 'the safety net: the clearing account keeps the sale the unseen payout paid, a difference the quarter\'s review shows');

  // The payout's name put into the company's file by hand: the payout is the provider's, and holds the order it paid.
  const named = shop(FILE(), 'match:\n  tx: [ "Stripe Example" ]\n');
  seed(named, [st, later('2026-11-10')], [E('st', 'ST2', '2026-11-04', '1021', '3200', 108.1, 'V81', { by: { kind: 'model', model: 'm' } })]);
  const taken = importSalesReport(named, Buffer.from(csv), 'o.csv');
  assert.ok(taken.ok);
  assert.deepEqual([taken.summary.orders, taken.summary.held], [0, [{ order: '2001', why: 'legacy' }]], 'the payout booked as sales holds the order it paid');
  assert.equal(revenueOf(loadBooks(named).journalEntries), 108.1, 'the sale once');

  // Before the statement is in, nothing is held: the report books as it did.
  const early = shop();
  const first = importSalesReport(early, Buffer.from(csv), 'o.csv');
  assert.ok(first.ok && first.summary.orders === 1);
});

test('N7. the unseen-payout check starts at the first order the provider collected: a PayPal order before it expects no payout', () => {
  const ws = shop();
  seed(ws, [later('2026-11-09')], []);
  const csv = [head, row('2004', '2026-11-01', '54.05', '4.05', 'CH', 'PayPal Express Checkout'), row('2001', '2026-11-08', '108.10', '8.10')].join('\n');
  const done = importSalesReport(ws, Buffer.from(csv), 'o.csv');
  assert.ok(done.ok, 'the first Shopify Payments order (8.11.) can not have been paid out by 9.11.');
  assert.deepEqual([done.summary.orders, done.summary.other], [1, 1]);
  const onlyPaypal = shop();
  seed(onlyPaypal, [later('2026-11-20')], []);
  assert.ok(importSalesReport(onlyPaypal, Buffer.from([head, row('2004', '2026-11-01', '54.05', '4.05', 'CH', 'PayPal Express Checkout')].join('\n')), 'o.csv').ok, 'nothing Shopify collected: no payout expected');
});

test('N8. the company\'s file names the bank account the provider pays into (provider.account): only that account\'s payments count for the unseen-payout check', () => {
  const wise: BankTransaction = { ref: 'W1', bank: 'Wise', date: '2026-11-12', amount: 80, currency: 'EUR', direction: 'CRDT', description: 'Zahlung', counterparty: 'Kunde GmbH' };
  const csv = [head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n');
  const any = shop();
  seed(any, [wise], []);
  const held = importSalesReport(any, Buffer.from(csv), 'o.csv');
  assert.ok(!held.ok);
  assert.deepEqual([held.unseen?.banks, held.unseen?.account], [['Wise EUR'], undefined], 'any account, named');
  const into = shop(`${FILE()}  account: "1021"\n`);
  assert.equal(providersOf(into).find((p) => p.id === 'shopify')?.provider.account, '1021');
  seed(into, [wise], []);
  assert.ok(importSalesReport(into, Buffer.from(csv), 'o.csv').ok, 'the Raiffeisen statement of those days is not in yet: nothing to miss');
  assert.match((mergeProvider({ account: '1021' }, undefined, true) as { problem: string }).problem, /one company's chart/);
});

test('N3. a credit recognised by its reference alone is the provider\'s payout only when the bank names no payer or a payment processor of the provider\'s file: a customer\'s transfer «Shopify Bestellung 1001» is not', () => {
  const ws = shop();
  const cps = loadClassifyContext(ws).counterparties ?? [];
  assert.deepEqual(SHOPIFY.provider.processors, ['stripe']);
  const customer = payout('C1', { date: '2026-11-04', counterparty: 'Hans Muster', description: 'Gutschrift Hans Muster', reference: 'Shopify Bestellung 1001' });
  assert.equal(providerOfPayment(customer, [], cps), undefined, 'a private person\'s transfer');
  assert.equal(providerOfPayment(payout('C2', { date: '2026-11-04', counterparty: 'Stripe Example Ltd', description: 'Gutschrift', reference: 'Shopify 98765' }), [], cps)?.id, 'shopify', 'Stripe, the processor the file names');
  assert.equal(providerOfPayment(payout('C3', { date: '2026-11-04', counterparty: '', description: 'Gutschrift', reference: 'Shopify 98765' }), [], cps)?.id, 'shopify', 'no payer named');
  assert.equal(providerOfPayment(payout('C4', { date: '2026-11-04', counterparty: 'Stripes Muster', description: 'Gutschrift', reference: 'Shopify 98765' }), [], cps), undefined, 'a whole word only');
  assert.match((parseProvider({ processors: [''] }) as { problem: string }).problem, /provider\.processors must name/);
});

test('N3b. with no counterparty (Wise PDF statements) the payer is read from the description: a customer is no payout, Stripe is; every occurrence of the processor word is checked', () => {
  const ws = shop();
  const cps = loadClassifyContext(ws).counterparties ?? [];
  const wise = (ref: string, description: string) => payout(ref, { date: '2026-11-04', counterparty: undefined, description });
  assert.equal(providerOfPayment(wise('H1', 'Received money from Hans Muster with reference Shopify Bestellung 1001'), [], cps), undefined, 'a customer\'s transfer');
  assert.equal(providerOfPayment(wise('H2', 'Received money from Stripe Example Ltd with reference Shopify 98765'), [], cps)?.id, 'shopify', 'Stripe');
  assert.equal(providerOfPayment(wise('H3', 'Received money from Stripeline / Stripe Payments with reference Shopify 98765'), [], cps)?.id, 'shopify', 'the second occurrence is the whole word');
  assert.equal(providerOfPayment(wise('H4', 'Received money from Stripeline Ltd with reference Shopify 98765'), [], cps), undefined, 'no whole-word occurrence');
});

test('N3c. a provider.account that is none of the firm\'s bank accounts refuses the report with a message, never switches the unseen-payout check off', () => {
  const ws = shop(`${FILE()}  account: "9999"\n`);
  const r = importSalesReport(ws, Buffer.from([head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(!r.ok);
  assert.match(r.message, /9999.*provider\.account.*keines der Bankkonten/);
  assert.deepEqual(reportRefs(loadBooks(ws).journalEntries), [], 'nothing booked');
});

test('N1 / N2. an entry counts as an order\'s own booking only when it names that order alone with its amount, net of its reversals; one naming two orders holds both, never books the second again', () => {
  const read = salesOf([head, row('2001', '2026-11-02', '108.10', '8.10'), row('2002', '2026-11-10', '54.05', '4.05'), row('2003', '2026-11-25', '20.00', '1.50')].join('\n'));
  const ctx = (entries: JournalEntry[]) => ctxOf({ since: '2026-11-01', from: '2026-10-25', legacy: { entries } });
  const hand = (id: string, date: string, amount: number, description: string, d = '1093', c = '3200') => E(id, `M-${id}`, date, d, c, amount, 'V81', { origin: 'manual', description });
  const both = bookReport({ journalEntries: [] }, read, ctx([hand('m', '2026-11-10', 162.15, 'Shopify Bestellungen #2001 und #2002')]));
  assert.deepEqual([both.orders, both.known, both.held], [1, 0, [{ order: '2001', why: 'legacy' }, { order: '2002', why: 'legacy' }]], 'both held, #2003 after its day booked');
  const sumOnOne = bookReport({ journalEntries: [] }, read, ctx([hand('m', '2026-11-10', 162.15, 'Shopify Bestellung #2002')]));
  assert.deepEqual([sumOnOne.orders, sumOnOne.known, sumOnOne.held.map((h) => h.order)], [1, 0, ['2001', '2002']], 'another amount: it holds every row up to its day, #2001 is never booked beside the sum');

  const reversed = bookReport({ journalEntries: [] }, read, ctx([hand('a', '2026-11-02', 108.1, 'Shopify #2001'), hand('b', '2026-11-03', -108.1, 'Storno Shopify #2001')]));
  assert.deepEqual([reversed.known, reversed.held.map((h) => h.order)], [0, ['2001']], 'a sale and its reversal net nothing: the order is not booked by them, the person decides');
  const corrected = bookReport({ journalEntries: [] }, read, ctx([hand('a', '2026-11-02', 100, 'Shopify #2001'), hand('b', '2026-11-03', 100, 'Storno Shopify #2001', '3200', '1093'), hand('c', '2026-11-03', 108.1, 'Shopify #2001')]));
  assert.deepEqual([corrected.known, corrected.held, corrected.orders], [1, [], 2], 'a wrong amount, its Storno with the sides swapped and the right amount: net the order\'s, known');

  // Through the books: the Storno with the sides swapped is among what the clearing account carries.
  const ws = shop();
  seed(ws, [], [hand('a', '2026-11-02', 100, 'Shopify #2001'), hand('b', '2026-11-03', 100, 'Storno Shopify #2001', '3200', '1093'), hand('c', '2026-11-03', 108.1, 'Shopify #2001')]);
  const done = importSalesReport(ws, Buffer.from([head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.orders, done.summary.known, done.summary.held], [0, 1, []]);
  assert.equal(revenueOf(loadBooks(ws).journalEntries), 108.1, 'the sale once');
});

test('R1. a payout before the cut-over day, within its payout days, beside sales a report booked before it: it waits for the person with a reason, never booked as sales; in either order of import each sale counts once', async () => {
  const csv = [head, row('1982', '2026-10-30', '60.00', '4.50'), row('2001', '2026-11-02', '108.10', '8.10')].join('\n');
  const pg = payout('PG', { date: '2026-10-31', amount: 60 });
  const pn = payout('PN', { date: '2026-11-04', amount: 108.1 });

  // The report first, then the statement.
  const ws = shop();
  const done = importSalesReport(ws, Buffer.from(csv), 'o.csv');
  assert.ok(done.ok && done.summary.orders === 2, 'no payout before the day in the books yet: both booked');
  const books = loadBooks(ws);
  books.transactions.push(pg, pn);
  const counterparties = loadClassifyContext(ws).counterparties ?? [];
  assert.equal(payoutWaitOf(pg, [], counterparties, books.journalEntries)?.why, 'gap');
  assert.equal(payoutWaitOf(pn, [], counterparties, books.journalEntries), undefined, 'a payout from the day on is booked from the clearing account');
  assert.equal(payoutWaitOf(payout('PE', { date: '2026-10-20', amount: 60 }), [], counterparties, books.journalEntries), undefined, 'one before the payout days is a payment like any other');
  const out = await classifyTransactions(books, [pg, pn], { fx, context: loadClassifyContext(ws), ask: asSalesModel(60) } as Parameters<typeof classifyTransactions>[2]);
  assert.deepEqual(out.classified, ['PN']);
  assert.equal(out.failed[0]?.ref, 'PG');
  assert.match(out.failed[0].reason, /vor dem Umstellungstag 2026-11-01.*Durchlaufkonto 1093 gebucht, nichts gebucht/);
  assert.equal(books.journalEntries.filter((e) => e.transactionRef === 'PG').length, 0, 'not booked as sales');
  assert.equal(revenueOf(books.journalEntries, '2026-10-25'), 168.1, 'each sale once');

  // The statement first (the payout before the day booked as sales by the model), then the report.
  const other = shop();
  const first = loadBooks(other);
  first.transactions.push(pg, pn);
  const out2 = await classifyTransactions(first, [pg, pn], { fx, context: loadClassifyContext(other), ask: asSalesModel(60) } as Parameters<typeof classifyTransactions>[2]);
  assert.deepEqual(out2.classified.sort(), ['PG', 'PN']);
  saveBooks(other, first);
  const then = importSalesReport(other, Buffer.from(csv), 'o.csv');
  assert.ok(then.ok);
  assert.deepEqual([then.summary.orders, then.summary.held], [1, [{ order: '1982', why: 'legacy' }]], '#1982 is in the payout booked as sales');
  const es = loadBooks(other).journalEntries;
  assert.equal(revenueOf(es, '2026-10-25'), 168.1, 'each sale once');
  assert.equal(balanceOf(es, '1093', '2026-10-25'), 0, 'the clearing account comes out even');
});

test('R2. on the agreed basis the day the provider collected an order decides the reach and what the books carry; the entry is dated by the order\'s day, and counted as filed when that day is closed', () => {
  const agreed = (order: string, created: string, paid: string, total = '54.05', tax = '4.05') => `#${order},${paid} 10:00:00 +0100,CHF,${tax},${total},CH,0.00,${created} 09:00:00 +0100,Shopify Payments`;
  const ctx = (over: Partial<ReportContext> = {}) => ctxOf({ agreed: true, since: '2026-11-01', from: '2026-10-25', ...over });
  const read = salesOf([head, agreed('1975', '2026-10-15', '2026-10-30'), agreed('1976', '2026-10-18', '2026-10-22'), agreed('1977', '2026-06-28', '2026-10-30', '20.00', '1.50')].join('\n'));
  const out = bookReport({ journalEntries: [] }, read, ctx());
  assert.deepEqual([out.orders, out.beforeSince, out.beforeSinceRows, out.filed], [1, 1, ['1976'], 1], '#1975 collected in the reach is booked, #1976 collected before it counted, #1977 ordered in a filed quarter counted as filed');
  assert.deepEqual(lines(out.entries), [['SR-shopify-1975', '2026-10-15', '1093', '3200', 54.05, 'V81']], 'dated by its tax point, the order\'s day');
  const carried = bookReport({ journalEntries: [] }, salesOf([head, agreed('1975', '2026-10-15', '2026-10-30')].join('\n')), ctx({ legacy: { entries: [E('o', 'OLD-1', '2026-10-30', '1093', '3200', 54.05, 'V81')] } }));
  assert.deepEqual([carried.orders, carried.held], [0, [{ order: '1975', why: 'legacy' }]], 'an old entry of the day it was collected holds it');
});

test('R5 / 7. a person\'s own entry that names the order books it: the order is known, never held again on the next taking; one matched only by day and amount holds it', () => {
  const csv = [head, row('1982', '2026-10-30', '60.00', '4.50')].join('\n');
  const pg = payout('PG', { date: '2026-10-31', amount: 60 });
  const hers = (description?: string) => E('m', 'M-0001', '2026-10-30', '1093', '3200', 60, 'V81', { origin: 'manual', by: { kind: 'person' } as JournalEntry['by'], ...(description ? { description } : {}) });
  const ws = shop();
  seed(ws, [pg], [E('pg', 'PG', '2026-10-31', '1021', '1093', 60), hers('Shopify Bestellung #1982')]);
  for (const k of [1, 2]) {
    const done = importSalesReport(ws, Buffer.from(csv), 'o.csv');
    assert.ok(done.ok);
    assert.deepEqual([done.summary.orders, done.summary.known, done.summary.held], [0, 1, []], `taking ${k}: known, not held`);
  }
  assert.deepEqual(heldOf(ws), []);
  assert.equal(revenueOf(loadBooks(ws).journalEntries, '2026-10-25'), 60, 'her sale once');

  const unnamed = shop();
  seed(unnamed, [pg], [E('pg', 'PG', '2026-10-31', '1021', '1093', 60), hers('Shopify Umsatz')]);
  const held = importSalesReport(unnamed, Buffer.from(csv), 'o.csv');
  assert.ok(held.ok);
  assert.deepEqual([held.summary.orders, held.summary.held], [0, [{ order: '1982', why: 'legacy' }]], 'a day and an amount may be another order: the person decides');
});

test('R6 / 8. a clearing account another provider\'s file names already is refused: each provider\'s check counts only its own', () => {
  const ws = shop('  revenue: "3200"\n');
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'sumup.yaml'), 'id: sumup\nname: SumUp\nmatch:\n  tx: [ "sumup" ]\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '1093', since: '2026-11-01' }), { ok: false, refusal: { code: 'clearingTaken', params: { account: '1093', other: 'SumUp' } } });
  assert.deepEqual(setProviderAccount(ws, 'sumup', { clearing: '1093' }), { ok: true }, 'its own account again');
  assert.deepEqual(setProviderAccount(ws, 'shopify', { clearing: '1094', since: '2026-11-01' }), { ok: true });
});

test('5. the rows before the reach are named like the held ones, the first ones and a count of the rest, with the payout days and the file that may say more', () => {
  const ws = shop();
  const early = Array.from({ length: HELD_NAMED + 2 }, (_, i) => row(String(1900 + i), '2026-10-20', '54.05', '4.05'));
  const done = importSalesReport(ws, Buffer.from([head, ...early, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')), 'o.csv');
  assert.ok(done.ok);
  assert.deepEqual([done.summary.beforeSince, done.summary.beforeSinceRows.length, done.summary.beforeSinceRows[0], done.summary.beforeSinceMore, done.summary.payoutDays, done.summary.home], [HELD_NAMED + 2, HELD_NAMED, '1900', 2, 7, 'knowledge/suppliers/shopify.yaml']);
});

test('10. a payout that waits says why on the payment itself (GET /api/transactions/:ref/payout-wait); the drop row holds a report whose payout goes unseen, says why, and books it on «Trotzdem übernehmen»', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const file = join(api.root, 'knowledge', 'suppliers', 'shopify.yaml');
    writeFileSync(file, 'id: shopify\nprovider:\n  revenue: "3200"\n');
    const accounts = join(api.root, 'master-data', 'accounts.json');
    writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
    const ws = workspaceAt(api.root);
    seed(ws, [payout('PW', { date: '2026-11-03', amount: 50 }), viaStripe('ST2', 'STRIPE 4711', { counterparty: 'Stripe Example Ltd' }), later('2026-11-10')], []);
    const wait = async (ref: string) => ((await (await api.fetch(`/api/transactions/${ref}/payout-wait`)).json()) as { wait: unknown }).wait;
    assert.deepEqual(await wait('PW'), { why: 'clearing', provider: 'Shopify', file: 'knowledge/suppliers/shopify.yaml' });
    assert.equal(await wait('ST2'), null, 'no provider\'s payout');
    writeFileSync(file, 'id: shopify\nprovider:\n  clearing: "1093"\n  revenue: "3200"\n');
    assert.deepEqual(await wait('PW'), { why: 'since', provider: 'Shopify', file: 'knowledge/suppliers/shopify.yaml' });
    writeFileSync(file, 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-11-01\n  revenue: "3200"\n');
    assert.equal(await wait('PW'), null, 'booked from the clearing account by the next run');

    const post = async (path: string, body?: Buffer | object): Promise<{ status: number; s: DropSession & { code?: string } }> => {
      const json = body && !Buffer.isBuffer(body);
      const res = await api.fetch(path, { method: 'POST', body: json ? JSON.stringify(body) : body ? new Uint8Array(body as Buffer) : undefined, headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' } });
      return { status: res.status, s: (await res.json()) as DropSession & { code?: string } };
    };
    // PW names Shopify and is recognised: a statement whose only payouts arrive as Stripe's is the case the row holds.
    const books = loadBooks(ws);
    books.transactions = books.transactions.filter((t) => t.ref !== 'PW');
    saveBooks(ws, books);
    const { s } = await post('/api/drop');
    const took = await post(`/api/drop/${s.id}/files?name=orders_export.csv`, Buffer.from([head, row('2001', '2026-11-02', '108.10', '8.10')].join('\n')));
    const r = took.s.rows[0];
    assert.deepEqual([r.state, r.reason, r.askProvider, r.payoutUnseen?.provider, r.payoutUnseen?.banks], ['unclear', 'payout-unseen', undefined, 'shopify', ['Raiffeisen CHF']]);
    const wrong = await post(`/api/drop/${s.id}/rows/${r.key}`, { kind: 'provider', account: '1093', since: '2026-11-01' });
    assert.equal(wrong.status, 400, 'no account is asked');
    const anyway = await post(`/api/drop/${s.id}/rows/${r.key}`, { kind: 'anyway' });
    assert.equal(anyway.status, 200);
    assert.deepEqual([anyway.s.rows[0].state, anyway.s.rows[0].report?.orders, anyway.s.rows[0].payoutUnseen], ['taken', 1, undefined], 'taken anyway: the order is booked onto the clearing account');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /Stripe/, 'nothing written into the file');
    const again = await post(`/api/drop/${s.id}/rows/${r.key}`, { kind: 'anyway' });
    assert.equal(again.status, 400, 'only a held report');
  } finally {
    await api.stop();
  }
});

test('R8 (a follow-up): money Shopify takes from the bank is no payout: it waits for a receipt like any payment out, and is never booked from the clearing account', async () => {
  const ws = shop();
  const neg = { ...payout('NEG', { date: '2026-11-06', amount: 25, description: 'Belastung Shopify Payments' }), direction: 'DBIT' as const };
  const books = loadBooks(ws);
  books.transactions.push(neg);
  const context = loadClassifyContext(ws);
  assert.equal(providerOfPayment(neg, [], context.counterparties ?? []), undefined);
  assert.equal(receiptWait(neg, { linked: 'none', business: 'shopify' }, { free: new Set(), wordings: [], assumesUnread: new Set(), ownIbans: new Set(), settles: settlementAccount(context), inputTax: true }).wait, true);
});

// ─── Edited orders with an outstanding balance, refunds of a filed period (#231) ─

/** An order export with Shopify's Outstanding Balance column: what an order edited after checkout has not charged yet (invented figures). */
const OPEN_HEAD = `${head},Outstanding Balance`;
const openRow = (order: string, day: string, total: string, tax: string, outstanding: string, country = 'CH') => `#${order},${day} 10:00:00 +0100,CHF,${tax},${total},${country},0.00,${day} 09:00:00 +0100,Shopify Payments,${outstanding}`;
const EDITED = [OPEN_HEAD,
  // 238.00 with DE VAT 38.00, of which 119.00 outstanding: 119.00 charged, its tax 19.00.
  openRow('9701', '2026-11-06', '238.00', '38.00', '119.00', 'DE'),
  // 162.15 with Swiss VAT 12.15, of which 54.05 outstanding: 108.10 charged, its tax 8.10.
  openRow('9702', '2026-11-10', '162.15', '12.15', '54.05'),
  openRow('9703', '2026-11-12', '54.05', '4.05', '0.00'),
].join('\n');
const charges = (...rows: Array<[string, string, string]>) => ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
  ...rows.map(([order, day, amount]) => `${day} 10:00:00 +0100,charge,#${order},${amount},1.00,${amount},CHF`)].join('\n');

test('#231 an edited order with an outstanding balance: the sale is the total less it, its tax in the same share, a foreign VAT too', () => {
  const read = salesOf(EDITED);
  assert.deepEqual(read.rows.map((o) => [o.order, o.gross, o.tax, o.outstanding]), [['9701', 119, 19, 119], ['9702', 108.1, 8.1, 54.05], ['9703', 54.05, 4.05, undefined]]);
  const out = bookReport({ journalEntries: [] }, read, ctxOf(NOV));
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-9701', '2026-11-06', '1093', '3200', 100, 'V0'],
    ['SR-shopify-9701', '2026-11-06', '1093', '2201', 19, ''],
    ['SR-shopify-9702', '2026-11-10', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-9703', '2026-11-12', '1093', '3200', 54.05, 'V81'],
  ]);
  assert.equal(balanceOf(out.entries, '1093'), 119 + 108.1 + 54.05, 'the clearing account holds what was charged, never the outstanding balance');
});

test('#231 with the payments export: each charge day its own part (cash basis), a foreign VAT split to the cent; charges that do not add up hold the order, never booked with the difference', () => {
  const pay = paymentsOf(charges(['9701', '2026-11-06', '59.50'], ['9701', '2026-11-08', '59.50'], ['9702', '2026-11-03', '54.05'], ['9702', '2026-11-10', '54.05'], ['9703', '2026-11-12', '50.00']));
  const out = bookReport({ journalEntries: [] }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay }));
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-9701', '2026-11-06', '1093', '3200', 50, 'V0'],
    ['SR-shopify-9701', '2026-11-06', '1093', '2201', 9.5, ''],
    ['SR-shopify-9701-charge-2026-11-08', '2026-11-08', '1093', '3200', 50, 'V0'],
    ['SR-shopify-9701-charge-2026-11-08', '2026-11-08', '1093', '2201', 9.5, ''],
    ['SR-shopify-9702', '2026-11-03', '1093', '3200', 54.05, 'V81'],
    ['SR-shopify-9702-charge-2026-11-10', '2026-11-10', '1093', '3200', 54.05, 'V81'],
  ]);
  assert.deepEqual(out.held, [{ order: '9703', why: 'charges' }], 'charged 50.00 of 54.05: it waits');
  assert.equal(out.orders, 2);
  const again = bookReport({ journalEntries: out.entries }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay }));
  assert.deepEqual([again.entries, again.known], [[], 4], 'read again: every part known, none twice');

  // An odd share: charges of 39.67 + 39.67 + 39.66 on 119.00 with 19.00 tax: the parts' tax adds up to the order's exactly.
  const odd = bookReport({ journalEntries: [] }, salesOf([OPEN_HEAD, openRow('9701', '2026-11-06', '238.00', '38.00', '119.00', 'DE')].join('\n')), ctxOf({ ...NOV, payments: paymentsOf(charges(['9701', '2026-11-04', '39.67'], ['9701', '2026-11-05', '39.67'], ['9701', '2026-11-06', '39.66'])) }));
  assert.equal(odd.entries.filter((e) => e.accountCredit === '2201').reduce((s, e) => s + Math.round(e.amount * 100), 0), 1900);
  assert.equal(balanceOf(odd.entries, '1093'), 119);
});

test('#231 #242 the app\'s one-sum sale of the open period is split per charge day once the charges are in; on the agreed basis the charges are checked, the order\'s day stays the tax point', () => {
  const whole = bookReport({ journalEntries: [] }, salesOf(EDITED), ctxOf(NOV)).entries;
  const pay = paymentsOf(charges(['9701', '2026-11-04', '119.00'], ['9702', '2026-11-03', '54.05'], ['9702', '2026-11-10', '54.05'], ['9703', '2026-11-12', '54.05']));
  const later = bookReport({ journalEntries: whole }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay }));
  assert.deepEqual(lines(later.entries), [
    ['SR-shopify-9701', '2026-11-04', '1093', '3200', 100, 'V0'],
    ['SR-shopify-9701', '2026-11-04', '1093', '2201', 19, ''],
    ['SR-shopify-9702', '2026-11-03', '1093', '3200', 54.05, 'V81'],
    ['SR-shopify-9702-charge-2026-11-10', '2026-11-10', '1093', '3200', 54.05, 'V81'],
  ], 'each charge on its day, as with the payments export first; #9703 charged on its day stays');
  assert.deepEqual(later.replaced.sort(), whole.filter((e) => e.transactionRef !== 'SR-shopify-9703').map((e) => e.id).sort());
  assert.equal(later.held.length, 0);
  const now = [...whole.filter((e) => !later.replaced.includes(e.id)), ...later.entries];
  assert.deepEqual(lines(now).sort(), lines(bookReport({ journalEntries: [] }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay })).entries).sort(), 'the books of the payments export first');
  assert.deepEqual(bookReport({ journalEntries: now }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay })).entries, [], 'taken again: known');
  // A person's sale, a filed one, or one a person linked a receipt to stays as booked.
  const hers = whole.map((e) => (e.transactionRef === 'SR-shopify-9702' ? { ...e, origin: 'manual' as const, by: { kind: 'person' as const, at: '2026-11-11T08:00:00Z' } } : e));
  assert.ok(!bookReport({ journalEntries: hers }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay })).entries.some((e) => e.transactionRef.startsWith('SR-shopify-9702')));
  const linked = bookReport({ journalEntries: whole, mappings: [{ transactionRef: 'SR-shopify-9702', receiptId: 'r', by: 'human' }] }, salesOf(EDITED), ctxOf({ ...NOV, payments: pay }));
  assert.ok(!linked.entries.some((e) => e.transactionRef.startsWith('SR-shopify-9702')) && !linked.replaced.some((id) => whole.find((e) => e.id === id)?.transactionRef === 'SR-shopify-9702'));
  const shut = bookReport({ journalEntries: whole }, salesOf(EDITED), ctxOf({ ...NOV, isClosed: (d) => d <= '2026-11-30', payments: pay }));
  assert.deepEqual([shut.entries, shut.replaced], [[], []], 'filed: never touched');

  const agreed = bookReport({ journalEntries: [] }, salesOf(EDITED), ctxOf({ ...NOV, agreed: true, payments: pay }));
  assert.deepEqual(lines(agreed.entries).filter((l) => String(l[0]).startsWith('SR-shopify-9702')), [['SR-shopify-9702', '2026-11-10', '1093', '3200', 108.1, 'V81']]);
  const differ = bookReport({ journalEntries: [] }, salesOf(EDITED), ctxOf({ ...NOV, agreed: true, payments: paymentsOf(charges(['9702', '2026-11-10', '100.00'])) }));
  assert.ok(differ.held.some((h) => h.order === '9702' && h.why === 'charges'));
});

test('#231 the outstanding balance charged later is booked when it is charged, as its own part; a charge day the books carry otherwise holds it, never twice', () => {
  const first = salesOf([OPEN_HEAD, openRow('9704', '2026-11-03', '162.15', '12.15', '54.05')].join('\n'));
  const booked = bookReport({ journalEntries: [] }, first, ctxOf(NOV)).entries;
  assert.deepEqual(lines(booked), [['SR-shopify-9704', '2026-11-03', '1093', '3200', 108.1, 'V81']]);
  // The next export: nothing outstanding, «Paid at» the day of the last charge.
  const paid = salesOf([OPEN_HEAD, openRow('9704', '2026-11-20', '162.15', '12.15', '0.00')].join('\n'));
  const rest = bookReport({ journalEntries: booked }, paid, ctxOf(NOV));
  assert.deepEqual(lines(rest.entries), [['SR-shopify-9704-charge-2026-11-20', '2026-11-20', '1093', '3200', 54.05, 'V81']]);
  const all = [...booked, ...rest.entries];
  assert.equal(balanceOf(all, '1093'), 162.15);
  assert.deepEqual(bookReport({ journalEntries: all }, paid, ctxOf(NOV)).entries, [], 'read again: nothing new');
  assert.deepEqual(bookReport({ journalEntries: all }, paid, ctxOf({ ...NOV, payments: paymentsOf(charges(['9704', '2026-11-03', '108.10'], ['9704', '2026-11-20', '54.05'])) })).entries, [], 'the charges say the same');
  const other = bookReport({ journalEntries: all }, paid, ctxOf({ ...NOV, payments: paymentsOf(charges(['9704', '2026-11-03', '108.10'], ['9704', '2026-11-19', '54.05'])) }));
  assert.deepEqual([other.entries, other.held], [[], [{ order: '9704', why: 'changed' }]], 'a part on another day: held, never booked beside the one the books carry');
});

/** November filed after the sales report booked its orders: a refund of 11-09 whose day a later payments export brings (invented figures). */
const FILED_REFUND = { isClosed: (d: string) => d <= '2026-11-30', since: '2026-11-01', from: '2026-11-01', foreignTax: '2201' };
test('#231 a refund paid in a filed period the books never carried is offered, never booked by itself; the person\'s click books it in the open period with corrects', () => {
  const sold = salesOf([head, refundRow('9801', '2026-11-03', '119.00', '19.00', '0.00', 'DE')].join('\n'));
  const booked = bookReport({ journalEntries: [] }, sold, ctxOf({ ...FILED_REFUND, isClosed: () => false })).entries;
  const refunded = salesOf([head, refundRow('9801', '2026-11-03', '119.00', '19.00', '59.50', 'DE'), refundRow('9802', '2026-11-04', '54.05', '4.05', '20.00')].join('\n'));
  const pay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9801,-59.50,0.00,-59.50,CHF', '2026-11-10 10:00:00 +0100,refund,#9802,-20.00,0.00,-20.00,CHF'].join('\n'));
  const out = bookReport({ journalEntries: booked }, refunded, ctxOf({ ...FILED_REFUND, payments: pay }));
  assert.deepEqual(out.entries, [], 'nothing booked by itself');
  assert.deepEqual(out.filedRefunds, [{ order: '9801', date: '2026-11-09', amount: 59.5, currency: 'CHF' }]);
  assert.equal(out.filed, 2, '#9802, sale and refund, the books never carried: only counted, a payout booked as sales may have netted them');

  const click = bookReport({ journalEntries: booked }, refunded, ctxOf({ ...FILED_REFUND, payments: pay, correct: { order: '9801', date: '2026-11-09', on: '2026-12-01', corrects: '2026-Q4', at: '2026-12-02T08:00:00Z', text: 'Shopify, Rückerstattung #9801 vom 09.11.2026, Korrektur 2026-Q4' } }));
  assert.deepEqual(lines(click.entries), [
    ['SR-shopify-9801-refund-2026-11-09', '2026-12-01', '3200', '1093', 50, '-V0'],
    ['SR-shopify-9801-refund-2026-11-09', '2026-12-01', '2201', '1093', 9.5, ''],
  ]);
  assert.ok(click.entries.every((e) => e.corrects === '2026-Q4' && e.origin === 'manual' && e.by?.kind === 'person' && e.receipts?.includes('rep')));
  assert.deepEqual([click.corrected, click.filedRefunds], [['SR-shopify-9801-refund-2026-11-09'], []]);
  const after = bookReport({ journalEntries: [...booked, ...click.entries] }, refunded, ctxOf({ ...FILED_REFUND, payments: pay }));
  assert.deepEqual([after.entries, after.filedRefunds], [[], []], 'booked once: known on every later taking, never offered again');
});

test('#231 the drop row and the report\'s receipt name the refund of a filed period; «Als Korrektur buchen» books it once as the person, declared in that quarter\'s correction', () => {
  const ws = shop(`${FILE()}  foreignTax: "2201"\n`);
  assert.ok(importSalesReport(ws, Buffer.from([head, refundRow('9801', '2026-11-03', '108.10', '8.10', '0.00')].join('\n')), 'a.csv').ok);
  const b = loadBooks(ws);
  b.config.closedThrough = '2026-11-30';
  saveBooks(ws, b);
  const pay = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-03 10:00:00 +0100,charge,#9801,108.10,3.44,104.66,CHF', '2026-11-09 10:00:00 +0100,refund,#9801,-20.00,0.00,-20.00,CHF'].join('\n');
  const later = [head, refundRow('9801', '2026-11-03', '108.10', '8.10', '20.00')].join('\n');
  assert.ok(importSalesReport(ws, Buffer.from(pay), 'p.csv').ok);
  const done = importSalesReport(ws, Buffer.from(later), 'b.csv');
  assert.ok(done.ok);
  const id = loadBooks(ws).receipts.find((r) => r.filename === done.summary.file)!.id;
  assert.deepEqual(done.summary.corrections, [id], 'the drop row lists the offer of the report that found it');
  assert.deepEqual(loadBooks(ws).receipts.find((r) => r.id === id)?.report?.filedRefunds, [{ order: '9801', date: '2026-11-09', amount: 20, currency: 'CHF', corrects: '2026-Q4' }]);

  const made = updateSaved(ws, PERSON, (books) => bookReportCorrection(ws, books, id, '9801', '2026-11-09', { now: new Date('2026-12-02T08:00:00Z') }));
  assert.ok(made.ok);
  const now = loadBooks(ws);
  assert.deepEqual(lines(now.journalEntries.filter((e) => e.corrects && e.transactionRef.startsWith('SR-'))), [['SR-shopify-9801-refund-2026-11-09', '2026-12-01', '3200', '1093', 20, '-V81']]);
  assert.match(now.journalEntries.find((e) => e.corrects && e.transactionRef.startsWith('SR-'))!.description ?? '', /Rückerstattung #9801 vom 09\.11\.2026, Korrektur 2026-Q4/);
  assert.equal(now.receipts.find((r) => r.id === id)?.report?.filedRefunds, undefined, 'offered no more');
  assert.deepEqual(updateSaved(ws, PERSON, (books) => bookReportCorrection(ws, books, id, '9801', '2026-11-09')), { ok: false, why: 'notOffered' }, 'a second click books nothing');
  for (const [csv, name] of [[pay, 'p.csv'], [later, 'b.csv']]) assert.ok(importSalesReport(ws, Buffer.from(csv), name).ok);
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-shopify-9801-refund')).length, 1, 'dropped again: the correction stays the only refund');
  assert.equal(loadBooks(ws).receipts.find((r) => r.id === id)?.report?.filedRefunds, undefined);
  assert.equal(removeSalesReport(ws, id), false, 'the person\'s correction keeps the report');
});

test('#231 POST /api/receipts/:id/report-correction books the offered refund as the person; a second click is refused with its code', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), `id: shopify\nprovider:\n${FILE()}`);
    const accounts = join(api.root, 'master-data', 'accounts.json');
    writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
    const ws = workspaceAt(api.root);
    assert.ok(importSalesReport(ws, Buffer.from([head, refundRow('9801', '2026-11-03', '108.10', '8.10', '0.00')].join('\n')), 'a.csv').ok);
    const b = loadBooks(ws);
    b.config.closedThrough = '2026-11-30';
    saveBooks(ws, b);
    assert.ok(importSalesReport(ws, Buffer.from(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9801,-20.00,0.00,-20.00,CHF'].join('\n')), 'p.csv').ok);
    const done = importSalesReport(ws, Buffer.from([head, refundRow('9801', '2026-11-03', '108.10', '8.10', '20.00')].join('\n')), 'b.csv');
    assert.ok(done.ok && done.summary.corrections.length === 1);
    const id = done.summary.corrections[0];
    const first = await api.send('POST', `/api/receipts/${id}/report-correction`, { order: '9801', date: '2026-11-09' });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(lines(first.json.entries as JournalEntry[]), [['SR-shopify-9801-refund-2026-11-09', '2026-12-01', '3200', '1093', 20, '-V81']]);
    assert.equal(loadBooks(ws).journalEntries.find((e) => e.transactionRef === 'SR-shopify-9801-refund-2026-11-09')?.corrects, '2026-Q4');
    const again = await api.send('POST', `/api/receipts/${id}/report-correction`, { order: '9801', date: '2026-11-09' });
    assert.deepEqual([again.status, again.json.code, again.json.params], [409, 'reportCorrection', { why: 'notOffered' }]);
  } finally {
    await api.stop();
  }
});

// ─── A cent of rounding, filed orders, refunds of a filed period in old entries (#239) ─

const SR = (ws: Workspace) => lines(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-')));

test('#239 an outstanding balance of -0.01: the sale is what was charged, a cent more, its tax in the same share; booked at the charge and never held, in either drop order', () => {
  const csv = [OPEN_HEAD, openRow('9911', '2026-11-04', '108.10', '8.10', '-0.01')].join('\n');
  assert.deepEqual(salesOf(csv).rows.map((o) => [o.gross, o.tax, o.outstanding]), [[108.11, 8.1, -0.01]]);
  const pay = charges(['9911', '2026-11-04', '108.11']);
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...NOV, payments: paymentsOf(pay) }));
  assert.deepEqual([lines(out.entries), out.held], [[['SR-shopify-9911', '2026-11-04', '1093', '3200', 108.11, 'V81']], []]);
  const books: Array<ReturnType<typeof SR>> = [];
  for (const order of [[pay, csv], [csv, pay]]) {
    const ws = shop();
    for (const [i, text] of order.entries()) assert.ok(importSalesReport(ws, Buffer.from(text), `${i}.csv`).ok);
    books.push(SR(ws));
    assert.deepEqual(heldOf(ws), [], 'nothing waits');
  }
  assert.deepEqual(books[0], [['SR-shopify-9911', '2026-11-04', '1093', '3200', 108.11, 'V81']]);
  assert.deepEqual(books[1], books[0], 'payments first or orders first: the same books');
});

test('#239 charges a cent beside the order are booked at the charges, the reason says so; more than a cent holds it; a sale booked before at the order\'s figure stays as booked', () => {
  const csv = [head, row('9921', '2026-11-05', '54.05', '4.05'), row('9922', '2026-11-06', '54.05', '4.05'), row('9923', '2026-11-07', '54.05', '4.05')].join('\n');
  const pay = paymentsOf(charges(['9921', '2026-11-05', '54.06'], ['9922', '2026-11-06', '54.04'], ['9923', '2026-11-07', '54.07']));
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...NOV, payments: pay }));
  assert.deepEqual(lines(out.entries), [['SR-shopify-9921', '2026-11-05', '1093', '3200', 54.06, 'V81'], ['SR-shopify-9922', '2026-11-06', '1093', '3200', 54.04, 'V81']]);
  assert.deepEqual(out.entries.map((e) => e.reason), ['domestic; cent 54.06 54.05', 'domestic; cent 54.04 54.05']);
  assert.deepEqual(out.held, [{ order: '9923', why: 'charges' }], 'two cents: it waits');
  // Booked before the payments export was in, at the order's figure: known, never held as changed, never booked again.
  const before = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf(NOV)).entries;
  const later = bookReport({ journalEntries: before }, salesOf(csv), ctxOf({ ...NOV, payments: pay }));
  assert.deepEqual([later.entries, later.held], [[], [{ order: '9923', why: 'charges' }]]);
  assert.equal(later.known, 2);
});

test('#239 an order of a filed period whose charges do not add up is counted as filed, never held; charged in the open period it still waits; its refund in the open period is booked', () => {
  const FILED = { ...NOV, isClosed: (d: string) => d <= '2026-11-30' };
  const csv = [head, refundRow('9931', '2026-11-10', '54.05', '4.05', '20.00'), refundRow('9932', '2026-11-12', '54.05', '4.05', '0.00')].join('\n');
  const pay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-10 10:00:00 +0100,charge,#9931,50.00,1.00,49.00,CHF', '2026-12-03 10:00:00 +0100,refund,#9931,-20.00,0.00,-20.00,CHF', '2026-12-02 10:00:00 +0100,charge,#9932,50.00,1.00,49.00,CHF'].join('\n'));
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...FILED, payments: pay }));
  assert.equal(out.filed, 1);
  assert.deepEqual(out.held, [{ order: '9932', why: 'charges' }], 'a charge of the open period: the person decides');
  assert.deepEqual(lines(out.entries), [['SR-shopify-9931-refund', '2026-12-03', '3200', '1093', 20, '-V81']]);
});

test('#239 a refund of a filed period whose sale sits in an old entry: one naming several orders (an old payout) or a sale booked elsewhere naming it is named for the hand, never booked on a click; one naming that order alone with its amount is offered', () => {
  const FILED = { ...NOV, isClosed: (d: string) => d <= '2026-11-30' };
  const csv = [head, refundRow('9941', '2026-10-05', '108.10', '8.10', '20.00'), refundRow('9942', '2026-10-05', '54.05', '4.05', '0.00'), refundRow('9943', '2026-10-06', '54.05', '4.05', '10.00'), refundRow('9944', '2026-10-07', '54.05', '4.05', '5.00'), refundRow('9945', '2026-10-08', '54.05', '4.05', '5.00')].join('\n');
  const refund = (order: string, amount: string) => `2026-11-09 10:00:00 +0100,refund,#${order},-${amount},0.00,-${amount},CHF`;
  const pay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', refund('9941', '20.00'), refund('9943', '10.00'), refund('9944', '5.00'), refund('9945', '5.00')].join('\n'));
  const legacy = {
    entries: [
      E('old1', 'TX-OLD1', '2026-10-07', '1093', '3200', 162.15, 'V81', { description: 'Shopify Auszahlung #9941 #9942' }),
      E('old2', 'SHOPIFY-9943', '2026-10-06', '1093', '3200', 54.05, 'V81', { description: 'Shopify #9943' }),
    ],
    named: [E('old3', 'TX-OLD3', '2026-10-09', '1021', '3200', 54.05, 'V81', { description: 'Shopify Auszahlung #9944' })],
  };
  const out = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...FILED, payments: pay, legacy }));
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.filedRefunds, [
    { order: '9941', date: '2026-11-09', amount: 20, currency: 'CHF', byHand: true },
    { order: '9943', date: '2026-11-09', amount: 10, currency: 'CHF' },
    { order: '9944', date: '2026-11-09', amount: 5, currency: 'CHF', byHand: true },
  ], '#9945: nothing names its sale, only counted');
  const correct = (order: string) => ({ order, date: '2026-11-09', on: '2026-12-01', corrects: '2026-Q4', at: '2026-12-02T08:00:00Z', text: `Korrektur #${order}` });
  const hand = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...FILED, payments: pay, legacy, correct: correct('9941') }));
  assert.deepEqual([hand.entries, hand.corrected], [[], []], 'a refund named for the hand is never booked on a click: the old payout may net it');
  const click = bookReport({ journalEntries: [] }, salesOf(csv), ctxOf({ ...FILED, payments: pay, legacy, correct: correct('9943') }));
  assert.deepEqual(lines(click.entries), [['SR-shopify-9943-refund-2026-11-09', '2026-12-01', '3200', '1093', 10, '-V81']]);
  assert.ok(click.entries.every((e) => e.corrects === '2026-Q4' && e.by?.kind === 'person'));
  const after = bookReport({ journalEntries: click.entries }, salesOf(csv), ctxOf({ ...FILED, payments: pay, legacy }));
  assert.deepEqual([after.entries, after.filedRefunds.map((f) => f.order)], [[], ['9941', '9944']], 'booked once, offered no more');
});

test('#239 the receipt of the report names a refund of a filed period whose sale a payout booked as sales names; «Als Korrektur buchen» refuses it', () => {
  const ws = shop();
  seed(ws, [], [E('old', 'TX-OLD', '2026-10-09', '1021', '3200', 54.05, 'V81', { description: 'Shopify Auszahlung #9951' })]);
  const b = loadBooks(ws);
  b.config.closedThrough = '2026-11-30';
  saveBooks(ws, b);
  assert.ok(importSalesReport(ws, Buffer.from(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9951,-5.00,0.00,-5.00,CHF'].join('\n')), 'p.csv').ok);
  const done = importSalesReport(ws, Buffer.from([head, refundRow('9951', '2026-10-07', '54.05', '4.05', '5.00')].join('\n')), 's.csv');
  assert.ok(done.ok);
  const id = loadBooks(ws).receipts.find((r) => r.filename === done.summary.file)!.id;
  assert.deepEqual(done.summary.corrections, [id], 'the drop row shows it');
  assert.deepEqual(loadBooks(ws).receipts.find((r) => r.id === id)?.report?.filedRefunds, [{ order: '9951', date: '2026-11-09', amount: 5, currency: 'CHF', byHand: true, corrects: '2026-Q4' }]);
  assert.deepEqual(updateSaved(ws, PERSON, (books) => bookReportCorrection(ws, books, id, '9951', '2026-11-09')), { ok: false, why: 'notOffered' });
  assert.deepEqual(SR(ws), []);
});

// ─── Corrections hold their order only, edited orders in either drop order, fees per day, refunds booked elsewhere (#242) ─

test('#242 a correction of a filed period naming one order with another amount holds that order only, never rows by its day; a correction naming none holds nothing; without corrects the old holds stay', () => {
  const read = salesOf([head, row('9601', '2026-11-02', '108.10', '8.10'), row('9602', '2026-11-05', '54.05', '4.05'), row('9603', '2026-11-20', '54.05', '4.05')].join('\n'));
  const ctx = (entries: JournalEntry[]) => ctxOf({ ...NOV, legacy: { entries } });
  const fix = E('k', 'M-K', '2026-11-25', '3200', '1093', 3.5, '-V81', { origin: 'manual', corrects: '2026-Q3', description: 'Korrektur Shopify #9602' });
  const one = bookReport({ journalEntries: [] }, read, ctx([fix]));
  assert.deepEqual([lines(one.entries).map((l) => l[0]), one.held], [['SR-shopify-9601', 'SR-shopify-9603'], [{ order: '9602', why: 'legacy' }]], 'the others are booked');
  const none = bookReport({ journalEntries: [] }, read, ctx([{ ...fix, description: 'Korrektur Rundung' }]));
  assert.deepEqual([none.entries.length, none.held], [3, []], 'a correction naming no order and matching none holds no row by its day');
  const plain = bookReport({ journalEntries: [] }, read, ctx([{ ...fix, corrects: undefined, description: 'Shopify Sammelbuchung' }]));
  assert.deepEqual(plain.held.map((h) => h.order), ['9601', '9602', '9603'], 'an entry naming none, no correction: every row up to its day, as before');
  const rest = bookReport({ journalEntries: [] }, read, ctx([{ ...fix, corrects: undefined, description: 'Shopify #9602 Rest' }]));
  assert.deepEqual([rest.entries.length, rest.held.map((h) => h.order)], [0, ['9601', '9602', '9603']], 'no correction, one order with another amount: every row up to its day, nothing booked twice beside it');
  const exact = bookReport({ journalEntries: [] }, read, ctx([E('s', 'M-S', '2026-11-25', '1093', '3200', 54.05, 'V81', { origin: 'manual', description: 'Shopify #9602' })]));
  assert.deepEqual([lines(exact.entries).map((l) => l[0]), exact.known, exact.held], [['SR-shopify-9601', 'SR-shopify-9603'], 1, []], 'no correction, one order with its net: that order\'s booking, the others booked');
});

test('#242 an edited order charged across a quarter end: orders first then payments, or payments first, give the same books; dropped again nothing changes', () => {
  const sold = salesOf([OPEN_HEAD, openRow('9611', '2027-01-05', '162.15', '12.15', '0.00')].join('\n'));
  const pay = paymentsOf(charges(['9611', '2026-12-28', '108.10'], ['9611', '2027-01-05', '54.05']));
  const ctx = { isClosed: () => false, since: '2026-11-01', from: '2026-11-01' };
  const paymentsFirst = bookReport({ journalEntries: [] }, sold, ctxOf({ ...ctx, payments: pay })).entries;
  assert.deepEqual(lines(paymentsFirst), [['SR-shopify-9611', '2026-12-28', '1093', '3200', 108.1, 'V81'], ['SR-shopify-9611-charge-2027-01-05', '2027-01-05', '1093', '3200', 54.05, 'V81']]);
  const ordersFirst = bookReport({ journalEntries: [] }, sold, ctxOf(ctx)).entries;
  assert.deepEqual(lines(ordersFirst), [['SR-shopify-9611', '2027-01-05', '1093', '3200', 162.15, 'V81']], 'without the charges: one sum on its day');
  const later = bookReport({ journalEntries: ordersFirst }, sold, ctxOf({ ...ctx, payments: pay }));
  const books = [...ordersFirst.filter((e) => !later.replaced.includes(e.id)), ...later.entries];
  assert.deepEqual(lines(books), lines(paymentsFirst), 'the same books: 108.10 in Q4, 54.05 in Q1');
  assert.deepEqual(bookReport({ journalEntries: books }, sold, ctxOf({ ...ctx, payments: pay })).entries, []);
  // Through the drop, in either order (both charge days in November here): the same books, no sale twice, none lost.
  const csv = [OPEN_HEAD, openRow('9612', '2026-11-20', '162.15', '12.15', '0.00')].join('\n');
  const fees = charges(['9612', '2026-11-03', '108.10'], ['9612', '2026-11-20', '54.05']);
  const got: Array<ReturnType<typeof SR>> = [];
  for (const order of [[csv, fees], [fees, csv]]) {
    const ws = shop();
    for (const [i, text] of order.entries()) assert.ok(importSalesReport(ws, Buffer.from(text), `${i}.csv`).ok);
    got.push(SR(ws).filter((l) => String(l[0]).startsWith('SR-shopify-9612')).sort());
    for (const [i, text] of order.entries()) assert.ok(importSalesReport(ws, Buffer.from(text), `${i}.csv`).ok);
    assert.deepEqual(SR(ws).filter((l) => String(l[0]).startsWith('SR-shopify-9612')).sort(), got.at(-1), 'dropped again: the same');
    assert.equal(revenueOf(loadBooks(ws).journalEntries), 162.15);
  }
  assert.deepEqual(got[0], [['SR-shopify-9612', '2026-11-03', '1093', '3200', 108.1, 'V81'], ['SR-shopify-9612-charge-2026-11-20', '2026-11-20', '1093', '3200', 54.05, 'V81']]);
  assert.deepEqual(got[1], got[0]);
});

test('#242 each charge\'s fee on its charge day; a fee booked in one before stays as booked; a fee of a filed day is counted', () => {
  const csv = ['Transaction Date,Type,Order,Amount,Fee,Net,Currency',
    '2026-11-03 10:00:00 +0100,charge,#9621,108.10,3.44,104.66,CHF',
    '2026-11-20 10:00:00 +0100,charge,#9621,54.05,1.87,52.18,CHF',
    '2026-11-20 11:00:00 +0100,charge,#9622,54.05,1.87,52.18,CHF'].join('\n');
  const read = readReport(csv, 'fees', SHOPIFY.provider);
  assert.ok(!('missing' in read) && read.kind === 'fees');
  const out = bookReport({ journalEntries: [] }, read, ctxOf(NOV));
  assert.deepEqual(lines(out.entries), [
    ['SF-shopify-9621', '2026-11-03', '6840', '1093', 3.44, 'I0'],
    ['SF-shopify-9621-charge-2026-11-20', '2026-11-20', '6840', '1093', 1.87, 'I0'],
    ['SF-shopify-9622', '2026-11-20', '6840', '1093', 1.87, 'I0'],
  ]);
  assert.deepEqual(bookReport({ journalEntries: out.entries }, read, ctxOf(NOV)).entries, [], 'read again: known');
  const summed = [E('f', 'SF-shopify-9621', '2026-11-20', '6840', '1093', 5.31, 'I0', { by: { kind: 'code', check: 'payoutReport' } })];
  const old = bookReport({ journalEntries: summed }, read, ctxOf(NOV));
  assert.deepEqual([lines(old.entries).map((l) => l[0]), old.held], [['SF-shopify-9622'], []], 'summed onto the last day by an older build: known, never booked again');
  const shut = bookReport({ journalEntries: [] }, read, ctxOf({ ...NOV, isClosed: (d) => d <= '2026-11-10' }));
  assert.deepEqual([lines(shut.entries).map((l) => l[0]), shut.filed], [['SF-shopify-9621-charge-2026-11-20', 'SF-shopify-9622'], 1], 'the fee of a filed day is counted, the open one booked');
});

test('#242 a filed order whose refunds are filed too is counted as filed, never held as refundMismatch; one refunded in the open period still is', () => {
  const FILED = { ...NOV, isClosed: (d: string) => d <= '2026-11-30' };
  const csv = salesOf([head, refundRow('9631', '2026-11-03', '54.05', '4.05', '0.00'), refundRow('9632', '2026-11-04', '54.05', '4.05', '0.00')].join('\n'));
  const pay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9631,-20.00,0.00,-20.00,CHF', '2026-12-02 10:00:00 +0100,refund,#9632,-20.00,0.00,-20.00,CHF'].join('\n'));
  const out = bookReport({ journalEntries: [] }, csv, ctxOf({ ...FILED, payments: pay }));
  assert.deepEqual(out.held, [{ order: '9632', why: 'refundMismatch' }]);
  assert.equal(out.filed, 3, 'both sales and #9631\'s refund check');
});

test('#242 a filed refund the books carry already, on revenue, paid from the bank directly or netted into the sale, is named with where it is booked, never offered; one booked nowhere still is', () => {
  const FILED = { ...NOV, isClosed: (d: string) => d <= '2026-11-30', moneyAccounts: ['1020'] };
  const orders = ['9641', '9642', '9643', '9644', '9645', '9646'];
  const sold = salesOf([head, ...orders.map((o) => refundRow(o, '2026-11-03', '108.10', '8.10', '0.00'))].join('\n'));
  const booked = bookReport({ journalEntries: [] }, sold, ctxOf({ ...FILED, isClosed: () => false })).entries;
  const refunded = salesOf([head, ...orders.map((o) => refundRow(o, '2026-11-03', '108.10', '8.10', '20.00'))].join('\n'));
  const pay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', ...orders.map((o, i) => `2026-11-${String(9 + i * 3).padStart(2, '0')} 10:00:00 +0100,refund,#${o},-20.00,0.00,-20.00,CHF`)].join('\n'));
  const elsewhere = [
    E('r1', 'M-R1', '2026-11-09', '3200', '6840', 20, undefined, { origin: 'manual', description: 'Umbuchung Rückerstattung #9641' }),
    E('r2', 'TX-R2', '2026-11-13', '3200', '1020', 20.01, '-V81', { description: 'Lastschrift Shopify' }),
    E('r3', 'M-R3', '2026-12-04', '3200', '1093', 20, '-V81', { origin: 'manual', corrects: '2026-Q4', description: 'Korrektur Rückerstattung' }),
    E('r4', 'M-R4', '2026-11-18', '1020', '6840', 20, undefined, { description: 'Gebühr #9644' }),
  ];
  const out = bookReport({ journalEntries: [...booked, ...elsewhere] }, refunded, ctxOf({ ...FILED, payments: pay }));
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.filedRefunds.map((f) => [f.order, f.booked?.entry ?? '']), [['9641', 'r1'], ['9642', 'r2'], ['9643', 'r3'], ['9644', ''], ['9645', ''], ['9646', '']],
    'on revenue naming it; on the bank directly at a sale code\'s minus a cent off on its days; a correction after it; a fee naming it books no refund');
  assert.deepEqual(out.filedRefunds[0].booked, { entry: 'r1', date: '2026-11-09', ref: 'M-R1' });
  for (const order of ['9641', '9642', '9643']) {
    const date = out.filedRefunds.find((f) => f.order === order)!.date;
    const click = bookReport({ journalEntries: [...booked, ...elsewhere] }, refunded, ctxOf({ ...FILED, payments: pay, correct: { order, date, on: '2026-12-01', corrects: '2026-Q4', at: '2026-12-02T08:00:00Z', text: 'K' } }));
    assert.deepEqual([click.entries, click.corrected], [[], []], `${order}: a click never books it twice`);
  }
  // Netted into the sale: the person booked #9647 at its gross less the refund, naming it alone.
  const netted = salesOf([head, refundRow('9647', '2026-11-03', '108.10', '8.10', '20.00')].join('\n'));
  const nettedPay = paymentsOf(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9647,-20.00,0.00,-20.00,CHF'].join('\n'));
  const sale = E('s', 'M-S', '2026-11-03', '1093', '3200', 88.1, 'V81', { origin: 'manual', description: 'Shopify #9647' });
  const n = bookReport({ journalEntries: [sale] }, netted, ctxOf({ ...FILED, payments: nettedPay, legacy: { entries: [sale] } }));
  assert.deepEqual(n.filedRefunds, [{ order: '9647', date: '2026-11-09', amount: 20, currency: 'CHF', booked: { entry: 's', date: '2026-11-03', ref: 'M-S' } }], 'netted: never byHand, never offered');
});

test('#242 through the drop: a filed refund booked on revenue by hand stays off the drop row, the report\'s receipt names where it is, «Als Korrektur buchen» refuses it', () => {
  const ws = shop();
  assert.ok(importSalesReport(ws, Buffer.from([head, refundRow('9651', '2026-11-03', '108.10', '8.10', '0.00')].join('\n')), 'a.csv').ok);
  seed(ws, [], [E('hand', 'M-HAND', '2026-11-09', '3200', '1093', 20, '-V81', { origin: 'manual', by: { kind: 'person', at: '2026-11-09T08:00:00Z' }, description: 'Rückerstattung Shopify #9651' })]);
  const b = loadBooks(ws);
  b.config.closedThrough = '2026-11-30';
  saveBooks(ws, b);
  assert.ok(importSalesReport(ws, Buffer.from(['Transaction Date,Type,Order,Amount,Fee,Net,Currency', '2026-11-09 10:00:00 +0100,refund,#9651,-20.00,0.00,-20.00,CHF'].join('\n')), 'p.csv').ok);
  const done = importSalesReport(ws, Buffer.from([head, refundRow('9651', '2026-11-03', '108.10', '8.10', '20.00')].join('\n')), 'b.csv');
  assert.ok(done.ok);
  assert.deepEqual(done.summary.corrections, [], 'nothing to click in the drop row');
  const id = loadBooks(ws).receipts.find((r) => r.filename === done.summary.file)!.id;
  assert.deepEqual(loadBooks(ws).receipts.find((r) => r.id === id)?.report?.filedRefunds, [{ order: '9651', date: '2026-11-09', amount: 20, currency: 'CHF', booked: { entry: 'hand', date: '2026-11-09', ref: 'M-HAND' }, corrects: '2026-Q4' }]);
  assert.deepEqual(updateSaved(ws, PERSON, (books) => bookReportCorrection(ws, books, id, '9651', '2026-11-09')), { ok: false, why: 'notOffered' });
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef.startsWith('SR-shopify-9651-refund')).length, 0);
});

// ─── A payment is the provider's payout by its own recognition, never by a linked order document (#247) ─

test('#247 a customer\'s bank deposit for an order, booked as a sale with its order page linked, holds nothing; a payment naming an order of another gateway holds nothing; a payout booked from the clearing account beside a correction of a filed period holds nothing; a real payout booked as sales still holds', () => {
  const csv = [head, row('2001', '2026-11-02', '108.10', '8.10'), row('2002', '2026-11-10', '54.05', '4.05'), row('2010', '2026-11-24', '54.05', '4.05', 'CH', 'Bank Deposit')].join('\n');
  const page = (order: string, day: string): Receipt => ({ id: `pg${order}`, filename: `${day.replaceAll('-', '')}-shopify-bestellung-${order}.pdf`, originalFilename: 'o.pdf', extractedText: `Shopify Bestellung #${order}`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-11-25T00:00:00Z', location: 'archived', date: day, kind: 'sales-record', order: { number: `#${order}`, date: day, currency: 'CHF', gross: 54.05, shipTo: 'CH', payouts: [], refunds: [] } });
  /** A workspace with Shopify's payout of 9.11. booked from the clearing account (its payouts are seen), these payments and entries, and these order pages linked. */
  const books = (txs: BankTransaction[], entries: JournalEntry[], links: Array<[string, Receipt]>) => {
    const ws = shop();
    const paid = payout('P1', { date: '2026-11-09', amount: 108.1 });
    seed(ws, [paid, ...txs], [E('p1', 'P1', '2026-11-09', '1021', '1093', 108.1), ...entries]);
    const b = loadBooks(ws);
    for (const [ref, r] of links) { b.receipts.push(r); b.mappings.push({ transactionRef: ref, receiptId: r.id, by: 'human' }); }
    saveBooks(ws, b);
    return ws;
  };
  const take = (ws: Workspace) => { const done = importSalesReport(ws, Buffer.from(csv), 'o.csv'); assert.ok(done.ok, JSON.stringify(done)); return done.summary; };

  // The customer paid order #2010 by bank transfer; the order page (a Shopify file by its name) is its proof.
  const dep = payout('DEP', { date: '2026-11-25', amount: 54.05, description: 'Gutschrift Hans Muster', counterparty: 'Hans Muster' });
  const deposit = take(books([dep], [E('dep', 'DEP', '2026-11-25', '1021', '3200', 54.05, 'V81', { origin: 'manual' })], [['DEP', page('2010', '2026-11-24')]]));
  assert.deepEqual([deposit.orders, deposit.other, deposit.held], [2, 1, []], 'the order page makes no payout: #2001 and #2002 booked, #2010 counted as paid otherwise');

  // The payment's reference names Shopify (so it is recognised as a payout), but its order page names #2010, paid otherwise.
  const named = payout('REF', { date: '2026-11-25', amount: 54.05, description: 'Gutschrift', counterparty: undefined, reference: 'Shopify Bestellung 2010' });
  const other = take(books([named], [E('ref', 'REF', '2026-11-25', '1021', '3200', 54.05, 'V81', { origin: 'manual' })], [['REF', page('2010', '2026-11-24')]]));
  assert.deepEqual([other.orders, other.held], [2, []], 'an order of another gateway holds nothing');

  // A payout booked from the clearing account, with a person's correction of filed Q1 on the same ref.
  const p2 = payout('P2', { date: '2026-11-20', amount: 54.05 });
  const corrected = take(books([p2], [E('p2', 'P2', '2026-11-20', '1021', '1093', 54.05), E('k2', 'P2', '2026-11-20', '6840', '1021', 2, undefined, { origin: 'manual', corrects: '2026-Q1', description: 'Korrektur zu e-old' })], []));
  assert.deepEqual([corrected.orders, corrected.held], [2, []], 'a correction of a filed period on the payout\'s ref makes it no payout booked as sales');

  // A real payout of Shopify booked as sales, with an order page linked, still holds every row up to its day.
  const ps = payout('PS', { date: '2026-11-21', amount: 54.05 });
  const sales = take(books([ps], [asSales(ps)], [['PS', page('2002', '2026-11-10')]]));
  assert.deepEqual([sales.orders, sales.held], [0, [{ order: '2001', why: 'legacy' }, { order: '2002', why: 'legacy' }]], 'never booked twice beside a payout booked as sales');
});
