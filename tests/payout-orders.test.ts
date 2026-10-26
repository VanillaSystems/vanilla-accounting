/**
 * A payment provider's payout with its order documents (issue #26): each order page names the
 * payout it went into (by the payout's date and the amount added, a refund by the amount deducted),
 * the match step links every order to the one payout they add up to, and the booking step books the
 * payout per order in code: each order's gross on the sales account, domestic at the firm's sale
 * code and abroad at the export code by the delivery country, a refund with the code's minus, the
 * provider's fees on the payout rule's fee account. The lines add up to the payout. Orders that do
 * not add up to it, or whose own tax line disagrees with the delivery country, book nothing: the
 * payout waits for the person, as without any document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { classifyStep } from '../src/intake/classify.js';
import { noteLines, type IntakeNote } from '../src/intake/pipeline.js';
import { linkOrdersToPayouts } from '../src/intake/order-links.js';
import { parseMatchResult } from '../src/llm/prompts.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, OrderFacts, Receipt } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const RULE = `process: booking\nsteps:\n  classify:\n    rules:\n      - id: shop-auszahlung
        when: { text: "Paynow" }
        then: { account: "3400", vat: V81, fees: { account: "6840", vat: I0 } }
        source: wish 2026-10-20
`;

/** The demo company (effective method) with a payout rule for a made-up provider, or none and the setup's answer «Auszahlungen: ja». */
function company({ rule = true } = {}): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'payout-orders-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  if (rule) {
    mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
    writeFileSync(join(dir, 'knowledge/rules/booking.guide.yaml'), RULE);
  } else {
    const manifest = join(dir, 'belege.workspace.yaml');
    const accounts = join(dir, 'master-data/accounts.json');
    writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '6580', name: 'Zahlungsanbietergebühren' }]));
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8').trimEnd()}\nprofile:\n  preset: webshop\n  fiscalYear: calendar\n  start: new\n  sells: goods\n  foreignCustomers: yes\n  imports: no\n  employees: none\n  ownerPaysPrivately: yes\n  privateUse: []\n  payouts: yes\n`);
  }
  return workspaceAt(dir);
}

const PAYOUT: BankTransaction = { ref: 'PAY-1', bank: 'Raiffeisen', date: '2026-08-14', amount: 357.5, currency: 'CHF', direction: 'CRDT', description: 'Paynow Ltd Auszahlung P-7781' };
const OTHER: BankTransaction = { ref: 'PAY-0', bank: 'Raiffeisen', date: '2026-07-21', amount: 48.3, currency: 'CHF', direction: 'CRDT', description: 'Paynow Ltd Auszahlung P-7702' };

const order = (number: string, o: Partial<OrderFacts>): OrderFacts =>
  ({ number, date: '2026-08-10', currency: 'CHF', gross: 0, shipTo: 'CH', payouts: [], refunds: [], ...o });

/** Two orders delivered in Switzerland, one to the US, and a refund of a July order, all named in the payout of 12 August. */
const ORDERS: Record<string, OrderFacts> = {
  o1001: order('1001', { gross: 120, tax: { country: 'CH', rate: 8.1 }, payouts: [{ date: '2026-08-12', amount: 116.2 }] }),
  o1002: order('1002', { gross: 80, tax: { country: 'CH', rate: 8.1 }, payouts: [{ date: '2026-08-12', amount: 77.4 }] }),
  o1003: order('1003', { gross: 200, shipTo: 'US', payouts: [{ date: '2026-08-12', amount: 193.9 }] }),
  o990: order('990', { date: '2026-07-15', gross: 50, tax: { country: 'CH', rate: 8.1 }, payouts: [{ date: '2026-07-20', amount: 48.3 }], refunds: [{ date: '2026-08-12', amount: 30 }] }),
};

const page = (id: string, facts: OrderFacts): Receipt =>
  ({ id, filename: `2026-order-${facts.number}.pdf`, extractedText: `Order #${facts.number}`, location: 'archived', kind: 'sales-record', date: facts.date, order: facts } as Receipt);

function booksOf(orders: Record<string, OrderFacts>, linked: readonly string[] = Object.keys(orders), closedThrough = '2026-06-30'): Books {
  return {
    transactions: [OTHER, PAYOUT], receipts: Object.entries(orders).map(([id, o]) => page(id, o)),
    mappings: linked.map((receiptId) => ({ transactionRef: PAYOUT.ref, receiptId })),
    bankStatements: [], journalEntries: [], config: { closedThrough },
  } as unknown as Books;
}

const lines = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e: JournalEntry) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
const fx = loadFxResolver();

test('a payout with its orders is booked per order in code: domestic at V81, export at V0, the refund at -V81, the fees on the rule\'s account; the lines add up to the payout', async () => {
  const ws = company();
  const books = booksOf(ORDERS);
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.asked, out.unasked, out.failed], [['PAY-1'], [], [], []], 'no model needed');
  assert.deepEqual(lines(books, 'PAY-1'), [
    ['1021', '3400', 120, 'V81'],
    ['1021', '3400', 80, 'V81'],
    ['1021', '3400', 200, 'V0'],
    ['3400', '1021', 30, '-V81'],
    ['6840', '1021', 12.5, 'I0'],
  ]);
  const signed = books.journalEntries.reduce((s, e) => s + (e.accountDebit === '1021' ? e.amount : -e.amount), 0);
  assert.equal(Math.round(signed * 100) / 100, PAYOUT.amount, 'what the bank received, to the Rappen');
  const [first] = books.journalEntries;
  assert.deepEqual([first.by, first.rule, first.date], [{ kind: 'rule', rule: 'shop-auszahlung' }, 'shop-auszahlung', PAYOUT.date], 'booked on the payment day (cash basis)');
  assert.match(first.description ?? '', /#1001/);
  assert.match(first.reason ?? '', /Bestellungen/);
  assert.deepEqual(first.receipts, ['o1001', 'o1002', 'o1003', 'o990']);
});

test('without a rule, the firm\'s answer «Auszahlungen: ja» gives the accounts: the revenue account of what it sells and the fee account the answer added', async () => {
  const ws = company({ rule: false });
  const books = booksOf(ORDERS);
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual(out.classified, ['PAY-1']);
  assert.deepEqual(lines(books, 'PAY-1').map((l) => l.slice(0, 2).concat(l[3])), [
    ['1021', '3200', 'V81'], ['1021', '3200', 'V81'], ['1021', '3200', 'V0'], ['3200', '1021', '-V81'], ['6580', '1021', 'I0'],
  ]);
  assert.deepEqual(books.journalEntries[0].by, { kind: 'code', check: 'payoutOrders' });

  const short = booksOf(ORDERS, ['o1001', 'o1003', 'o990']);
  const held = await classifyTransactions(short, [PAYOUT], { fx, context: loadClassifyContext(ws), ask: async () => { throw new Error('no model may guess past its orders'); } });
  assert.deepEqual([held.classified, held.asked, short.journalEntries], [[], [], []]);
  assert.deepEqual(held.failed.map((f) => f.ref), ['PAY-1'], 'without a rule to ask by, the payout is the person\'s to book');
  assert.match(held.failed[0].reason, /Bestellungen der Auszahlung/);
});

test('an order missing from the payout books nothing: the payout waits for the person, the question says what is missing, the proposal is today\'s whole payout as sales', async () => {
  const ws = company();
  const books = booksOf(ORDERS, ['o1001', 'o1003', 'o990']);
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, books.journalEntries], [[], []]);
  const [held] = out.asked;
  assert.equal(held.rule, 'shop-auszahlung');
  assert.match(held.question, /Bestellungen/);
  assert.match(held.question, /280\.10.*357\.50|357\.50.*280\.10/, 'what the linked orders add up to against what was paid out');
  assert.deepEqual(held.entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [['1021', '3400', 357.5, 'V81']]);
});

test('exports book at V0 whatever foreign tax their page shows (issue #74): the gross on sales, the foreign tax named in the reason, never a hold', async () => {
  const ws = company();
  const eu = order('1004', { gross: 119, shipTo: 'DE', tax: { country: 'DE', rate: 19 }, payouts: [{ date: '2026-08-12', amount: 115.2 }] });
  const uk = order('1005', { gross: 60, shipTo: 'GB', tax: { country: 'GB', rate: 20 }, payouts: [{ date: '2026-08-12', amount: 57.9 }] });
  const { o1003: _us, ...rest } = ORDERS;
  const books = booksOf({ ...rest, o1004: eu, o1005: uk });
  const payout = { ...PAYOUT, amount: 336.7 };
  books.transactions = [OTHER, payout];
  const out = await classifyTransactions(books, [payout], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.asked, out.failed], [['PAY-1'], [], []]);
  assert.deepEqual(lines(books, 'PAY-1'), [
    ['1021', '3400', 120, 'V81'],
    ['1021', '3400', 80, 'V81'],
    ['3400', '1021', 30, '-V81'],
    ['1021', '3400', 119, 'V0'],
    ['1021', '3400', 60, 'V0'],
    ['6840', '1021', 12.3, 'I0'],
  ]);
  const signed = books.journalEntries.reduce((s, e) => s + (e.accountDebit === '1021' ? e.amount : -e.amount), 0);
  assert.equal(Math.round(signed * 100) / 100, payout.amount, 'the lines add up to the payout');
  assert.match(books.journalEntries[0].reason ?? '', /#1004 DE 19 %, #1005 GB 20 %/, 'the foreign tax lines kept as facts in the reason');

  const untaxed = booksOf({ ...rest, o1004: eu, o1005: uk, o1001: { ...ORDERS.o1001, tax: undefined } });
  untaxed.transactions = [OTHER, payout];
  const held = await classifyTransactions(untaxed, [payout], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([held.classified, untaxed.journalEntries], [[], []], 'a domestic delivery without the Swiss tax still holds');
  assert.match(held.asked[0].question, /#1001/);
});

test('an order whose own tax line disagrees with its delivery country is the person\'s: nothing booked, the question names the order', async () => {
  const ws = company();
  const books = booksOf({ ...ORDERS, o1003: { ...ORDERS.o1003, tax: { country: 'CH', rate: 8.1 } } });
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, books.journalEntries], [[], []]);
  assert.match(out.asked[0].question, /#1003/);

  const untaxed = booksOf({ ...ORDERS, o1001: { ...ORDERS.o1001, tax: undefined } });
  const out2 = await classifyTransactions(untaxed, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out2.classified, untaxed.journalEntries], [[], []], 'a domestic delivery without the domestic tax: a new case');
  assert.match(out2.asked[0].question, /#1001/);
});

test('an order of which the payout holds less than half is taken for a part payment whose other part the page did not name: nothing booked, never the rest as fees', async () => {
  const ws = company();
  const books = booksOf({ ...ORDERS, o1003: { ...ORDERS.o1003, gross: 400 } });
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, books.journalEntries], [[], []]);
  assert.match(out.asked[0].question, /von Bestellung #1003 ist weniger als die Hälfte/);
});

test('without any order document the payout stays as today: the rule\'s question about the missing report', async () => {
  const ws = company();
  const books = booksOf({}, []);
  const out = await classifyTransactions(books, [PAYOUT], { fx, context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, books.journalEntries, out.asked.length], [[], [], 1]);
  assert.match(out.asked[0].question, /Auszahlungsbericht/);
});

test('the run\'s note names every payout its orders hold, each with its own reason (issue #76)', async () => {
  const ws = company();
  const books = booksOf({ ...ORDERS, o1003: { ...ORDERS.o1003, tax: { country: 'CH', rate: 8.1 } } });
  const september: BankTransaction = { ...PAYOUT, ref: 'PAY-3', date: '2026-09-14', amount: 90 };
  books.transactions.push(september);
  books.receipts.push(page('o2001', order('2001', { date: '2026-09-10', gross: 100, tax: { country: 'CH', rate: 8.1 }, payouts: [{ date: '2026-09-12', amount: 96 }] })));
  books.mappings.push({ transactionRef: september.ref, receiptId: 'o2001' });
  books.transactions = books.transactions.filter((t) => t.ref !== OTHER.ref);
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  const { notes } = await classifyStep()({ ws, books: port, progress: () => {}, log: () => {} });
  const held = notes.find((n): n is Extract<IntakeNote, { code: 'payoutsHeld' }> => n.code === 'payoutsHeld');
  assert.deepEqual(held?.payouts.map((p) => [p.date, p.amount, p.hold.why]), [['2026-08-14', 357.5, 'tax'], ['2026-09-14', 90, 'missing']]);
  assert.equal(notes.some((n) => n.code === 'asked'), false, 'not counted again as payments a rule asks about');
  const [line] = noteLines([held!]);
  assert.match(line, /2026-08-14 CHF 357\.50: the tax on order #1003 does not fit its delivery country/);
  assert.match(line, /2026-09-14 CHF 90\.00: the linked orders add up to 96\.00, the payout is 90\.00/);
});

test('the match step links the orders to the one payout they add up to, within days of the date they name, and only that', () => {
  const books = booksOf(ORDERS, []);
  const made = linkOrdersToPayouts(books);
  assert.deepEqual(made.filter((l) => l.payment === 'PAY-1').map((l) => l.receipt).sort(), ['o1001', 'o1002', 'o1003', 'o990']);
  assert.deepEqual(made.filter((l) => l.payment === 'PAY-0').map((l) => l.receipt), ['o990'], 'the July payout of order 990 adds up to its share alone');
  assert.deepEqual(linkOrdersToPayouts(books), [], 'run again: nothing new');
  assert.equal(books.mappings.length, 5);

  const apart = booksOf(ORDERS, []);
  apart.receipts.find((r) => r.id === 'o1002')!.notPaidBy = ['PAY-1'];
  assert.deepEqual(linkOrdersToPayouts(apart).filter((l) => l.payment === 'PAY-1'), [], 'a payout a person took an order apart from is hers (#187)');

  const missing = booksOf({ o1001: ORDERS.o1001, o1003: ORDERS.o1003 }, []);
  assert.deepEqual(linkOrdersToPayouts(missing), [], 'orders that do not add up to a payout are linked to none: never more than the payout');

  const twice = booksOf(ORDERS, []);
  twice.transactions.push({ ...PAYOUT, ref: 'PAY-2', date: '2026-08-13' });
  assert.deepEqual(linkOrdersToPayouts(twice).filter((l) => l.payment.startsWith('PAY-1') || l.payment === 'PAY-2'), [], 'two payouts of the same amount: neither');

  const filed = booksOf(ORDERS, [], '2026-09-30');
  assert.deepEqual(linkOrdersToPayouts(filed), [], 'a payout in a filed quarter is never linked (golden rule 1)');
});

test('the match step keeps an order\'s facts only when they hold together', () => {
  const base = { suggestedFilename: '20260810-order-1001.pdf', matchedTransactionRefs: [], date: '2026-08-10', description: 'Bestellung #1001', amount: 120, currency: 'CHF', confidence: 0.9 };
  const facts = { number: '1001', date: '2026-08-10', currency: 'CHF', gross: 120, shipTo: 'CH', tax: { country: 'CH', rate: 8.1 }, payouts: [{ date: '2026-08-12', amount: 116.2 }], refunds: [] };
  assert.deepEqual(parseMatchResult(JSON.stringify({ ...base, order: facts }))?.order, facts);
  assert.equal(parseMatchResult(JSON.stringify({ ...base, order: { ...facts, payouts: [{ date: '2026-08-12', amount: 130 }] } }))?.order, undefined, 'more paid out than the customer paid');
  assert.equal(parseMatchResult(JSON.stringify({ ...base, order: { ...facts, shipTo: 'Schweiz' } }))?.order, undefined, 'the country as its ISO code');
  assert.equal(parseMatchResult(JSON.stringify(base))?.order, undefined);
});

test('the order split knows no provider: no vendor\'s name in its code (ADR 0015)', () => {
  for (const file of ['src/booking/payout-orders.ts', 'src/intake/order-links.ts']) {
    assert.doesNotMatch(readFileSync(join(APP_ROOT, file), 'utf8'), /shopify|stripe|sumup|paypal|twint/i, file);
  }
});
