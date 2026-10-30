/**
 * A monthly charge and its invoices (#291): last month's invoice, lying unlinked beside the
 * document its own payment holds, is no pair for this month's payment; and when the chain paired it
 * anyway (its payment not in the books), this month's invoice takes the payment over while the link
 * and the booking are the app's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { BOUNDS, searchPairs } from '../src/intake/pairing.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import { entriesWithoutTheirReceipts } from '../src/accounting/classify-force.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';

const toChf = (a: number, c: string) => (c === 'EUR' ? a * 0.92 : a);
const invoice = (id: string, date: string, over: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `Streamly Ltd\nInvoice ${id}\nCHF 20.00`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date, amount: 20, currency: 'CHF', title: { vendor: 'Streamly', what: 'Abo' }, ...over,
});
const charge = (ref: string, date: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: 'Wise', date, amount: 21.7, currency: 'EUR', direction: 'DBIT', description: 'Card transaction of 20.00 CHF issued by Streamly *Abo DUBLIN', ...over,
});
const books = (receipts: Receipt[], transactions: BankTransaction[], over: Partial<Books> = {}): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-03-31' }, ...over }) as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const closed = (d: string) => d <= '2026-03-31';
const checked = (ref: string, receiptId: string): Mapping => ({ transactionRef: ref, receiptId, by: 'llm', rule: 'pair-checked:original+day+name' });
const booked = (ref: string, receipts: string[], over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}`, transactionRef: ref, date: '2026-07-07', accountDebit: '6570', accountCredit: '1023', amount: 21.7, vatCode: 'B81-1', description: 'Streamly, Abo', origin: 'classify', receipts, by: { kind: 'model', model: 'test' }, ...over }) as JournalEntry;

/** June's payment holds a scan of June's receipt code could not read; June's invoice, a second document of it, lies unlinked; July's payment is free. */
const june = () => books(
  [invoice('jun-receipt', '2026-06-07', { extractedText: '', date: undefined, amount: undefined, title: undefined }), invoice('jun-invoice', '2026-06-07')],
  [charge('pay-jun', '2026-06-07'), charge('pay-jul', '2026-07-07')],
  { mappings: [checked('pay-jun', 'jun-receipt')] },
);

test('last month\'s invoice is no candidate for this month\'s payment while the payment of its own day is taken', async () => {
  const b = june();
  assert.deepEqual(searchPairs(b, toChf, closed).byReceipt.get('jun-invoice'), []);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, []);
  assert.deepEqual(b.mappings, [checked('pay-jun', 'jun-receipt')]);
});

test('this month\'s invoice, arriving after the payment, pairs with it clearly', async () => {
  const b = june();
  b.receipts.push(invoice('jul-invoice', '2026-07-07'));
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked.map((l) => [l.receipt, l.payment]), [['jul-invoice', 'pay-jul']]);
});

test('two purchases of one amount a few days apart: a receipt keeps its own payment though another of its day is taken', async () => {
  const b = books(
    [invoice('a', '2026-07-01', { extractedText: '', date: undefined, amount: undefined, title: undefined }), invoice('b', '2026-07-01')],
    [charge('pay-a', '2026-07-01'), charge('pay-b', '2026-07-05')],
    { mappings: [checked('pay-a', 'a')] },
  );
  assert.deepEqual(searchPairs(b, toChf, closed).byReceipt.get('b')!.map((c) => c.payment), ['pay-b']);
  assert.ok(BOUNDS.period > 4);
});

/** June's invoice paired with July's payment and booked by it (June's payment is not in these books); July's invoice arrives. */
const paired = (over: { mapping?: Mapping; entry?: Partial<JournalEntry> } = {}) => books(
  [invoice('jun-invoice', '2026-06-07'), invoice('jul-invoice', '2026-07-07')],
  [charge('pay-jul', '2026-07-07')],
  { mappings: [over.mapping ?? checked('pay-jul', 'jun-invoice')], journalEntries: [booked('pay-jul', ['jun-invoice'], over.entry)] },
);

test('a newer invoice of the payment\'s own day takes over the chain\'s link of last month\'s, and the app books the payment again', async () => {
  const b = paired();
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked.map((l) => [l.receipt, l.payment, l.replaced]), [['jul-invoice', 'pay-jul', 'jun-invoice']]);
  assert.deepEqual(b.mappings.map((m) => [m.transactionRef, m.receiptId]), [['pay-jul', 'jul-invoice']]);
  assert.deepEqual(entriesWithoutTheirReceipts(b.journalEntries, b.mappings, new Set(['pay-jul']), '2026-03-31').map((e) => e.id), ['e-pay-jul'], 'the booking saw June\'s invoice: it is booked again');
});

test('a receipt still in the inbox comes back staged with the link it takes over', async () => {
  const b = paired();
  const jul = b.receipts.pop()!;
  const run = await runPairChain(port(b), { toChf, staged: [jul] });
  assert.deepEqual(run.staged.map((l) => [l.receipt, l.payment, l.replaced]), [['jul-invoice', 'pay-jul', 'jun-invoice']]);
  assert.deepEqual(b.mappings, [checked('pay-jul', 'jun-invoice')], 'the caller links it in its own change');
});

test('a person\'s link or a person\'s booking stands: the newer invoice takes nothing over', async () => {
  for (const b of [paired({ mapping: { transactionRef: 'pay-jul', receiptId: 'jun-invoice', by: 'human' } }), paired({ entry: { origin: 'manual' } }), paired({ entry: { by: { kind: 'person', at: '2026-07-08' } } })]) {
    const before = structuredClone(b.mappings);
    await runPairChain(port(b), { toChf });
    assert.deepEqual(b.mappings, before);
  }
});
