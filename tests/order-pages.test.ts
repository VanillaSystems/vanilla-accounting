/**
 * A provider's order page the provider way (#253): with its sales from the order export from the
 * cut-over day on, an order page waits for that export, never for a payment; it is paired with no
 * payment, not in «Braucht dich», and goes with its sale once the export booked it. Invented figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderPagesOf } from '../src/booking/order-pages.js';
import { linkOrdersToSales } from '../src/booking/sales-report.js';
import { orderOf, type Provider } from '../src/booking/providers.js';
import { searchPairs } from '../src/intake/pairing.js';
import { noPaymentOf } from '../src/booking/order-pages.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { loadBooks, moduleActor, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { orderPagesIn } from '../src/intake/pair-chain.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { badgeCount, ledgerOf, needsYou } from '../src/app/areas/receipts/model.js';
import type { BankTransaction, Index, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import './support/jurisdiction.js';

const APP = loadKnowledge(APP_ROOT, DEMO_ROOT).counterparties.find((c) => c.id === 'shopify') as Provider;
const SHOP = { ...APP, provider: { ...APP.provider, clearing: '1093', since: '2026-11-01' } } as Provider;

/** An order page as the read step and an older version left it: typed a sales record (kind-shopify-order), its text, no read order facts. */
const page = (id: string, date: string, text: string, over: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${date.replaceAll('-', '')}-verkauf.pdf`, originalFilename: 'o.pdf', extractedText: text, extractionMethod: 'pdftotext',
  fileSize: 1, indexedAt: `${date}T12:00:00Z`, location: 'archived', date, description: 'Verkauf', amount: 54.05, currency: 'CHF', kind: 'sales-record', ...over,
});
/** A supplier's invoice whose third line begins with its number, as Shopify's order page begins with its order's. */
const invoice = (id: string, over: Partial<Receipt> = {}): Receipt =>
  page(id, '2026-11-05', 'Muster Druck GmbH\nRechnung\n#2001 vom 05.11.2026\nTotal CHF 54.05 inkl. MWST 8.1%', { kind: 'invoice', ...over });
/** A second shop on the same platform: its own business file with the vendor's orderPage. */
const SHOP_B = { ...SHOP, id: 'laden-b', name: 'Laden B', match: { ...SHOP.match, tx: ['laden b'], uid: [], file: [] } } as Provider;
const saleOf = (provider: string, order: string, date: string): JournalEntry => ({ ...sale(order, date), id: `e-${provider}-${order}`, transactionRef: `SR-${provider}-${order}` });
const sale = (order: string, date: string): JournalEntry => ({ id: `e-${order}`, transactionRef: `SR-shopify-${order}`, date, accountDebit: '1093', accountCredit: '3200', amount: 54.05, vatCode: 'V81', origin: 'classify' });
const report = (to: string, held: Array<{ order: string; why: 'noTax' }> = []): Receipt =>
  ({ ...page('rep', to, 'Name,Paid at'), kind: 'sales-record', report: { provider: 'shopify', kind: 'sales', from: '2026-11-01', to, rows: 3, ...(held.length ? { held } : {}) } });
const deposit: BankTransaction = { ref: 'DEP', bank: 'Raiffeisen', date: '2026-11-03', amount: 54.05, currency: 'CHF', direction: 'CRDT', description: 'Gutschrift Hans Muster', counterparty: 'Hans Muster' };

test('an order page from the cut-over day on waits for the order export; one before it, one of another kind or one linked already does not', () => {
  const facts = { number: '2002', date: '2026-11-04', currency: 'CHF', gross: 54.05, shipTo: 'CH', payouts: [], refunds: [] };
  const receipts = [
    page('p1', '2026-11-03', '#2001\n\nPaid\n\nTotal CHF 54.05'),
    page('p2', '2026-11-04', 'Bestellung', { order: facts }),
    page('before', '2026-10-20', '#1990\nPaid'),
    page('linked', '2026-11-05', '#2003\nPaid'),
    page('invoice', '2026-11-05', 'Rechnung 77\nTotal CHF 54.05', { kind: 'invoice' }),
  ];
  const books = { receipts, mappings: [{ transactionRef: 'X', receiptId: 'linked' }] as Mapping[], journalEntries: [] };
  const pages = orderPagesOf(books, [SHOP]);
  assert.deepEqual([...pages.entries()], [
    ['p1', { provider: 'shopify', name: 'Shopify', order: '2001', state: { kind: 'export' } }],
    ['p2', { provider: 'shopify', name: 'Shopify', order: '2002', state: { kind: 'export' } }],
  ]);
  assert.equal(orderPagesOf(books, [APP]).size, 0, 'without a cut-over day the provider way is not used: pages wait for their payment as before');
});

test('once the export is in, the page names its booked sale, the export that holds its order, or is a receipt like any other when the export did not collect it', () => {
  const receipts = [page('booked', '2026-11-03', '#2001\nPaid'), page('held', '2026-11-04', '#2002\nPaid'), page('other', '2026-11-05', '#2010\nPaid'), report('2026-11-30', [{ order: '2002', why: 'noTax' }])];
  const pages = orderPagesOf({ receipts, mappings: [], journalEntries: [sale('2001', '2026-11-03')] }, [SHOP]);
  assert.deepEqual(pages.get('booked')?.state, { kind: 'booked', sale: 'SR-shopify-2001' });
  assert.deepEqual(pages.get('held')?.state, { kind: 'held', report: 'rep' });
  assert.equal(pages.has('other'), false, 'an order the export reached past without booking it was paid otherwise: its page waits for that payment');
  assert.equal(pages.has('rep'), false, 'the export itself is no order page');
});

test('a page known only by the provider\'s orderPage is linked to its sale; one linked to anything keeps its links', () => {
  const books = { receipts: [page('p1', '2026-11-03', '#2001\nPaid'), page('kept', '2026-11-04', '#2002\nPaid')], mappings: [{ transactionRef: 'DEP', receiptId: 'kept', by: 'human' }] as Mapping[], journalEntries: [sale('2001', '2026-11-03'), sale('2002', '2026-11-04')] };
  assert.deepEqual(linkOrdersToSales(books, () => true, [SHOP]), [{ receipt: 'p1', sale: 'SR-shopify-2001' }]);
  assert.deepEqual(books.mappings.filter((m) => m.receiptId === 'kept'), [{ transactionRef: 'DEP', receiptId: 'kept', by: 'human' }]);
});

test('an order page is never paired with a bank payment of its amount and day', () => {
  const books = { receipts: [page('p1', '2026-11-03', '#2001\nPaid\nHans Muster', { kind: 'sales-record' })], transactions: [deposit], mappings: [] as Mapping[] };
  const toChf = (a: number) => a;
  assert.ok(searchPairs(books, toChf, () => false).byReceipt.get('p1')?.length, 'without the provider way the deposit is its candidate');
  assert.equal(searchPairs(books, toChf, () => false, { noPayment: noPaymentOf(books, [SHOP]) }).byReceipt.has('p1'), false);
});

test('Belege: an order page waiting for the export needs nobody and counts in no badge', () => {
  const books = { receipts: [page('p1', '2026-11-03', '#2001\nPaid')], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-10-31' } } as unknown as Index;
  const plain = ledgerOf(books, '2026-11-01');
  assert.equal(needsYou(plain.byId.get('p1')!, plain), true, 'without the order pages it would wait for a payment');
  const l = ledgerOf(books, '2026-11-01', undefined, orderPagesOf(books, [SHOP]));
  assert.equal(l.byId.get('p1')!.orderPage?.state.kind, 'export');
  assert.equal(needsYou(l.byId.get('p1')!, l), false);
  assert.equal(badgeCount(l), 0);
});

test('the inbox: the model\'s sure match of an order page to a customer\'s deposit links nothing; the page waits for the export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'order-pages-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-04-01\n  revenue: "3200"\n');
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { b.transactions.push({ ...deposit, date: '2026-04-15', amount: 123.45, source: 'manual' }); });
  saveBooks(ws, books);
  mkdirSync(ws.paths.inbox, { recursive: true });
  // Printed from the browser: its two header lines (the time, the admin's title) name Shopify; the page begins after them.
  writeFileSync(join(ws.paths.inbox, 'bestellung.pdf'), await textPdf(['15.04.26, 12:00', '#2001 · Bestellungen · Muster Laden · Shopify', '#2001', 'Paid', 'Hans Muster', '15.04.2026', 'Total CHF 123.45']));
  const asked: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    asked.push(opts.step);
    if (opts.step === 'receipt-pair') {
      const list = JSON.parse(prompt.slice(prompt.indexOf('\n\n[') + 2, prompt.lastIndexOf(']\n\n') + 1)) as Array<{ i: number }>;
      return JSON.stringify(list.map((x) => ({ i: x.i, fits: true, why: 'stub' })));
    }
    if (opts.step === 'receipt-match') return JSON.stringify({ suggestedFilename: '20260415-verkauf-2001.pdf', date: '2026-04-15', description: 'Verkauf #2001', amount: 123.45, currency: 'CHF', matchedTransactionRefs: ['DEP'], confidence: 0.95 });
    return '{}';
  };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: [['read', readStep], ['match', matchStep]] });
  const after = loadBooks(ws);
  const r = after.receipts.find((x) => x.originalFilename === 'bestellung.pdf')!;
  assert.equal(r.location, 'archived', asked.join(' '));
  assert.deepEqual(after.mappings.filter((m) => m.receiptId === r.id || m.transactionRef === 'DEP'), [], 'neither code nor the model links it to the deposit');
  assert.deepEqual(orderPagesIn(ws, after)[r.id], { provider: 'shopify', name: 'Shopify', order: '2001', state: { kind: 'export' } });
});

test('a supplier invoice or a payout page whose line begins with #<digits> is no order page: never linked to the sale of that number, never kept from its payment', () => {
  const receipts = [
    invoice('inv'),
    invoice('untyped', { kind: undefined }),
    page('payout', '2026-11-05', '#2001\nPayout\nTotal CHF 54.05', { kind: undefined, payout: { sales: 54.05, refunds: 0, fees: 0, paidOut: 54.05 } }),
  ];
  const books = { receipts, mappings: [] as Mapping[], journalEntries: [sale('2001', '2026-11-03')] };
  assert.deepEqual([...orderPagesOf(books, [SHOP]).keys()], [], 'each waits for its own payment');
  assert.deepEqual(linkOrdersToSales(books, () => true, [SHOP]), []);
  assert.deepEqual(books.mappings, []);
  assert.equal(orderOf(invoice('x'), SHOP), undefined, 'the payout\'s legacy check takes no invoice for an order document either');
  assert.equal(orderOf(page('p', '2026-11-03', '#2001\nPaid'), SHOP), '2001');
});

test('two shops on the same platform: a page goes to the shop it names, and one no shop is named on is no order page of either', () => {
  const named = page('b1', '2026-11-03', '#2001\nPaid\nLaden B');
  const plain = page('p1', '2026-11-03', '#2001\nPaid');
  const books = { receipts: [named, plain], mappings: [] as Mapping[], journalEntries: [saleOf('shopify', '2001', '2026-11-03')] };
  const pages = orderPagesOf(books, [SHOP, SHOP_B]);
  assert.deepEqual([...pages.entries()], [['b1', { provider: 'laden-b', name: 'Laden B', order: '2001', state: { kind: 'export' } }]]);
  assert.deepEqual(linkOrdersToSales(books, () => true, [SHOP, SHOP_B]), [], 'Laden B\'s page never goes with the other shop\'s sale of the same number');
  books.journalEntries.push(saleOf('laden-b', '2001', '2026-11-03'));
  assert.deepEqual(linkOrdersToSales(books, () => true, [SHOP, SHOP_B]), [{ receipt: 'b1', sale: 'SR-laden-b-2001' }]);
});
