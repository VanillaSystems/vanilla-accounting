/**
 * Payment providers (#203): a shop platform's or card terminal's payout is a settlement, not a sale.
 * It is no candidate for any receipt (sets, the pair chain, the model's match, order links), needs
 * none, and is booked bank / the provider's clearing account without VAT, in code. The sales come
 * onto the clearing account from the provider's sales report, each order with its own code (Swiss
 * delivery V81, abroad V0, a refund with its minus), the fees from its fee report; order documents
 * go with their sale. At a period's close the review shows the clearing account, its month ends,
 * and what the provider paid out after the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { receiptKnowledge, receiptWait, noReceiptOfItsOwn, settlementAccount } from '../src/booking/receipt-wait.js';
import { clearingCheck, monthEnds, providerOfPayment, type Provider } from '../src/booking/providers.js';
import { amountOf, bookReport, csvRows, dayOf, linkOrdersToSales, readReport, recognizeReport, type ReportContext } from '../src/booking/sales-report.js';
import { mergeProvider, parseProvider } from '../src/knowledge/provider.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { linkReceiptSets } from '../src/intake/receipt-sets.js';
import { searchPairs } from '../src/intake/pairing.js';
import { bookPayoutReports, importSalesReport, providersOf, rebookPayouts, recognizeCsv, removeSalesReport, setProviderAccount } from '../src/intake/sales-report-import.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { parseRule } from '../src/booking/rules.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();

/** Shopify's order export as it writes it: one row per line of an order, the order's figures on its first. */
const ORDERS = [
  'Name,Email,Financial Status,Paid at,Currency,Subtotal,Shipping,Taxes,Total,Lineitem name,Shipping Country,Refunded Amount,Created at',
  '#1001,a@example.ch,paid,2026-07-03 14:22:10 +0200,CHF,100.00,8.10,8.10,108.10,Bohnen 500 g,CH,0.00,2026-07-02 22:10:00 +0200',
  '#1001,,,,,,,,,Filter,,,',
  '#1002,b@example.de,paid,2026-07-05 09:01:00 +0200,CHF,80.00,10.00,0.00,90.00,Bohnen 1 kg,DE,0.00,2026-07-05 08:00:00 +0200',
  '#1003,c@example.ch,partially_refunded,2026-08-11 10:00:00 +0200,CHF,50.00,4.05,4.05,54.05,Bohnen 250 g,CH,20.00,2026-08-11 09:00:00 +0200',
  '#1004,d@example.ch,paid,2026-08-12 10:00:00 +0200,CHF,40.00,0.00,0.00,40.00,Tasse,CH,0.00,2026-08-12 09:00:00 +0200',
  '#1000,e@example.ch,paid,2026-06-28 10:00:00 +0200,CHF,30.00,2.43,2.43,32.43,Bohnen 250 g,CH,0.00,2026-06-28 09:00:00 +0200',
].join('\n');

/** Shopify Payments' transactions export: a fee per charge. */
const FEES = [
  'Transaction Date,Type,Order,Amount,Fee,Net,Currency',
  '2026-07-03 14:22:10 +0200,charge,#1001,108.10,3.44,104.66,CHF',
  '2026-07-05 09:01:00 +0200,charge,#1002,90.00,2.91,87.09,CHF',
].join('\n');

const SHOPIFY = loadKnowledge(APP_ROOT, DEMO_ROOT).counterparties.find((c) => c.id === 'shopify') as Provider;

/** A copy of the demo whose Shopify file names its clearing account, revenue and fees, with the clearing account in its chart. */
function shop(provider = '  clearing: "1093"\n  revenue: "3200"\n  fees: { account: "6840", vat: I0 }\n'): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'providers-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), `id: shopify\n${provider ? `provider:\n${provider}` : ''}`);
  const accounts = join(dir, 'master-data', 'accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }], null, 2));
  return workspaceAt(dir);
}

const payout = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-07-07', amount: 191.75, currency: 'CHF', direction: 'CRDT', description: 'Gutschrift Shopify Payments', counterparty: 'Shopify Payments', ...over });

const lines = (es: readonly JournalEntry[]) => es.map((e) => [e.transactionRef, e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);

const ctxOf = (over: Partial<ReportContext> = {}): ReportContext => ({
  provider: { id: 'shopify', name: 'Shopify' }, clearing: '1093', revenue: '3200', fees: { account: '6840', vat: 'I0' }, receipt: 'rep', base: 'CHF',
  rate: (c, d) => fx.daily(c, d), codes: { domestic: 'V81', rate: 8.1, abroad: 'V0', negative: '-' }, territory: ['CH', 'LI'], agreed: false,
  isClosed: (d) => d <= '2026-06-30', beforeBooks: () => false, newId: (() => { let i = 0; return () => `e${++i}`; })(),
  texts: { sale: (o, c) => `Shopify, Bestellung #${o}, ${c}`, refund: (o) => `Shopify, Rückerstattung #${o}`, fee: (k) => `Shopify, Gebühren ${k}`, reason: (k) => k },
  ...over,
});

// ─── The provider's file ─────────────────────────────────────────────────────

test('the app\'s Shopify file names its report columns; the accounts belong to the company\'s file, never the app\'s', () => {
  assert.ok(SHOPIFY.provider.reports.sales?.order?.includes('Name'));
  assert.ok(SHOPIFY.provider.reports.fees?.fee?.includes('Fee'));
  assert.equal(SHOPIFY.provider.clearing, undefined, 'the app cannot know a chart');
  assert.match((mergeProvider({ clearing: '1093' }, undefined, true) as { problem: string }).problem, /one company's chart/);
  assert.deepEqual((mergeProvider({ reports: { sales: { order: 'Name', date: 'Paid at', gross: 'Total' } } }, { clearing: '1093' }, true) as { raw: unknown }).raw, { reports: { sales: { order: 'Name', date: 'Paid at', gross: 'Total' } }, clearing: '1093' });
  assert.match((parseProvider({ reports: { sales: { order: 'Name' } } }) as { problem: string }).problem, /needs the columns date, gross/);
  assert.match((parseProvider({ fees: { account: '6840' } }) as { problem: string }).problem, /provider\.fees must be/);
  assert.match((parseProvider({ clearings: '1093' }) as { problem: string }).problem, /provider\.clearings is unknown/);
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

test('a payout is booked bank / clearing account without VAT, in code; until the company\'s file names the clearing account it is booked as before', async () => {
  const ws = shop();
  const books = { transactions: [payout('P')], receipts: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const out = await classifyTransactions(books, books.transactions, { fx, context: loadClassifyContext(ws) });
  assert.deepEqual(out.classified, ['P']);
  assert.deepEqual(lines(books.journalEntries), [['P', '2026-07-07', '1021', '1093', 191.75, '']]);
  assert.deepEqual(books.journalEntries[0].by, { kind: 'code', check: 'payoutReport' });

  const bare = shop('');
  const before = { ...books, journalEntries: [] } as Books;
  const asBefore = await classifyTransactions(before, before.transactions, { fx, context: loadClassifyContext(bare) });
  assert.deepEqual([asBefore.classified, asBefore.unasked, before.journalEntries], [[], ['P'], []], 'without a model it waits for one, as any payment would');
});

// ─── 2. The sales report ─────────────────────────────────────────────────────

test('code reads an export as it writes it: its separator, quotes, amounts and days', () => {
  assert.deepEqual(csvRows('a;b\n"x;1";"he said ""hi"""\n'), [['a', 'b'], ['x;1', 'he said "hi"']]);
  assert.deepEqual(['1234.50', "1'234.50", '1.234,50', 'CHF 12.00', '-3.20', ''].map(amountOf), [1234.5, 1234.5, 1234.5, 12, -3.2, undefined]);
  assert.deepEqual(['2026-07-03 14:22:10 +0200', '2026-07-03T14:22:10Z', '03.07.2026', '07/03/2026'].map(dayOf), ['2026-07-03', '2026-07-03', '2026-07-03', undefined]);
  assert.deepEqual(recognizeReport(ORDERS, [SHOPIFY]), { provider: 'shopify', kind: 'sales' });
  assert.deepEqual(recognizeReport(FEES, [SHOPIFY]), { provider: 'shopify', kind: 'fees' });
  assert.equal(recognizeReport('Buchungsdatum;Valuta;Betrag;Saldo\n', [SHOPIFY]), undefined, 'a bank\'s CSV is no report');
});

test('each order on the clearing account with its own code: a Swiss delivery V81, abroad V0, a refund with the minus; a domestic order without VAT and one of a filed quarter are not booked', () => {
  const read = readReport(ORDERS, 'sales', SHOPIFY.provider);
  assert.ok(!('missing' in read) && read.kind === 'sales');
  assert.equal(read.rows.length, 5, 'the line rows of an order make one');
  const out = bookReport({ journalEntries: [] }, read, ctxOf());
  assert.deepEqual(lines(out.entries), [
    ['SR-shopify-1001', '2026-07-03', '1093', '3200', 108.1, 'V81'],
    ['SR-shopify-1002', '2026-07-05', '1093', '3200', 90, 'V0'],
    ['SR-shopify-1003', '2026-08-11', '1093', '3200', 54.05, 'V81'],
    ['SR-shopify-1003-refund', '2026-08-11', '3200', '1093', 20, '-V81'],
  ]);
  assert.deepEqual(out.held, [{ order: '1004', why: 'noTax' }], 'a Swiss delivery without VAT is the person\'s');
  assert.equal(out.filed, 1, '#1000 was paid in the filed quarter');
  assert.ok(out.entries.every((e) => e.origin === 'classify' && e.by?.kind === 'code' && e.receipts?.[0] === 'rep'));

  const again = bookReport({ journalEntries: out.entries }, read, ctxOf());
  assert.deepEqual([again.entries, again.known], [[], 4], 'read twice, each order once');
  const changed = bookReport({ journalEntries: out.entries.map((e) => (e.transactionRef === 'SR-shopify-1002' ? { ...e, amount: 85 } : e)) }, read, ctxOf());
  assert.ok(changed.held.some((h) => h.order === '1002' && h.why === 'changed'), 'other figures in the books are named, never booked over');
});

test('on the agreed basis the order\'s day is the tax point; a firm without codes books gross without one', () => {
  const read = readReport(ORDERS, 'sales', SHOPIFY.provider);
  if ('missing' in read) throw new Error('columns');
  const agreed = bookReport({ journalEntries: [] }, read, ctxOf({ agreed: true }));
  assert.equal(agreed.entries[0].date, '2026-07-02');
  const plain = bookReport({ journalEntries: [] }, read, ctxOf({ codes: undefined }));
  assert.ok(plain.entries.every((e) => !e.vatCode));
  assert.deepEqual(plain.held, [], 'without codes nothing disagrees');
});

test('the fee report books each fee against the clearing account at the company\'s fee code', () => {
  const read = readReport(FEES, 'fees', SHOPIFY.provider);
  if ('missing' in read) throw new Error('columns');
  assert.deepEqual(lines(bookReport({ journalEntries: [] }, read, ctxOf()).entries), [
    ['SF-shopify-1001', '2026-07-03', '6840', '1093', 3.44, 'I0'],
    ['SF-shopify-1002', '2026-07-05', '6840', '1093', 2.91, 'I0'],
  ]);
});

test('4. an order page is linked to its sale, never to the payout', () => {
  const read = readReport(ORDERS, 'sales', SHOPIFY.provider);
  if ('missing' in read) throw new Error('columns');
  const books = { receipts: [{ id: 'pg', order: { number: '1002', date: '2026-07-05', currency: 'CHF', gross: 90, shipTo: 'DE', payouts: [], refunds: [] } } as unknown as Receipt], mappings: [] as Books['mappings'], journalEntries: bookReport({ journalEntries: [] }, read, ctxOf()).entries };
  assert.deepEqual(linkOrdersToSales(books, () => true), [{ receipt: 'pg', sale: 'SR-shopify-1002' }]);
  assert.deepEqual(linkOrdersToSales(books, () => true), [], 'once');
});

// ─── The drop: recognised, filed, booked, asked once ─────────────────────────

test('a dropped sales report is filed as a receipt and booked onto the clearing account; the payouts the app booked as sales before are booked again from it', () => {
  const ws = shop();
  const books = loadBooks(ws);
  // A payout of the report's days that an older run booked as sales, as the demo's generator still does.
  books.transactions.push(payout('OLD', { date: '2026-07-07' }));
  books.journalEntries.push({ id: 'old', transactionRef: 'OLD', date: '2026-07-07', accountDebit: '1021', accountCredit: '3200', amount: 191.75, vatCode: 'V81', origin: 'classify', by: { kind: 'model', model: 'm' } });
  saveBooks(ws, books);
  assert.deepEqual(recognizeCsv(ws, Buffer.from(ORDERS)), { provider: 'shopify', name: 'Shopify', kind: 'sales' });
  const done = importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv');
  assert.ok(done.ok);
  // The demo is filed through Q1, so June's #1000 is booked too; its own Shopify payouts of July and August, booked as sales by its generator, are booked again with OLD.
  assert.deepEqual([done.summary.orders, done.summary.refunds, done.summary.filed, done.summary.rebooked, done.summary.held.map((h) => h.why)], [4, 1, 0, 3, ['noTax']]);
  const after = loadBooks(ws);
  const receipt = after.receipts.find((r) => r.report);
  assert.equal(receipt?.report?.provider, 'shopify');
  assert.ok(receipt && existsSync(join(ws.paths.root, 'transactional-data', '2026', 'receipts', receipt.filename)), 'the CSV is filed in its year');
  assert.deepEqual(lines(after.journalEntries.filter((e) => e.transactionRef === 'OLD')), [['OLD', '2026-07-07', '1021', '1093', 191.75, '']]);
  assert.equal(importSalesReport(ws, Buffer.from(ORDERS), 'orders_export.csv').ok && loadBooks(ws).journalEntries.length, after.journalEntries.length, 'dropped again, nothing twice');
  assert.equal(removeSalesReport(ws, receipt!.id), true);
  assert.equal(loadBooks(ws).journalEntries.some((e) => e.transactionRef.startsWith('SR-')), false, '«Rückgängig» takes its bookings back');
});

test('a person\'s booking of a payout stays as she made it', () => {
  const ws = shop();
  const books = loadBooks(ws);
  books.transactions.push(payout('MINE'));
  books.journalEntries.push({ id: 'mine', transactionRef: 'MINE', date: '2026-07-07', accountDebit: '1021', accountCredit: '3200', amount: 191.75, vatCode: 'V81', origin: 'manual' });
  const again = rebookPayouts(books, providersOf(ws).find((p) => p.id === 'shopify')!, '2026-07-01', '2026-07-31', loadClassifyContext(ws), fx);
  assert.equal(again.includes('MINE'), false);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.transactionRef === 'MINE')), [['MINE', '2026-07-07', '1021', '3200', 191.75, 'V81']]);
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

test('a card terminal\'s payout report read at the match step books its sales and fees onto the clearing account once', () => {
  const ws = shop();
  const books = loadBooks(ws);
  books.receipts.push({ id: 'po', filename: '20260731-shopify-auszahlung.pdf', originalFilename: 'po.pdf', extractedText: 'Shopify Payments Auszahlung Juli', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-08-01T00:00:00Z', location: 'archived', date: '2026-07-31', amount: 1412.35, currency: 'CHF', vatId: 'CHE-153.004.184', payout: { sales: 1480, refunds: 40, fees: 27.65, paidOut: 1412.35 } });
  assert.equal(bookPayoutReports(ws, books, fx), 1);
  assert.deepEqual(lines(books.journalEntries.filter((e) => e.receipts?.includes('po'))), [
    ['SR-shopify-po', '2026-07-31', '1093', '3200', 1480, 'V81'],
    ['SR-shopify-po-refund', '2026-07-31', '3200', '1093', 40, '-V81'],
    ['SF-shopify-po', '2026-07-31', '6840', '1093', 27.65, 'I0'],
  ]);
  assert.equal(bookPayoutReports(ws, books, fx), 0, 'once');
});

// ─── 3. The clearing check ───────────────────────────────────────────────────

test('the clearing check: the balance at the quarter\'s end, its month ends, and what the provider paid out after it', () => {
  assert.deepEqual(monthEnds('2026-09-30', 3), ['2026-07-31', '2026-08-31', '2026-09-30']);
  const p = { ...SHOPIFY, provider: { ...SHOPIFY.provider, clearing: '1093', payoutDays: 5 } } as Provider;
  const e = (id: string, date: string, d: string, c: string, amount: number, ref = id): JournalEntry => ({ id, transactionRef: ref, date, accountDebit: d, accountCredit: c, amount });
  const books = {
    transactions: [payout('P1', { date: '2026-09-10' }), payout('P2', { date: '2026-10-02' }), { ...payout('X', { date: '2026-10-06' }), direction: 'DBIT' as const }],
    journalEntries: [e('s1', '2026-08-30', '1093', '3200', 200, 'SR-shopify-1'), e('s2', '2026-09-29', '1093', '3200', 120, 'SR-shopify-2'), e('p1', '2026-09-10', '1021', '1093', 200, 'P1'), e('p2', '2026-10-02', '1021', '1093', 118, 'P2')],
  };
  const c = clearingCheck(p, books, '2026-09-30', 3)!;
  assert.deepEqual([c.balance, c.months.map((m) => m.balance), c.unpaid], [120, [0, 200, 120], 118]);
  const early = clearingCheck(p, { ...books, transactions: books.transactions.filter((t) => t.date <= '2026-10-02') }, '2026-09-30', 3)!;
  assert.equal(early.unpaid, undefined, 'the bank\'s payments through 5 days after the end are not in the books yet');
});
