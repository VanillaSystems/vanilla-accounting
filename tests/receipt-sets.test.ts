/**
 * #27: several receipts that add up exactly to one payment (to the centime, its currency, one
 * vendor, near its date) are linked by code (src/intake/receipt-sets.ts) and booked one line per
 * receipt, each with its own VAT code (src/booking/receipt-lines.ts, the receipt rules per line in
 * src/booking/purchase-vat.ts). A sum off by a centime, or two sets that fit, is a proposal, never a
 * link. Synthetic receipts and payments, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkReceiptSets, proposalsFor, receiptSetsToLink } from '../src/intake/receipt-sets.js';
import { matchStep } from '../src/intake/match.js';
import { splitByReceipts } from '../src/booking/receipt-lines.js';
import type { Workspace } from '../src/workspace/workspace.js';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import './support/jurisdiction.js';

const open = (d: string) => d > '2026-06-30';
const VENDOR = 'CHE-111.222.333';

const pay = (amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref: 'P1', bank: 'Raiffeisen', date: '2026-08-12', amount, currency: 'CHF', direction: 'DBIT', description: 'Marktplatz Beispiel Bestellungen', ...over });

let n = 0;
const receipt = (amount: number, over: Partial<Receipt> = {}): Receipt => ({
  id: `r${++n}`, filename: `beleg-${n}.pdf`, location: 'archived', date: '2026-08-10', amount, currency: 'CHF', vatId: VENDOR,
  description: `Bestellung ${n}`, extractedText: `Marktplatz Beispiel Rechnung Bestellung ${700000 + n}`, ...over,
}) as Receipt;

const booksOf = (transactions: BankTransaction[], receipts: Receipt[], mappings: Mapping[] = []) =>
  ({ transactions, receipts, mappings, bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;

test('three receipts of one vendor that add up to the payment to the centime are linked, by the rule receipt-set', () => {
  const rs = [receipt(30), receipt(45.5), receipt(11.9)];
  const books = booksOf([pay(87.4)], rs);
  const linked = linkReceiptSets(books, open).sets;
  assert.deepEqual(linked.map((s) => [s.payment, s.receipts, s.sum, s.paid, s.exact]), [['P1', rs.map((r) => r.id).sort(), 87.4, 87.4, true]]);
  assert.deepEqual(books.mappings, rs.map((r) => ({ transactionRef: 'P1', receiptId: r.id, by: 'rule', rule: 'receipt-set' })));
  assert.deepEqual(proposalsFor(books, books.transactions[0], open).sets, [], 'nothing left to propose');
});

test('the inbox run\'s match step links such a set without the model', async () => {
  const books = booksOf([pay(87.4)], [receipt(30), receipt(45.5), receipt(11.9)]);
  const lines: string[] = [];
  await matchStep({ ws: { paths: { inbox: '/nowhere' } } as Workspace, books: { read: () => books, update: <T>(fn: (x: Books) => T) => fn(books) }, progress: () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(books.mappings.map((m) => m.transactionRef), ['P1', 'P1', 'P1']);
  assert.ok(lines.some((l) => /3 receipts that add up to the payment/.test(l)), lines.join('\n'));
});

test('off by a centime: no link, the set is a proposal that names its sum and the payment', () => {
  const rs = [receipt(30), receipt(45.5), receipt(11.9)];
  const books = booksOf([pay(87.41)], rs);
  assert.deepEqual(receiptSetsToLink(books, open).sets, []);
  assert.deepEqual(proposalsFor(books, books.transactions[0], open).sets.map((s) => [s.receipts, s.sum, s.paid, s.exact]), [[rs.map((r) => r.id).sort(), 87.4, 87.41, false]]);
});

test('foreign currency: receipts in the payment\'s currency are linked; the same figures against a payment in another currency link and propose nothing', () => {
  const eur = [receipt(19.99, { currency: 'EUR' }), receipt(25, { currency: 'EUR' })];
  const wise = booksOf([pay(44.99, { bank: 'Wise', currency: 'EUR' })], eur);
  assert.equal(receiptSetsToLink(wise, open).sets.length, 1, 'EUR receipts, EUR payment');
  const chf = booksOf([pay(44.99)], [receipt(19.99, { currency: 'EUR' }), receipt(25, { currency: 'EUR' })]);
  assert.deepEqual([receiptSetsToLink(chf, open).sets, proposalsFor(chf, chf.transactions[0], open).sets], [[], []], 'the bank amount in CHF is no sum of EUR amounts');
});

test('two sets that both fit are proposals, not links; receipts of two vendors make no set', () => {
  const two = booksOf([pay(50)], [receipt(20), receipt(30), receipt(25), receipt(25)]);
  assert.deepEqual(receiptSetsToLink(two, open).sets, []);
  assert.equal(proposalsFor(two, two.transactions[0], open).sets.filter((s) => s.exact).length, 2);
  const mixed = booksOf([pay(50)], [receipt(20), receipt(30, { vatId: 'CHE-999.888.777' })]);
  assert.deepEqual([receiptSetsToLink(mixed, open).sets, proposalsFor(mixed, mixed.transactions[0], open).sets], [[], []]);
});

test('a receipt that completes the one linked already is linked; never one that would make the receipts owe more than the payment', () => {
  const first = receipt(60);
  const rest = receipt(27.4);
  const books = booksOf([pay(87.4)], [first, rest, receipt(40)], [{ transactionRef: 'P1', receiptId: first.id, by: 'llm' }]);
  assert.deepEqual(receiptSetsToLink(books, open).sets.map((s) => [s.receipts, s.sum]), [[[rest.id], 87.4]]);
});

test('a refund paid back as one payment: the credit notes that add up to it are linked; a filed payment never', () => {
  const back = booksOf([pay(55, { direction: 'CRDT' })], [receipt(-20), receipt(-35)]);
  assert.equal(receiptSetsToLink(back, open).sets.length, 1);
  const credit = (gross: number) => receipt(gross, { vatSummary: [{ ratePercent: 8.1, vat: -Math.round(gross * 8.1 / 108.1 * 100) / 100, gross: -gross }] });
  const unsigned = booksOf([pay(55, { direction: 'CRDT' })], [credit(20), credit(35)]);
  assert.equal(receiptSetsToLink(unsigned, open).sets.length, 1, 'credit notes whose amount came unsigned count by their VAT (creditSigned)');
  const filed = booksOf([pay(87.4, { date: '2026-06-20' })], [receipt(30, { date: '2026-06-18' }), receipt(57.4, { date: '2026-06-18' })]);
  assert.deepEqual(receiptSetsToLink(filed, open).sets, []);
});

test('a vendor with more receipts near the payment than code tries is only proposed: a set among the others could fit as well', () => {
  const many = [receipt(30), receipt(57.4), ...Array.from({ length: 11 }, (_, i) => receipt(100 + i, { date: '2026-07-20' }))];
  const books = booksOf([pay(87.4)], many);
  assert.deepEqual(receiptSetsToLink(books, open).sets, []);
  assert.ok(proposalsFor(books, books.transactions[0], open).sets.some((s) => s.exact && s.receipts.length === 2));
});

test('nor is a set linked whose receipt lies among those another payment could not try every set of', () => {
  const shared = [receipt(30, { date: '2026-07-06' }), receipt(57.4, { date: '2026-07-06' })];
  const others = Array.from({ length: 11 }, (_, i) => receipt(200 + i, { date: '2026-08-01' }));
  const books = booksOf([pay(87.4, { ref: 'A', date: '2026-07-07' }), pay(999, { ref: 'B', date: '2026-08-06' })], [...shared, ...others]);
  assert.deepEqual(receiptSetsToLink(books, open).sets, []);
  assert.ok(proposalsFor(books, books.transactions[0], open).sets.some((s) => s.exact), 'A still gets the proposal');
});

test('the split keeps the sign of the model\'s line: a refund booked as one negative line becomes negative lines per credit note', () => {
  const notes = [receipt(-20), receipt(-35)];
  const lines = splitByReceipts(pay(55, { direction: 'CRDT' }), [{ accountDebit: '4200', accountCredit: '', amount: -55, vatCode: '-M0', description: 'Rückerstattung' }], notes);
  assert.deepEqual(lines.map((l) => l.amount), [-20, -35]);
});

const fx = loadFxResolver();
const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }, { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }] };
const model = (entries: ClassifyEntry[]): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Die Lesung des Modells.' }])));
};
const line = (accountDebit: string, amount: number, vatCode: string): ClassifyEntry => ({ accountDebit, accountCredit: '', amount, vatCode, description: 'Marktplatz' });
const vat81 = (gross: number) => ({ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: Math.round(gross * 8.1 / 108.1 * 100) / 100, gross }] });

async function book(tx: BankTransaction, receipts: Receipt[], entries: ClassifyEntry[]): Promise<JournalEntry[]> {
  const books = booksOf([tx], receipts, receipts.map((r) => ({ transactionRef: tx.ref, receiptId: r.id })));
  const { classified, failed } = await classifyTransactions(books, [tx], { ask: model(entries), fx, context });
  assert.deepEqual([classified, failed.map((f) => f.reason)], [[tx.ref], []]);
  return books.journalEntries;
}

const rows = (es: JournalEntry[]) => es.map((e) => [e.accountDebit, e.amount, e.vatCode ?? '']);

test('one line for three linked receipts is booked one line per receipt, each with the code its receipt shows', async () => {
  const rs = [receipt(30, vat81(30)), receipt(45.5, vat81(45.5)), receipt(11.9, { hasSwissVat: false })];
  const es = await book(pay(87.4), rs, [line('4200', 87.4, 'M81')]);
  assert.deepEqual(rows(es), [['4200', 30, 'M81'], ['4200', 45.5, 'M81'], ['4200', 11.9, 'M0']]);
  assert.deepEqual(es.map((e) => e.description), ['Bestellung ' + rs[0].id.slice(1), 'Bestellung ' + rs[1].id.slice(1), 'Bestellung ' + rs[2].id.slice(1)]);
});

test('the model\'s line per receipt keeps its account; each line\'s code follows its own receipt, not the others\'', async () => {
  const rs = [receipt(30, vat81(30)), receipt(11.9, { hasSwissVat: false })];
  const es = await book(pay(41.9), rs, [line('4200', 30, 'M0'), line('6500', 11.9, 'I81')]);
  assert.deepEqual(rows(es), [['4200', 30, 'M81'], ['6500', 11.9, 'I0']]);
});

test('a currency case: EUR receipts on a EUR payment are split; EUR receipts on a CHF payment leave the model\'s line as it is', async () => {
  const eur = [receipt(19.99, { currency: 'EUR', ...vat81(19.99) }), receipt(25, { currency: 'EUR', hasSwissVat: false })];
  const split = await book(pay(44.99, { bank: 'Wise', currency: 'EUR' }), eur, [line('4200', 44.99, 'M0')]);
  assert.deepEqual(rows(split), [['4200', 19.99, 'M81'], ['4200', 25, 'M0']]);
  assert.deepEqual(split.map((e) => e.exchangeCurrency), ['EUR', 'EUR']);
  const chf = await book(pay(42.1), [receipt(19.99, { currency: 'EUR' }), receipt(25, { currency: 'EUR' })], [line('4200', 42.1, 'M0')]);
  assert.deepEqual(rows(chf), [['4200', 42.1, 'M0']]);
});

test('with the wait for receipts (#29): the payment waits until the set is linked, then the run books it one line per receipt', async () => {
  const api = await startApi('tests/fixtures/sale-vat-index.json');
  try {
    const run = (steps: Parameters<typeof runIntake>[0]['steps']) => runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), ask: model([line('6570', 87.4, 'I81')]), steps });
    const b = loadBooks(api.ws);
    b.transactions.push(pay(87.4, { ref: 'W-1', date: '2026-08-12' }));
    saveBooks(api.ws, b);
    await run([['classify', classifyStep()]]);
    const waited = loadBooks(api.ws);
    assert.deepEqual([waited.journalEntries.filter((e) => e.transactionRef === 'W-1'), !!waited.transactions.find((t) => t.ref === 'W-1')!.waitsForReceipt], [[], true], 'no receipt yet: it waits');
    const rs = [receipt(30, vat81(30)), receipt(45.5, vat81(45.5)), receipt(11.9, { hasSwissVat: false })];
    waited.receipts.push(...rs);
    saveBooks(api.ws, waited);
    await run([['match', matchStep], ['classify', classifyStep()]]);
    const after = loadBooks(api.ws);
    assert.deepEqual(after.mappings.filter((m) => m.transactionRef === 'W-1').map((m) => m.receiptId).sort(), rs.map((r) => r.id).sort(), 'the match step linked the set');
    assert.deepEqual(rows(after.journalEntries.filter((e) => e.transactionRef === 'W-1')).sort((a, b) => Number(a[1]) - Number(b[1])), [['6570', 11.9, 'I0'], ['6570', 30, 'I81'], ['6570', 45.5, 'I81']]);
    assert.equal(after.transactions.find((t) => t.ref === 'W-1')!.waitsForReceipt, undefined, 'it waits no more');
  } finally { await api.stop(); }
});

test('a set a person took apart from the payment is never linked again (Receipt.notPaidBy, #187)', () => {
  const rs = [receipt(30), receipt(45.5, { notPaidBy: ['P1'] }), receipt(11.9)];
  const books = booksOf([pay(87.4)], rs);
  assert.deepEqual(linkReceiptSets(books, open).sets, []);
  assert.deepEqual(books.mappings, []);
});
