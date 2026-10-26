/**
 * The matching chain (#187): code finds and scores the candidates, the model checks the clear
 * pairs in batches and chooses from short lists, the rest is the person's. Import order does not
 * matter, a person's unlink stands, a filed payment is pointed at, never linked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { CLEAR, SHORT_LIST, makerOf, originalOf, paysIn, searchPairs, signalsOf, stagesOf } from '../src/intake/pairing.js';
import { CHECK_BATCH, noReceiptFor, runPairChain } from '../src/intake/pair-chain.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { Books } from '../src/books/store.js';
import type { Ask } from '../src/intake/pipeline.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const toChf = (a: number, c: string) => (c === 'EUR' ? a * 0.94 : c === 'USD' ? a * 0.8 : a);
const receipt = (id: string, over: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: 'Rechnung', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date: '2026-08-10', amount: 42.5, currency: 'CHF', title: { vendor: 'Papeterie Meier', what: 'Büromaterial' }, ...over,
});
const payment = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: 'Raiffeisen', date: '2026-08-12', amount: 42.5, currency: 'CHF', direction: 'DBIT', description: 'Einkauf Papeterie Meier Bern', ...over,
});
const books = (receipts: Receipt[], transactions: BankTransaction[], over: Partial<Books> = {}): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' }, ...over }) as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const stages = (b: Books) => stagesOf(searchPairs(b, toChf, (d) => d <= '2026-06-30'));

test('a receipt and the only payment of its amount near its day, naming its vendor, are a clear pair, whichever came first', async () => {
  const b = books([receipt('r')], [payment('p')]);
  assert.deepEqual(stages(b).map((s) => s.kind), ['clear']);
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked, [{ receipt: 'r', payment: 'p', by: 'code', signals: ['amount', 'day', 'name'] }]);
  assert.deepEqual(b.mappings, [{ transactionRef: 'p', receiptId: 'r', by: 'rule', rule: 'pair:amount+day+name' }]);
  assert.deepEqual(signalsOf(b.mappings[0]), ['amount', 'day', 'name'], 'the link says what matched');
  assert.equal(makerOf(b.mappings[0]), 'code');
});

test('two payments of the amount: the one naming the vendor leads by the margin; without a name both are a short list', () => {
  const named = books([receipt('r')], [payment('p'), payment('q', { description: 'Einkauf Migros' })]);
  assert.deepEqual(stages(named).map((s) => s.kind === 'clear' && s.pair.payment), ['p']);
  const alike = books([receipt('r', { title: undefined })], [payment('p', { description: 'Einkauf' }), payment('q', { description: 'Einkauf' })]);
  const [s] = stages(alike);
  assert.equal(s.kind, 'short');
  assert.ok(CLEAR.margin > 0);
});

test('outside the bounds, against the money\'s way or a Rappen off, a payment is no candidate', () => {
  for (const p of [payment('p', { date: '2026-10-20' }), payment('p', { date: '2026-07-20' }), payment('p', { direction: 'CRDT' }), payment('p', { amount: 42.45 })]) {
    assert.deepEqual(searchPairs(books([receipt('r')], [p]), toChf, () => false).byReceipt.get('r'), [], JSON.stringify(p));
  }
});

test('the original amount the bank names («Card transaction of 12.40 USD») matches a receipt in that currency to the Rappen, before any rate', () => {
  const card = payment('w', { bank: 'Wise', currency: 'EUR', amount: 11.05, description: 'Card transaction of 12.40 USD issued by Papeterie Meier (fee: 0.07 EUR)' });
  assert.deepEqual(originalOf(card), { amount: 12.40, currency: 'USD' });
  const [c] = searchPairs(books([receipt('r', { currency: 'USD', amount: 12.40 })], [card]), toChf, () => false).byReceipt.get('r')!;
  assert.equal(c.amount, 'original');
  assert.deepEqual(searchPairs(books([receipt('r', { currency: 'USD', amount: 12.35 })], [card]), toChf, () => false).byReceipt.get('r'), [], 'another original amount: not this receipt');
  assert.deepEqual(originalOf({ ...card, original: { amount: 3, currency: 'GBP' } }), { amount: 3, currency: 'GBP' }, 'the statement\'s InstdAmt wins over the text');
});

test('a credit note, by its sign, its VAT or its title, is matched to money in', () => {
  assert.equal(paysIn(receipt('r', { amount: -42.5 })), true);
  assert.equal(paysIn(receipt('r', { extractedText: 'Papeterie Meier\nGutschrift GS-12\nTotal 42.50' })), true);
  assert.equal(paysIn(receipt('r')), false);
  const b = books([receipt('r', { extractedText: 'Gutschrift GS-12' })], [payment('p', { direction: 'CRDT', description: 'Gutschrift Papeterie Meier' })]);
  assert.deepEqual(stages(b).map((s) => s.kind), ['clear']);
});

test('a pair a person took apart is never a candidate again', async () => {
  const b = books([receipt('r', { notPaidBy: ['p'] })], [payment('p')]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, []);
  assert.deepEqual(b.mappings, []);
});

test('a payment of a filed quarter is never linked: the receipt is pointed at it', async () => {
  const b = books([receipt('r', { date: '2026-06-20' })], [payment('p', { date: '2026-06-22' })]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, [{ receipt: 'r', payment: 'p', by: 'code', signals: ['amount', 'day', 'name'], filed: true }]);
  assert.deepEqual(b.mappings, []);
  assert.equal(b.receipts[0].filedPayment, 'p');
});

/** A model that answers every check with `fits` and every choice with the first payment at `confidence`, and counts its calls. */
function stub(fits: (i: number) => boolean, confidence = 0.9): { ask: Ask; calls: string[] } {
  const calls: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    calls.push(String(opts.detail));
    const list = JSON.parse(prompt.slice(prompt.indexOf('\n\n[') + 2, prompt.lastIndexOf(']\n\n') + 1)) as Array<{ i: number }>;
    return JSON.stringify(opts.detail === 'check' ? list.map((x) => ({ i: x.i, fits: fits(x.i), why: 'stub' })) : list.map((x) => ({ i: x.i, k: 0, confidence })));
  };
  return { ask, calls };
}

test('the model checks the clear pairs in batches of 20: every pair is asked, a confirmed one is linked as «code, checked by the model»', async () => {
  const n = CHECK_BATCH + 5;
  const rs = Array.from({ length: n }, (_, i) => receipt(`r${i}`, { amount: 10 + i, title: { vendor: `Laden${String.fromCharCode(97 + i)}`, what: '' } }));
  const ps = Array.from({ length: n }, (_, i) => payment(`p${i}`, { amount: 10 + i, description: `Einkauf Laden${String.fromCharCode(97 + i)}` }));
  const b = books(rs, ps);
  const m = stub(() => true);
  const run = await runPairChain(port(b), { toChf, ask: m.ask });
  assert.deepEqual(m.calls, ['check', 'check']);
  assert.equal(run.linked.length, n);
  assert.ok(b.mappings.every((x) => x.by === 'llm' && x.rule?.startsWith('pair-checked:') && makerOf(x) === 'checked'));
});

test('a doubted pair is not linked, kept as the model\'s doubt, and not asked about again; «Zahlung suchen» asks again', async () => {
  const b = books([receipt('r')], [payment('p')]);
  const m = stub(() => false);
  assert.deepEqual((await runPairChain(port(b), { toChf, ask: m.ask })).linked, []);
  assert.deepEqual(b.receipts[0].pairDoubted, ['p']);
  await runPairChain(port(b), { toChf, ask: m.ask });
  assert.deepEqual(m.calls, ['check'], 'asked once');
  await runPairChain(port(b), { toChf, ask: m.ask, only: { receipt: 'r' } });
  assert.deepEqual(m.calls, ['check', 'check'], 'the button asks again');
});

test('the model chooses from a short list only at 80 % or more; below, the person gets the candidates', async () => {
  const alike = () => books([receipt('r', { title: undefined })], [payment('p', { description: 'Einkauf' }), payment('q', { description: 'Einkauf' })]);
  const sure = alike();
  assert.deepEqual((await runPairChain(port(sure), { toChf, ask: stub(() => true, 0.9).ask })).linked.map((l) => l.by), ['model']);
  assert.equal(makerOf(sure.mappings[0]), 'model');
  const unsure = alike();
  const run = await runPairChain(port(unsure), { toChf, ask: stub(() => true, 0.6).ask });
  assert.deepEqual(run.linked, []);
  assert.deepEqual(run.left.map((l) => l.candidates.length), [2]);
});

test('a model that fails: the clear pairs are linked by code, the short lists wait for the person', async () => {
  const b = books([receipt('r')], [payment('p')]);
  const run = await runPairChain(port(b), { toChf, ask: async () => { throw new Error('offline'); } });
  assert.deepEqual(run.linked.map((l) => l.by), ['code']);
  assert.match(run.modelFailed ?? '', /offline/);
});

test('«Beleg suchen» links only its own payment', async () => {
  const b = books([receipt('r', { title: undefined }), receipt('s', { title: { vendor: 'Kiosk Muster', what: '' }, amount: 7 })], [payment('p', { description: 'x' }), payment('q', { description: 'x' }), payment('t', { amount: 7, description: 'Kiosk Muster' })]);
  const run = await runPairChain(port(b), { toChf, only: { payment: 't' } });
  assert.deepEqual(run.linked.map((l) => l.payment), ['t']);
  assert.ok(!b.mappings.some((m) => m.receiptId === 'r'));
});

test('more candidates than a short list: the person sees the best five and how many there were', () => {
  const ps = Array.from({ length: SHORT_LIST + 3 }, (_, i) => payment(`p${i}`, { description: 'Einkauf', date: `2026-08-1${i % 9}` }));
  const [s] = stages(books([receipt('r', { title: undefined })], ps));
  assert.equal(s.kind, 'person');
  assert.equal(s.kind === 'person' && s.candidates.length, SHORT_LIST);
  assert.equal(s.kind === 'person' && s.total, SHORT_LIST + 3);
});

test('a payment that needs no receipt is never a candidate: marked so, or what the firm\'s decision says (own transfer, booked onto the owner)', () => {
  const marked = books([receipt('r')], [payment('p', { noReceiptNeeded: true })]);
  assert.deepEqual(searchPairs(marked, toChf, () => false).byReceipt.get('r'), []);
  const exempt = books([receipt('r')], [payment('p')]);
  assert.deepEqual(searchPairs(exempt, toChf, () => false, (t) => t.ref === 'p').byReceipt.get('r'), []);
});

test('the firm\'s decision: an own transfer and a payment a person booked onto the owner\'s account have no receipt of their own', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const own = payment('own', { counterpartyIban: 'CH65 8080 8000 0000 0000 1' });
  const owner = payment('owner');
  const plain = payment('plain');
  const b = books([], [own, owner, plain], { journalEntries: [{ id: 'je', transactionRef: 'owner', date: '2026-08-12', accountDebit: '2451', accountCredit: '1021', amount: 42.5, description: 'Privat' }] });
  const none = noReceiptFor(ws)(b);
  assert.deepEqual([none(own), none(owner), none(plain)], [true, true, false]);
});

test('without a model an amount and a day alone are no proof: the pair waits for the person; the model\'s check may confirm it', async () => {
  const lone = () => books([receipt('r', { title: undefined, filename: 'scan.pdf' })], [payment('p', { description: 'Einkauf' })]);
  const b = lone();
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual([run.linked, run.left.map((l) => l.candidates.map((c) => c.payment))], [[], [['p']]]);
  const checked = lone();
  assert.deepEqual((await runPairChain(port(checked), { toChf, ask: stub(() => true).ask })).linked.map((l) => l.by), ['checked']);
});

test('a filed payment a receipt points at is taken: a second receipt is not pointed at it, so its tax is corrected once', async () => {
  const b = books([receipt('a', { date: '2026-06-20', filedPayment: 'p' }), receipt('b', { date: '2026-06-21' })], [payment('p', { date: '2026-06-22' })]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, []);
  assert.equal(b.receipts[1].filedPayment, undefined);
});

test('an answer the chain cannot read is no doubt: nothing is kept, the clear pair is linked by code, and the next run asks again', async () => {
  const b = books([receipt('r')], [payment('p')]);
  const garbage: Ask = async () => 'Sorry, I cannot help with that.';
  const run = await runPairChain(port(b), { toChf, ask: garbage });
  assert.deepEqual([run.linked.map((l) => l.by), b.receipts[0].pairDoubted, !!run.modelFailed], [['code'], undefined, true]);
  const two = books([receipt('r'), receipt('s', { amount: 9, title: { vendor: 'Kiosk Muster', what: '' } })], [payment('p'), payment('q', { amount: 9, description: 'Kiosk Muster' })]);
  const partial: Ask = async () => JSON.stringify([{ i: 0, fits: false, why: 'other shop' }]);
  const r2 = await runPairChain(port(two), { toChf, ask: partial });
  assert.deepEqual(r2.linked.map((l) => [l.receipt, l.by]), [['s', 'code']], 'the item the answer left out is linked by code');
  assert.deepEqual(two.receipts.map((r) => r.pairDoubted), [['p'], undefined], 'only the explicit «does not fit» is a doubt');
  const short = books([receipt('r', { title: undefined })], [payment('p', { description: 'Einkauf' }), payment('q', { description: 'Einkauf' })]);
  await runPairChain(port(short), { toChf, ask: garbage });
  assert.equal(short.receipts[0].pairDoubted, undefined, 'an unreadable choice keeps no doubt either');
});

test('a card charge split over two currencies (one ref, two legs): the model is shown the leg that fits', async () => {
  const eur = payment('W', { bank: 'Wise', currency: 'EUR', amount: 30, description: 'Card transaction of 30.00 EUR issued by Papeterie Meier' });
  const chf = payment('W', { bank: 'Wise', currency: 'CHF', amount: 5, description: 'Card transaction of 30.00 EUR issued by Papeterie Meier' });
  const b = books([receipt('r', { currency: 'EUR', amount: 30 })], [eur, chf]);
  const prompts: string[] = [];
  const ask: Ask = async (prompt, opts) => { prompts.push(prompt); return stub(() => true).ask(prompt, opts); };
  await runPairChain(port(b), { toChf, ask });
  assert.match(prompts[0], /"amount":30,"currency":"EUR"/);
  assert.deepEqual(b.mappings.map((m) => m.transactionRef), ['W']);
});

test('the original amount the bank names in thousands: «1,234.56», «1\'234.56», «1 234.56», never only «234.56»', () => {
  for (const text of ['Card transaction of 1,234.56 EUR issued by X', 'Card transaction of 1\'234.56 EUR issued by X', 'Card transaction of 1 234.56 EUR issued by X', 'EUR 1,234.56 Kartenzahlung']) {
    assert.deepEqual(originalOf(payment('w', { currency: 'CHF', description: text })), { amount: 1234.56, currency: 'EUR' }, text);
  }
  assert.deepEqual(originalOf(payment('w', { currency: 'CHF', description: 'Card transaction of 12.40 USD' })), { amount: 12.4, currency: 'USD' });
});
