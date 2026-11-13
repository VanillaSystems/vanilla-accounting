/**
 * #190 part 2: receipts that pay one payment together, beyond one currency.
 * 2a a set is compared with the original amount the bank names (Wise's «Card transaction of 44.30
 *    CHF» on a EUR balance), to the centime;
 * 2b a card charge split across balances is one charge, linked on every leg, each leg booked with
 *    its own share in its own currency;
 * 2c a batch payer's open receipts are tried as runs in date order, longer than the free
 *    combinations, and without an original amount at the official rate within a small band;
 * 2d the batch payer comes from the business files (both layers, by their match), and two
 *    payments a person linked several receipts of one business to offer «Immer so?»;
 * 2e two documents of one charge count once.
 * Synthetic receipts and payments, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import './support/jurisdiction.js';
import { BAND, MAX_RUN, MAX_TRIED, linkReceiptSets, linkSplitLegs, proposalsFor, receiptSetsToLink } from '../src/intake/receipt-sets.js';
import { chargesOf } from '../src/intake/charges.js';
import { batchPayers } from '../src/intake/batch-payers.js';
import { batchPayersOf, candidates } from '../src/intake/match.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { classifyTransactions, mappedReceipts, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { receiptWait, type WaitContext } from '../src/booking/receipt-wait.js';
import { linkedOf } from '../src/accounting/receipt-due.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks, PERSON, saveBooks, update, type Books } from '../src/books/store.js';
import { draftGroupedFlag, groupedOffer } from '../src/saving/grouped-flag.js';
import { draftRules, keepDraft } from '../src/saving/rules.js';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';

const open = (d: string) => d > '2026-06-30';
/** The official daily rates in these tests: EUR at 0.94, USD at 0.80. */
const toChf = (a: number, c: string) => (c === 'EUR' ? a * 0.94 : c === 'USD' ? a * 0.8 : a);
const UID = 'CHE-111.222.333';

let n = 0;
const receipt = (amount: number, over: Partial<Receipt> = {}): Receipt => {
  const k = ++n;
  return {
    id: `r${k}`, filename: `beleg-${k}.pdf`, originalFilename: `beleg-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
    date: '2026-08-10', amount, currency: 'CHF', vatId: UID, title: { vendor: 'Marktplatz Beispiel', what: 'Bestellung' },
    description: `Bestellung ${k}`, extractedText: `Marktplatz Beispiel Rechnung Bestellung ${700000 + k}`, ...over,
  } as Receipt;
};
const pay = (ref: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Wise', date: '2026-08-12', amount, currency: 'EUR', direction: 'DBIT', description: 'Card transaction of 44.30 CHF issued by Marktplatz Beispiel', ...over });
const booksOf = (transactions: BankTransaction[], receipts: Receipt[], mappings: Mapping[] = []) =>
  ({ transactions, receipts, mappings, bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;
const ids = (rs: Receipt[]) => rs.map((r) => r.id).sort();
const linksOf = (b: Books) => b.mappings.map((m) => `${m.receiptId}>${m.transactionRef}`).sort();

// ─── 2a ─────────────────────────────────────────────────────────────────────

test('2a: CHF receipts on a EUR card payment add up to the original amount its bank names: linked, to the centime', () => {
  const rs = [receipt(19.3), receipt(25)];
  const b = booksOf([pay('W1', 47.12)], rs);
  const { sets } = linkReceiptSets(b, open);
  assert.deepEqual(sets.map((s) => [s.receipts, s.sum, s.paid, s.currency, s.basis]), [[ids(rs), 44.3, 44.3, 'CHF', 'original']]);
  assert.deepEqual(linksOf(b), [`${rs[0].id}>W1`, `${rs[1].id}>W1`]);
});

test('2a: more than a centime per receipt off the original amount is a proposal, never a link; two sets that fit it are proposals too', () => {
  const off = booksOf([pay('W1', 47.12)], [receipt(19.33), receipt(25)]);
  assert.deepEqual(receiptSetsToLink(off, open).sets, []);
  assert.deepEqual(proposalsFor(off, off.transactions[0], open).sets.map((s) => [s.sum, s.paid, s.exact, s.basis]), [[44.33, 44.3, false, 'original']]);
  const two = booksOf([pay('W1', 47.12)], [receipt(19.3), receipt(25), receipt(20.3), receipt(24)]);
  assert.deepEqual(receiptSetsToLink(two, open).sets, []);
  assert.equal(proposalsFor(two, two.transactions[0], open).sets.filter((s) => s.exact).length, 2);
});

// ─── 2b ─────────────────────────────────────────────────────────────────────

const ORIGINAL = 'Card transaction of 156.86 CHF issued by Marktplatz Beispiel';
const eurLeg = (over: Partial<BankTransaction> = {}) => pay('CARD-1-EUR', 100, { description: `${ORIGINAL} (fee: 0.58 EUR)`, ...over });
const chfLeg = (over: Partial<BankTransaction> = {}) => pay('CARD-1-CHF', 63.36, { currency: 'CHF', description: ORIGINAL, ...over });

test('2b: the legs of one card charge split across balances are one charge; other merchants, the same balance twice, a leg that paid it all or two bank ids are not', () => {
  assert.deepEqual(chargesOf([eurLeg(), chfLeg()], toChf).splits.map((c) => c.refs), [['CARD-1-CHF', 'CARD-1-EUR']]);
  assert.deepEqual(chargesOf([eurLeg(), chfLeg({ description: 'Card transaction of 156.86 CHF issued by Andere Firma' })], toChf).splits, [], 'another merchant');
  assert.deepEqual(chargesOf([eurLeg(), eurLeg({ ref: 'CARD-2-EUR' })], toChf).splits, [], 'the same balance twice: two charges');
  assert.deepEqual(chargesOf([eurLeg(), chfLeg({ amount: 156.86 })], toChf).splits, [], 'the CHF movement paid the whole charge: a charge of its own');
  assert.deepEqual(chargesOf([eurLeg({ bankTxId: 'CARD-1' }), chfLeg({ bankTxId: 'CARD-2' })], toChf).splits, [], 'two bank ids');
  assert.deepEqual(chargesOf([eurLeg({ date: '2026-08-13' }), chfLeg()], toChf).splits, [], 'another day');
  assert.deepEqual(chargesOf([eurLeg(), chfLeg()]).splits, [], 'without the daily rates nothing is merged');
});

test('2b: a leg may be almost all of the charge (a balance that held 1.50 EUR); two whole charges add up to twice and stay two', () => {
  const of = 'Card transaction of 100.00 CHF issued by Marktplatz Beispiel';
  const dominant = [pay('E', 1.5, { date: '2026-08-10', description: of }), pay('U', 123.24, { currency: 'USD', date: '2026-08-10', description: of })];
  assert.deepEqual(chargesOf(dominant, toChf).splits.map((c) => c.refs), [['E', 'U']], '1.41 + 98.59 CHF at the daily rate: one charge');
  const both = 'Card transaction of 19.30 CHF issued by Marktplatz Beispiel';
  assert.deepEqual(chargesOf([pay('E', 20.6, { date: '2026-08-10', description: both }), pay('U', 24.1, { currency: 'USD', date: '2026-08-10', description: both })], toChf).splits, []);
});

test('2b: one receipt of the whole charge is linked by the chain to every leg', async () => {
  const r = receipt(156.86);
  const b = booksOf([eurLeg(), chfLeg()], [r]);
  const run = await runPairChain({ read: () => b, update: (fn) => fn(b) }, { toChf: (a, c) => (c === 'EUR' ? a * 0.94 : a) });
  assert.deepEqual(run.linked.map((l) => [l.receipt, l.payment, l.legs]), [[r.id, 'CARD-1-CHF', ['CARD-1-CHF', 'CARD-1-EUR']]]);
  assert.deepEqual(linksOf(b), [`${r.id}>CARD-1-CHF`, `${r.id}>CARD-1-EUR`]);
});

test('2b: legs of different merchants are not merged: the receipt goes to the leg whose original amount it is, alone', async () => {
  const r = receipt(156.86);
  const b = booksOf([eurLeg(), chfLeg({ description: 'Card transaction of 156.86 CHF issued by Andere Firma' })], [r]);
  await runPairChain({ read: () => b, update: (fn) => fn(b) }, { toChf: (a, c) => (c === 'EUR' ? a * 0.94 : a) });
  assert.deepEqual(linksOf(b), [`${r.id}>CARD-1-EUR`]);
});

test('2b: a set of the whole charge is linked to every leg', () => {
  const rs = [receipt(100), receipt(56.86)];
  const b = booksOf([eurLeg(), chfLeg()], rs);
  const { sets } = linkReceiptSets(b, { isOpen: open, toChf });
  assert.deepEqual(sets.map((s) => [s.legs, s.receipts, s.basis]), [[['CARD-1-CHF', 'CARD-1-EUR'], ids(rs), 'original']]);
  assert.equal(b.mappings.length, 4);
});

test('2b: a leg that waits while the other holds the charge\'s receipt gets it too; never one a person took apart, never on a sum that is not the charge', () => {
  const r = receipt(156.86);
  const b = booksOf([eurLeg(), chfLeg()], [r], [{ transactionRef: 'CARD-1-EUR', receiptId: r.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b, open, toChf), [{ legs: ['CARD-1-CHF'], receipts: [r.id] }]);
  assert.deepEqual(linksOf(b), [`${r.id}>CARD-1-CHF`, `${r.id}>CARD-1-EUR`]);
  const apart = receipt(156.86, { notPaidBy: ['CARD-1-CHF'] });
  const b2 = booksOf([eurLeg(), chfLeg()], [apart], [{ transactionRef: 'CARD-1-EUR', receiptId: apart.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b2, open, toChf), []);
  const part = receipt(100);
  const b3 = booksOf([eurLeg(), chfLeg()], [part], [{ transactionRef: 'CARD-1-EUR', receiptId: part.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b3, open, toChf), [], 'the receipt is not the whole charge');
});

test('2b: each leg books its own share in its own currency at the ESTV rate of its day, with the receipt\'s VAT, and the wait releases every leg', async () => {
  const r = receipt(156.86, { kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 11.76, gross: 156.86 }] });
  const legs = [eurLeg(), chfLeg()];
  const b = booksOf(legs, [r]);
  const ctx: WaitContext = { free: new Set(), wordings: [], assumesUnread: new Set(), ownIbans: new Set(), settles: () => false, inputTax: true };
  const waits = () => legs.map((t) => receiptWait(t, { linked: linkedOf(mappedReceipts(b, t)) }, ctx).wait);
  assert.deepEqual(waits(), [true, true], 'no receipt yet: both legs wait');
  linkReceiptSets(b, { isOpen: open, toChf });
  linkSplitLegs(b, open, toChf);
  await runPairChain({ read: () => b, update: (fn) => fn(b) }, { toChf: (a, c) => (c === 'EUR' ? a * 0.94 : a) });
  assert.deepEqual(waits(), [false, false], 'the receipt on both legs: neither waits');

  const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: [{ bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }, { bank: 'Wise', currency: 'CHF', account: '1024', label: 'Wise CHF', role: 'bank' }] };
  const amounts: Record<string, number> = { 'CARD-1-EUR': 100, 'CARD-1-CHF': 63.36 };
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '4200', accountCredit: '', amount: amounts[ref], vatCode: 'M81', description: 'Marktplatz' }], reason: 'Wareneinkauf.' }])));
  };
  const { classified, failed } = await classifyTransactions(b, legs, { ask, fx: loadFxResolver(), context });
  assert.deepEqual([classified.sort(), failed], [['CARD-1-CHF', 'CARD-1-EUR'], []]);
  const rows = b.journalEntries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.exchangeCurrency ?? 'CHF', e.exchangeRate ?? 1]).sort();
  assert.deepEqual(rows, [
    ['CARD-1-CHF', '4200', '1024', 63.36, 'M81', 'CHF', 1],
    ['CARD-1-EUR', '4200', '1023', 100, 'M81', 'EUR', loadFxResolver().daily('EUR', '2026-08-12')],
  ]);
});

// ─── 2c ─────────────────────────────────────────────────────────────────────

const marktplatz = compileCounterparty({ id: 'marktplatz', name: 'Marktplatz Beispiel', grouped: true, match: { uid: [UID], tx: ['marktplatz beispiel'] } }, { binding: 'knowledge/suppliers/marktplatz.yaml' }, 'supplier');
const payers = batchPayers([marktplatz]);
const chf = (ref: string, amount: number, over: Partial<BankTransaction> = {}) => pay(ref, amount, { bank: 'Raiffeisen', currency: 'CHF', description: 'Marktplatz Beispiel Sammelrechnung', ...over });
const day = (i: number) => `2026-07-${String(10 + i).padStart(2, '0')}`;

test('2c: a batch payer\'s oldest open receipts in date order add up to its payment: linked, though it has more receipts near it than code combines', () => {
  const amounts = [1, 2, 4, 8, 16, ...Array.from({ length: MAX_TRIED - 2 }, (_, i) => 100.37 + 11.1 * i)];
  const rs = amounts.map((a, i) => receipt(Math.round(a * 100) / 100, { date: day(i) }));
  const b = booksOf([chf('S1', 31, { date: '2026-08-01' })], rs);
  assert.deepEqual(receiptSetsToLink(b, open).sets, [], 'without the flag: more than code combines, only proposed');
  assert.equal(proposalsFor(b, b.transactions[0], open).cut, undefined, 'no set was held back, and nothing ties the payment to the vendor: no notice');
  const { sets } = receiptSetsToLink(b, { isOpen: open, payers });
  assert.deepEqual(sets.map((s) => [s.receipts, s.run, s.basis]), [[ids(rs.slice(0, 5)), true, 'paid']]);
});

test('2c: two runs that add up (a credit note between them) stay proposals; more open receipts than a run takes are told, never linked', () => {
  const rs = [receipt(30, { date: day(1) }), receipt(20, { date: day(2) }), receipt(-20, { date: day(3) }), receipt(20, { date: day(4) })];
  assert.deepEqual(receiptSetsToLink(booksOf([chf('S1', 50, { date: '2026-08-01' })], rs), { isOpen: open, payers }).sets, []);
  const many = Array.from({ length: MAX_RUN + 1 }, (_, i) => receipt(1 + i, { date: `2026-0${7 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}` }));
  const b = booksOf([chf('S1', 1 + 2, { date: '2026-08-20' })], many);
  const found = receiptSetsToLink(b, { isOpen: open, payers });
  assert.deepEqual(found.sets, []);
  assert.ok(found.cuts.some((c) => c.limit === 'run' && c.near === MAX_RUN + 1 && c.tried === MAX_RUN), JSON.stringify(found.cuts));
});

test('2c: without an original amount, a run meets the payment at the official daily rate within the band; two runs in the band stay proposals', () => {
  const toChf = (a: number, c: string) => (c === 'EUR' ? a * 0.95 : a);
  const rs = [receipt(40, { date: day(1) }), receipt(55, { date: day(2) }), receipt(80, { date: day(3) })];
  const eur = pay('E1', 100, { description: 'Marktplatz Beispiel Sammelzahlung', date: '2026-08-01' }); // 95.00 CHF at the rate: 40 + 55
  const b = booksOf([eur], rs);
  assert.deepEqual(receiptSetsToLink(b, { isOpen: open, toChf }).sets, [], 'not a batch payer: no rate');
  const { sets } = receiptSetsToLink(b, { isOpen: open, payers, toChf });
  assert.deepEqual(sets.map((s) => [s.receipts, s.basis, s.sum, s.paid]), [[ids(rs.slice(0, 2)), 'rate', 95, 95]]);
  const off = booksOf([pay('E1', 100 * (1 + 2 * BAND), { description: 'Marktplatz Beispiel Sammelzahlung', date: '2026-08-01' })], [receipt(40, { date: day(1) }), receipt(55, { date: day(2) })]);
  assert.deepEqual(receiptSetsToLink(off, { isOpen: open, payers, toChf }).sets, [], 'outside the band');
  const twice = booksOf([eur], [receipt(40, { date: day(1) }), receipt(54.5, { date: day(2) }), receipt(0.4, { date: day(3) })]);
  assert.deepEqual(receiptSetsToLink(twice, { isOpen: open, payers, toChf }).sets, [], '94.50 and 94.90 both in the band below 95.00');
  const above = booksOf([eur], [receipt(40, { date: day(1) }), receipt(55.5, { date: day(2) })]);
  assert.deepEqual(receiptSetsToLink(above, { isOpen: open, payers, toChf }).sets, [], '95.50 is more than the payment: never within the band');
  assert.deepEqual(receiptSetsToLink(booksOf([eur], [receipt(40, { date: day(1) }), receipt(55, { date: day(2) }), receipt(0.5, { date: day(3) })]), { isOpen: open, payers, toChf }).sets.map((x) => x.sum), [95], 'the next run above the payment does not hold it back');
});

// ─── 2d ─────────────────────────────────────────────────────────────────────

test('2d: no vendor is named in the match step; a batch payer is its file\'s, recognised by its match', () => {
  assert.doesNotMatch(readFileSync('src/intake/match.ts', 'utf8'), /amazon|aliexpress|fedex/i);
  const r = receipt(30);
  assert.equal(payers.ofReceipt(r), 'marktplatz');
  assert.equal(payers.ofReceipt(receipt(30, { vatId: 'CHE-999.888.777', title: { vendor: 'Andere Firma', what: 'Rechnung' }, extractedText: 'Andere Firma' })), undefined);
  const held = chf('S1', 90);
  const other = chf('S2', 30, { description: 'Andere Firma' });
  const shown = candidates(r, [held, other], new Set(['S1']), () => false, payers);
  assert.deepEqual(shown.map((t) => t.ref), ['S1'], 'its payment stays a candidate with receipts on it');
  assert.deepEqual(candidates(r, [held, other], new Set(['S1'])).map((t) => t.ref), ['S2'], 'without the flag a held payment is no candidate');
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  assert.equal(app.ofReceipt(receipt(30, { vatId: 'CHE-269.567.571' })), 'amazon', 'the app layer\'s file says grouped');
});

/** The demo copied into a git repository, with a private business the company knows. */
async function company() {
  const repo = mkdtempSync(join(tmpdir(), 'grouped-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  const file = 'knowledge/suppliers/marktplatz.yaml';
  mkdirSync(dirname(join(ws.paths.root, file)), { recursive: true });
  writeFileSync(join(ws.paths.root, file), `id: marktplatz\nname: Marktplatz Beispiel\nmatch:\n  uid: [ "${UID}" ]\n  tx: [ "marktplatz beispiel" ]\n`);
  await initRepository(repo, 'Workspace set up');
  return { ws, file };
}

test('2d: a person links several receipts of one business to one payment twice: «Immer so?» drafts the flag into its file, kept on the card', async () => {
  const { ws, file } = await company();
  const books = loadBooks(ws);
  const rs = [receipt(30, { date: '2026-10-01' }), receipt(20, { date: '2026-10-02' }), receipt(12, { date: '2026-10-05' }), receipt(8, { date: '2026-10-06' })];
  update(books, PERSON, (b) => {
    b.receipts.push(...rs);
    b.transactions.push(chf('S1', 50, { date: '2026-10-03' }), chf('S2', 20, { date: '2026-10-07' }));
    b.mappings.push({ transactionRef: 'S1', receiptId: rs[0].id, by: 'human' }, { transactionRef: 'S1', receiptId: rs[1].id, by: 'human' });
  });
  saveBooks(ws, books);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'S1'), undefined, 'once is no practice yet');
  const again = loadBooks(ws);
  update(again, PERSON, (b) => { b.mappings.push({ transactionRef: 'S2', receiptId: rs[2].id, by: 'human' }, { transactionRef: 'S2', receiptId: rs[3].id, by: 'human' }); });
  saveBooks(ws, again);
  assert.deepEqual(groupedOffer(ws, loadBooks(ws), 'S2'), { ref: 'S2', business: { id: 'marktplatz', name: 'Marktplatz Beispiel' }, payments: 2, path: file });
  assert.equal(draftGroupedFlag(ws, 'S2'), file);
  const d = draftRules(ws, file)!;
  assert.deepEqual([d.grouped, d.others, d.keepable, d.added], [true, false, true, []]);
  assert.equal((await keepDraft(ws, file, d.basis)).ok, true);
  assert.match(readFileSync(join(ws.paths.root, file), 'utf8'), /^grouped: true$/m);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'S2'), undefined, 'a batch payer now: nothing more to offer');
  assert.equal(batchPayersOf(ws).ofReceipt(rs[0]), 'marktplatz', 'the company\'s file makes it a batch payer');
});

// ─── 2e ─────────────────────────────────────────────────────────────────────

test('2e: the receipt and the invoice of one charge count once: the set is linked with one of them, the copy stays as it is', () => {
  const text = 'Marktplatz Beispiel Rechnung Bestellung 4711000 Total 30.00';
  const original = receipt(30, { extractedText: text });
  const copy = receipt(30, { extractedText: text, filename: 'rechnung-kopie.pdf' });
  const rest = receipt(57.4);
  const b = booksOf([chf('S1', 87.4)], [original, copy, rest]);
  const { sets } = linkReceiptSets(b, open);
  assert.equal(sets.length, 1, 'one set, not two of each copy');
  assert.deepEqual(sets[0].receipts.length, 2);
  assert.ok(sets[0].receipts.includes(rest.id));
  assert.equal(b.mappings.filter((m) => m.receiptId === original.id || m.receiptId === copy.id).length, 1, 'only one of the two documents is linked');
});

test('2e: a copy by its number (a scan beside the PDF) counts once; copies the model linked both count once, copies a person linked are the person\'s', () => {
  const pdf = receipt(30, { extractedText: 'Marktplatz Beispiel Rechnung Nr. 4711000 vom 10.08.2026 Total CHF 30.00 MWST 8.1%' });
  const scan = receipt(30, { extractedText: 'MARKTPLATZ BElSPIEL Rechnunq 4711000 30.00' });
  const rest = receipt(57.4);
  const b = booksOf([chf('S1', 87.4)], [pdf, scan, rest]);
  assert.equal(receiptSetsToLink(b, open).sets.length, 1);
  const linked = booksOf([chf('S1', 87.4)], [pdf, scan, rest], [{ transactionRef: 'S1', receiptId: pdf.id, by: 'human' }, { transactionRef: 'S1', receiptId: scan.id, by: 'human' }]);
  assert.deepEqual(receiptSetsToLink(linked, open).sets, [], 'a person linked both: the person\'s set, 60.00, never taken for one copy');
  const byModel = booksOf([chf('S1', 87.4)], [pdf, scan, rest], [{ transactionRef: 'S1', receiptId: pdf.id, by: 'llm' }, { transactionRef: 'S1', receiptId: scan.id, by: 'llm' }]);
  assert.deepEqual(receiptSetsToLink(byModel, open).sets.map((s) => [s.receipts, s.sum]), [[[rest.id], 87.4]], 'the model linked both: the two documents count 30.00, not 60.00');
});

test('2e: two receipts of one amount and day with their own order numbers are two documents, not copies', () => {
  const b = booksOf([chf('S1', 60)], [receipt(30), receipt(30)]);
  assert.deepEqual(receiptSetsToLink(b, open).sets.map((s) => s.receipts.length), [2]);
});

// ─── Review round: code links only what is exact and unique, never more than the payment ────────

test('two whole charges of one amount at one shop on one day from two balances are two charges: one receipt is never put on both', () => {
  const both = 'Card transaction of 19.30 CHF issued by Marktplatz Beispiel';
  const txs = [pay('E', 20.6, { date: '2026-08-10', description: both }), pay('U', 24.1, { currency: 'USD', date: '2026-08-10', description: both })];
  assert.deepEqual(chargesOf(txs, toChf).splits, [], 'each leg alone is the whole amount at the daily rate: no split');
  const r1 = receipt(19.3);
  const b = booksOf(txs, [r1, receipt(19.3)], [{ transactionRef: 'E', receiptId: r1.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b, open, toChf), []);
  assert.deepEqual(linksOf(b), [`${r1.id}>E`], 'the person\'s receipt stays on its own charge, its input tax counted once');
});

test('receipts a person linked are the person\'s set: two real receipts of 4.50 on 9.00 take no third', () => {
  const t = (h: string) => `Cafe Beispiel Zuerich Espresso 1x 4.50 Total CHF 4.50 MWST 8.1% enthalten Danke ${h}`;
  const cafe = { vatId: 'CHE-283.746.519', title: { vendor: 'Cafe Beispiel', what: 'Kaffee' } };
  const c1 = receipt(4.5, { ...cafe, extractedText: t('10:01') });
  const c2 = receipt(4.5, { ...cafe, extractedText: t('10:02') });
  const c3 = receipt(4.5, { ...cafe, date: '2026-08-03', extractedText: t('09:00') });
  const b = booksOf([chf('P', 9, { date: '2026-08-10', description: 'Cafe Beispiel' })], [c1, c2, c3], [{ transactionRef: 'P', receiptId: c1.id, by: 'human' }, { transactionRef: 'P', receiptId: c2.id, by: 'human' }]);
  assert.deepEqual(linkReceiptSets(b, open).sets, []);
  assert.deepEqual(linksOf(b), [`${c1.id}>P`, `${c2.id}>P`]);
});

test('a stale run of a batch payer\'s oldest receipts beside another set that fits: proposals only, nothing linked', () => {
  const rs = [receipt(10, { date: '2026-07-01' }), receipt(20, { date: '2026-07-02' }), receipt(25, { date: '2026-07-20' }), receipt(5, { date: '2026-07-21' })];
  const b = booksOf([chf('P', 30, { date: '2026-07-22' })], rs);
  assert.deepEqual(receiptSetsToLink(b, { isOpen: open, payers }).sets, []);
  const offered = proposalsFor(b, b.transactions[0], { isOpen: open, payers }).sets;
  assert.deepEqual(offered.filter((s) => s.exact).map((s) => [s.receipts, !!s.run]).sort(), [[ids(rs.slice(0, 2)), true], [ids(rs.slice(2)), false]]);
});

test('a free receipt that repeats one a payment holds joins no set, also when it is the only copy among the free ones', () => {
  const text = 'Marktplatz Beispiel Rechnung Bestellung 4711000 Total 30.00';
  const original = receipt(30, { extractedText: text });
  const copy = receipt(30, { extractedText: text, filename: 'rechnung-kopie.pdf' });
  const rest = receipt(57.4);
  const b = booksOf([chf('S0', 30, { date: '2026-08-10' }), chf('S1', 87.4)], [original, copy, rest], [{ transactionRef: 'S0', receiptId: original.id, by: 'human' }]);
  assert.deepEqual(receiptSetsToLink(b, open).sets, []);
  assert.deepEqual(proposalsFor(b, b.transactions[1], open).sets, [], 'the copy is no part of a proposal either');
});

test('within a centime per receipt: never linked, even the only such set; proposed with its rounding; an exact set beside it is linked', () => {
  const rs = [receipt(30), receipt(45.5), receipt(11.9)];
  const b = booksOf([chf('P', 87.41)], rs);
  assert.deepEqual(receiptSetsToLink(b, open).sets, [], 'the only set within reach is still a proposal');
  assert.deepEqual(proposalsFor(b, b.transactions[0], open).sets.map((s) => [s.receipts, s.sum, s.paid, s.exact, s.rounding]), [[ids(rs), 87.4, 87.41, false, true]]);
  const run = [receipt(10, { date: day(1) }), receipt(20, { date: day(2) })];
  assert.deepEqual(receiptSetsToLink(booksOf([chf('R', 30.01, { date: day(5) })], run), { isOpen: open, payers }).sets, [], 'a batch payer\'s run within a centime per receipt: a proposal too');
  const two = booksOf([chf('P', 50.01)], [receipt(20), receipt(30), receipt(25), receipt(25.02)]);
  assert.deepEqual(receiptSetsToLink(two, open).sets, [], '50.00 and 50.02 both round to 50.01');
  const exact = [receipt(20), receipt(30.01)];
  const beside = booksOf([chf('P', 50.01)], [...exact, receipt(29.99)]);
  assert.deepEqual(receiptSetsToLink(beside, open).sets.map((s) => [s.receipts, s.exact]), [[ids(exact), true]], 'the exact set is the one; 49.99 does not compete with it');
  assert.deepEqual(receiptSetsToLink(booksOf([chf('P', 87.44)], [receipt(30), receipt(45.5), receipt(11.9)]), open).sets, [], 'four centimes on three receipts: a proposal');
});

test('the receipts of a batch payer form one vendor by its business: two UIDs, and one with no UID nor title that names it', () => {
  const two = compileCounterparty({ id: 'marktplatz', name: 'Marktplatz Beispiel', grouped: true, match: { uid: [UID, 'CHE-192.837.465'], tx: ['marktplatz beispiel'] } }, { binding: 'knowledge/suppliers/marktplatz.yaml' }, 'supplier');
  const rs = [receipt(30, { date: day(1) }), receipt(20, { date: day(2), vatId: 'CHE-192.837.465' }), receipt(12.4, { date: day(3), vatId: undefined, title: undefined, extractedText: 'Marktplatz Beispiel\nRechnung 4712000' })];
  const b = booksOf([chf('S1', 62.4, { date: '2026-08-01' })], rs);
  assert.deepEqual(receiptSetsToLink(b, open).sets, [], 'without the flag: three vendors, no set');
  assert.deepEqual(receiptSetsToLink(b, { isOpen: open, payers: batchPayers([two]) }).sets.map((s) => s.receipts), [ids(rs)]);
});

test('more open receipts than a run takes hold back only that batch payer\'s runs: an exact set on its other payment is linked', () => {
  const july = Array.from({ length: 31 }, (_, i) => receipt(1000 + i, { date: `2026-07-${String(1 + i).padStart(2, '0')}` }));
  const sept = [3.17, 5.29, 7.43, 11.61, 13.89, 17.03, 19.37, 23.51, 29.73, 31.97].map((a, i) => receipt(a, { date: `2026-09-${String(1 + i).padStart(2, '0')}` }));
  const b = booksOf([chf('P1', 2001, { date: '2026-09-20' }), chf('P2', 26.8, { date: '2026-09-15' })], [...july, ...sept]);
  const found = receiptSetsToLink(b, { isOpen: open, payers });
  assert.deepEqual(found.sets.map((s) => [s.payment, s.receipts]), [['P2', ids([sept[2], sept[6]])]]);
  assert.ok(found.cuts.some((c) => c.limit === 'run' && c.near === 41 && c.tried === MAX_RUN), 'P1\'s run is held back and told');
});

test('the limit is told only on the payment\'s own vendor and only when it held a set back', () => {
  const big = (i: number) => receipt(10 + i, { vatId: 'CHE-987.654.320', title: { vendor: 'Grossverteiler', what: 'Einkauf' }, date: `2026-08-0${1 + (i % 9)}`, extractedText: `Grossverteiler ${900000 + i}` });
  const many = Array.from({ length: MAX_TRIED + 1 }, (_, i) => big(i));
  const other = chf('S', 79.9, { date: '2026-08-10', description: 'Telefon Rechnung' });
  assert.equal(proposalsFor(booksOf([other], many, []), other, open).cut, undefined, 'an unrelated payment hears nothing of another vendor\'s receipts');
  const first = big(50);
  const own = chf('G', first.amount! + many[MAX_TRIED].amount!, { date: '2026-08-10', description: 'Grossverteiler' });
  const b = booksOf([own], [first, ...many], [{ transactionRef: 'G', receiptId: first.id, by: 'llm' }]);
  assert.deepEqual(proposalsFor(b, own, open).cut, { near: MAX_TRIED + 1, tried: MAX_TRIED, limit: 'combinations' }, 'its own vendor\'s set, held back by the limit, is told');
});

test('a batch payer is recognised by what its receipt says: without a UID by its name in the first lines or an address\'s domain; with a UID of its own by its title and filename only', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  const bare = (over: Partial<Receipt>) => receipt(30, { filename: 'invoice_4711.pdf', vatId: undefined, title: undefined, ...over });
  assert.equal(app.ofReceipt(bare({ extractedText: 'FedEx Express (Schweiz) GmbH\nRechnung 4711\nFracht' })), 'fedex', 'no UID: by its name in the first lines (an inbox filename)');
  assert.equal(app.ofReceipt(bare({ extractedText: 'Rechnung\nKontakt: billch@fedex.com' })), 'fedex', 'no UID: by the domain of its address');
  assert.equal(app.ofReceipt(bare({ vatId: 'CHE-111.222.334', extractedText: 'FedEx Express (Schweiz) GmbH\nRechnung 4711\nFracht' })), undefined, 'a UID no file names: its text routes nothing');
  assert.equal(app.ofReceipt(bare({ vatId: 'CHE-111.222.334', title: { vendor: 'FedEx Express', what: 'Fracht' }, extractedText: 'FedEx Express (Schweiz) GmbH\nRechnung 4711' })), 'fedex', 'its title names the sender');
  assert.equal(app.ofReceipt(bare({ vatId: 'CHE-111.222.334', filename: '20260801-fedex-fracht.pdf', extractedText: 'Rechnung 4711' })), 'fedex', 'its archived filename');
  assert.equal(app.ofReceipt(bare({ extractedText: `Beispiel Shop AG Rechnung\n${'Artikel '.repeat(120)}Versand mit FedEx\n${'Zeile '.repeat(150)}` })), undefined);
});

test('AliExpress names no UID: its Tax Invoice (Alibaba\'s UID) is recognised by its filename or title; an alibaba.com receipt with the same UID is no AliExpress receipt', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  assert.doesNotMatch(readFileSync('processes/suppliers/aliexpress.yaml', 'utf8'), /^\s+uid:/m, 'the app file matches no UID');
  const tax = 'Tax Invoice\nAliExpress order 8123456789\nMarketplace Operator: Alibaba.com Singapore E-Commerce Private Limited\nCHE-447.613.666 MWST\nTax Rate 8.1%';
  const inv = (over: Partial<Receipt>) => receipt(30, { vatId: 'CHE-447.613.666', title: undefined, extractedText: tax, ...over });
  assert.equal(app.ofReceipt(inv({ filename: '8123456789_payment.pdf' })), 'aliexpress', 'the Tax Invoice as downloaded');
  assert.equal(app.ofReceipt(inv({ filename: '20260801-aliexpress-kabel.pdf' })), 'aliexpress', 'archived');
  assert.equal(app.ofReceipt(inv({ filename: 'invoice.pdf', title: { vendor: 'AliExpress', what: 'Kabel' } })), 'aliexpress', 'by its title');
  assert.equal(app.ofReceipt(inv({ filename: 'invoice.pdf' })), undefined, 'the word in its text alone does not route a receipt that carries a UID');
  const alibaba = receipt(500, { filename: 'alibaba-order-4711.pdf', vatId: 'CHE-447.613.666', title: { vendor: 'Alibaba.com', what: 'Muster' }, extractedText: 'Alibaba.com Trade Assurance order 4711\nCHE-447.613.666 MWST' });
  assert.equal(app.ofReceipt(alibaba), undefined);
});

test('a shop\'s invoice with a UID of its own is the shop\'s, never FedEx\'s or Amazon\'s, whatever carrier, tracking link or way of payment it names', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  const velo = (amount: number, date: string) => receipt(amount, { date, filename: `velo-${amount}.pdf`, vatId: 'CHE-283.746.519', title: { vendor: 'Velo Huber', what: 'Teile' },
    extractedText: `Velo Huber AG\nBahnhofstrasse 1, 8000 Zürich\nCHE-283.746.519 MWST\nRechnung ${amount}-2026\nVersand: FedEx Express Priority\nArtikel Bremsbeläge` });
  const fedex = (amount: number, date: string) => receipt(amount, { date, filename: `20260801-fedex-${amount}.pdf`, vatId: undefined, title: { vendor: 'FedEx', what: 'Fracht' }, extractedText: `FedEx Express Rechnung ${amount}99887` });
  const [v1, v2, v3] = [velo(39, '2026-08-05'), velo(20, '2026-08-06'), velo(44, '2026-08-07')];
  const [f1, f2] = [fedex(18.4, '2026-08-10'), fedex(61.2, '2026-08-11')];
  const txs = [chf('VELO', 59, { date: '2026-08-12', description: 'Velo Huber AG' }), chf('VELO2', 44, { date: '2026-09-25', description: 'Velo Huber AG' }), chf('FDX', 62.4, { date: '2026-08-20', description: 'FEDEX EXPRESS SWISS' })];
  const b = booksOf(txs, [v1, v2, f1, f2, v3]);
  assert.equal(app.ofReceipt(v1), undefined, 'the shipping line in its first lines does not make it FedEx\'s');
  const linked = receiptSetsToLink(b, { isOpen: open, payers: app }).sets;
  assert.ok(!linked.some((s) => s.payment === 'FDX' && s.receipts.some((id) => [v1.id, v2.id, v3.id].includes(id))), 'no shop receipt in a FedEx set');
  assert.ok(!proposalsFor(b, txs[2], { isOpen: open, payers: app }).sets.some((s) => s.receipts.some((id) => [v1.id, v2.id, v3.id].includes(id))), 'nor in a FedEx proposal');
  assert.ok(candidates(v1, txs, new Set(), () => false, app).some((t) => t.ref === 'VELO'), 'the model sees the shop\'s payment for it, not only FedEx\'s');
  assert.equal(app.ofPayment(txs[0], [v1, v2]), undefined, 'the shop\'s payment with its receipts is no FedEx payment');

  const tracking = receipt(30, { vatId: 'CHE-283.746.519', title: { vendor: 'Velo Huber', what: 'Teile' }, filename: 'rechnung-1045.pdf',
    extractedText: `Velo Huber AG\nRechnung 2026-1045\n${'Artikel x\n'.repeat(150)}Sendungsverfolgung: https://www.fedex.com/fedextrack/?trknbr=123\n` });
  assert.equal(app.ofReceipt(tracking), undefined, 'a fedex.com tracking link in its footer');
  const amazonPay = receipt(30, { vatId: 'CHE-987.654.320', title: { vendor: 'Kaffee Rösterei', what: 'Kaffee' }, filename: 'rechnung-77.pdf', extractedText: 'Kaffee Rösterei GmbH\nRechnung 77\nZahlungsart: Amazon Pay\n' });
  assert.equal(app.ofReceipt(amazonPay), undefined, '«Zahlungsart: Amazon Pay»');
});

test('a business known only by its UID: its payment is recognised by the receipts linked to it, for the batch payers and the «Immer so?» alike', async () => {
  const lsv = compileCounterparty({ id: 'lsv', name: 'Lastschrift Beispiel', grouped: true, match: { uid: ['CHE-192.837.465'] } }, { binding: 'knowledge/suppliers/lsv.yaml' }, 'supplier');
  const tx = chf('L1', 50, { description: 'LSV 12345' });
  const r = receipt(30, { vatId: 'CHE-192.837.465', title: { vendor: 'Lieferant', what: 'Ware' } });
  assert.equal(batchPayers([lsv]).ofPayment(tx), undefined, 'the bank names no one');
  assert.equal(batchPayers([lsv]).ofPayment(tx, [r]), 'lsv');

  const { ws } = await company();
  writeFileSync(join(ws.paths.root, 'knowledge/suppliers/lsv.yaml'), 'id: lsv\nname: Lastschrift Beispiel\nmatch:\n  uid: [ "CHE-192.837.465" ]\n');
  const rs = [0, 1, 2, 3].map((i) => receipt(10 + i, { date: `2026-10-0${1 + i}`, vatId: 'CHE-192.837.465', title: { vendor: 'Lieferant', what: 'Ware' } }));
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    b.receipts.push(...rs);
    b.transactions.push(chf('L1', 21, { date: '2026-10-03', description: 'LSV 12345' }), chf('L2', 25, { date: '2026-10-05', description: 'LSV 12346' }));
    b.mappings.push(...[['L1', rs[0]], ['L1', rs[1]], ['L2', rs[2]], ['L2', rs[3]]].map(([ref, x]) => ({ transactionRef: ref as string, receiptId: (x as Receipt).id, by: 'human' as const })));
  });
  saveBooks(ws, books);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'L2')?.business.id, 'lsv');
});

test('«Immer so?» is not offered for a business whose file says grouped either way, nor for a copy linked beside its original', async () => {
  const { ws, file } = await company();
  const text = (k: number) => `Marktplatz Beispiel Rechnung Bestellung ${4711000 + k} Total`;
  const rs = [receipt(30, { date: '2026-10-01', extractedText: text(1) }), receipt(30, { date: '2026-10-01', extractedText: text(1), filename: 'kopie-1.pdf' }), receipt(12, { date: '2026-10-05', extractedText: text(2) }), receipt(12, { date: '2026-10-05', extractedText: text(2), filename: 'kopie-2.pdf' })];
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    b.receipts.push(...rs);
    b.transactions.push(chf('S1', 30, { date: '2026-10-03' }), chf('S2', 12, { date: '2026-10-07' }));
    b.mappings.push(...[['S1', rs[0]], ['S1', rs[1]], ['S2', rs[2]], ['S2', rs[3]]].map(([ref, x]) => ({ transactionRef: ref as string, receiptId: (x as Receipt).id, by: 'human' as const })));
  });
  saveBooks(ws, books);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'S2'), undefined, 'each payment holds one invoice twice: no batch');
  const two = loadBooks(ws);
  const more = [receipt(8, { date: '2026-10-02' }), receipt(5, { date: '2026-10-06' })];
  update(two, PERSON, (b) => { b.receipts.push(...more); b.mappings.push({ transactionRef: 'S1', receiptId: more[0].id, by: 'human' }, { transactionRef: 'S2', receiptId: more[1].id, by: 'human' }); });
  saveBooks(ws, two);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'S2')?.business.id, 'marktplatz', 'two documents each: offered');
  writeFileSync(join(ws.paths.root, file), `${readFileSync(join(ws.paths.root, file), 'utf8')}grouped: false\n`);
  assert.equal(groupedOffer(ws, loadBooks(ws), 'S2'), undefined, 'the company said no');
});

test('a leg of a split card charge books only its share of the receipt\'s VAT: told so in the prompt, refused when its input tax with the other leg\'s exceeds the receipt', async () => {
  const r = receipt(156.86, { kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 3.75, gross: 50 }, { ratePercent: 0, vat: 0, gross: 106.86 }] });
  const legs = [eurLeg(), chfLeg()];
  const b = booksOf(legs, [r], legs.map((t) => ({ transactionRef: t.ref, receiptId: r.id, by: 'human' as const })));
  const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: [{ bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }, { bank: 'Wise', currency: 'CHF', account: '1024', label: 'Wise CHF', role: 'bank' }] };
  const amounts: Record<string, number> = { 'CARD-1-EUR': 100, 'CARD-1-CHF': 63.36 };
  const prompts: string[] = [];
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    prompts.push(prompt);
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    // The whole leg at 8.1 %: more input tax than the receipt shows, on each leg.
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '4200', accountCredit: '', amount: amounts[ref], vatCode: 'M81', description: 'Marktplatz' }], reason: 'Wareneinkauf.' }])));
  };
  const { classified, failed } = await classifyTransactions(b, legs, { ask, fx: loadFxResolver(), context });
  assert.match(prompts.join('\n'), /Shared receipt: the receipt below also pays CARD-1-EUR \(100 EUR\)/);
  assert.deepEqual(classified, []);
  assert.deepEqual(failed.map((f) => [f.ref, f.refusal?.code]).sort(), [['CARD-1-CHF', 'classifyInputTaxShared'], ['CARD-1-EUR', 'classifyInputTaxShared']]);
  assert.deepEqual(b.journalEntries, [], 'nothing booked: the person books the shares');
});

test('copies in the pairing chain: a copy does not compete with its original, which is linked; the copy stays for Belege', async () => {
  const text = 'Marktplatz Beispiel Rechnung Bestellung 4711000 Total CHF 87.40';
  const original = receipt(87.4, { extractedText: text, indexedAt: '2026-08-10T10:00:00Z' });
  const copy = receipt(87.4, { extractedText: text, filename: 'kopie.pdf', indexedAt: '2026-08-11T10:00:00Z' });
  const b = booksOf([chf('P', 87.4)], [original, copy]);
  await runPairChain({ read: () => b, update: (fn) => fn(b) }, { toChf });
  assert.deepEqual(linksOf(b), [`${original.id}>P`]);
  assert.ok(b.receipts.some((x) => x.id === copy.id && x.kind !== 'duplicate'), 'the copy is left as it was, for the copy question');
});

test('Kontoauszüge: the offered sets belong to the payment shown (keyed by its ref, never the previous payment\'s), a failed fetch is said, a rounding set says so', () => {
  const src = readFileSync('src/app/areas/bank/Detail.tsx', 'utf8');
  assert.match(src, /<ReceiptSetOffer key=\{`rs-\$\{tx\.ref\}`\}/);
  assert.match(src, /t\('bank\.receiptSet\.failed'\)/);
  assert.match(src, /s\.rounding \? 'bank\.receiptSet\.rounding'/);
});

// ─── Third review round ─────────────────────────────────────────────────────

const FEDEX_UID = 'CHE-105.998.554';
const fedexInvoice = (amount: number, over: Partial<Receipt> = {}) => receipt(amount, { vatId: FEDEX_UID, title: undefined,
  extractedText: `FedEx Express Swiss Post GmbH\nRechnung ${amount}4711\n${FEDEX_UID} MWST\nKunde: Beispiel AG, CHE-123.456.789 MWST\nFracht`, ...over });

test('a FedEx invoice printing FedEx\'s shared UID and the buyer\'s is FedEx\'s: staged with an underscore name, with a generic name, archived without a trailing dash, archived under a name the model chose', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const app = batchPayersOf(ws);
  assert.match(readFileSync('processes/suppliers/fedex.yaml', 'utf8'), /sharedUid: \[ "CHE-105\.998\.554" \]/, 'the shared UID stands in the app file, not in code');
  assert.equal(app.ofReceipt(fedexInvoice(30, { location: 'staged', filename: '20260618_fedex_4711_copy.pdf', extractedText: 'Rechnung 4711' })), 'fedex', 'staged, underscore name');
  assert.equal(app.ofReceipt(fedexInvoice(30, { location: 'staged', filename: 'receipt-2026-05-09T10-12-00.pdf' })), 'fedex', 'a generic name: read by its text, its UIDs being shared and the buyer\'s');
  assert.equal(app.ofReceipt(fedexInvoice(30, { filename: '20260618-fedex.pdf', extractedText: 'Rechnung 4711' })), 'fedex', 'archived without a trailing dash');
  assert.equal(app.ofReceipt(fedexInvoice(30, { filename: '20260618-fracht-4711.pdf', originalFilename: '20260618_fedex_4711_copy.pdf', extractedText: 'Rechnung 4711' })), 'fedex', 'by the name it came with');
  const staged = fedexInvoice(30, { location: 'staged', filename: 'receipt-2026-05-09T10-12-00.pdf' });
  const txs = [chf('SHOP', 30, { description: 'Velo Huber AG' }), chf('FDX', 95, { description: 'FEDEX EXPRESS SWISS' })];
  assert.deepEqual(candidates(staged, txs, new Set(), () => false, app).map((t) => t.ref), ['FDX'], 'the model is shown FedEx\'s payments for it');
});

test('a BAZG assessment of a FedEx shipment joins no FedEx set: it names the BAZG too, and an assessment is no invoice', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  const evv = (over: Partial<Receipt> = {}) => receipt(25, { kind: 'supporting', vatId: undefined, title: undefined, filename: 'evv-26CH0001.pdf',
    extractedText: `Bundesamt für Zoll und Grenzsicherheit BAZG\nVeranlagungsverfügung MWST\nAnmelder: FedEx Express Swiss Post GmbH ${FEDEX_UID}\nImporteur: Beispiel AG CHE-123.456.789`, ...over });
  assert.notEqual(app.ofReceipt(evv()), 'fedex');
  const [f1, f2] = [fedexInvoice(30, { date: day(1), filename: '20260711-fedex-fracht.pdf' }), fedexInvoice(40, { date: day(2), filename: '20260712-fedex-zoll.pdf' })];
  for (const a of [evv({ date: day(1) }), evv({ date: day(1), extractedText: `Veranlagungsverfügung MWST\nFedEx Express Swiss Post GmbH ${FEDEX_UID}` })]) {
    const b = booksOf([chf('FDX', 95, { date: day(5), description: 'FEDEX EXPRESS SWISS' })], [f1, f2, a]);
    assert.ok(!receiptSetsToLink(b, { isOpen: open, payers: app }).sets.some((s) => s.receipts.includes(a.id)), 'not linked in a set');
    assert.ok(!proposalsFor(b, b.transactions[0], { isOpen: open, payers: app }).sets.some((s) => s.receipts.includes(a.id)), 'nor proposed in one');
  }
  assert.throws(() => compileCounterparty({ id: 'x', name: 'X', sharedUid: [UID], match: { uid: [UID] } }, { vendor: 'processes/suppliers/x.yaml' }, 'supplier'), /sharedUid .* match\.uid/);
});

test('an AliExpress Tax Invoice archived under a store name keeps its batch payer by the name it came with ({orderId}_payment.pdf)', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  const tax = (amount: number, order: string, date: string) => receipt(amount, { date, vatId: 'CHE-447.613.666', title: undefined, filename: `${date.replace(/-/g, '')}-alibaba-kabelshop.pdf`, originalFilename: `${order}_payment.pdf`,
    extractedText: `Tax Invoice\nAlibaba.com Singapore E-Commerce Private Limited\nCHE-447.613.666 MWST\nOrder ${order}` });
  const rs = [tax(12.3, '8123456781', day(1)), tax(7.7, '8123456782', day(2))];
  assert.equal(app.ofReceipt(rs[0]), 'aliexpress');
  const b = booksOf([chf('ALI', 20, { date: day(5), description: 'ALIEXPRESS.COM' })], rs);
  assert.deepEqual(receiptSetsToLink(b, { isOpen: open, payers: app }).sets.map((s) => s.receipts), [ids(rs)]);
});

test('a set far off the payment is close, never rounding: 30 + 40 for 70.60', () => {
  const rs = [receipt(30), receipt(40)];
  const b = booksOf([chf('P', 70.6)], rs);
  assert.deepEqual(proposalsFor(b, b.transactions[0], open).sets.map((s) => [s.receipts, s.exact, s.rounding]), [[ids(rs), false, undefined]]);
});

test('the buyer\'s own UID says nothing of who wrote a receipt: it neither stops reading its text nor makes one vendor of many shops', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const app = batchPayersOf(ws);
  const buyerOnly = receipt(30, { vatId: undefined, title: undefined, filename: 'scan-1.pdf', extractedText: `FedEx Express Swiss Post GmbH\nRechnung 4711\nKunde: Beispiel AG ${ws.company.uid} MWST` });
  assert.equal(app.ofReceipt(buyerOnly), 'fedex');
  assert.equal(app.ofReceipt({ ...buyerOnly, extractedText: `${buyerOnly.extractedText}\nCHE-283.746.519 MWST` }), undefined, 'a UID of the issuer\'s own: its text routes nothing');
  const misread = (amount: number, vendor: string) => receipt(amount, { vatId: ws.company.uid, title: { vendor, what: 'Einkauf' }, extractedText: `${vendor} Quittung ${amount}` });
  const b = booksOf([chf('P', 70, { description: 'Kartenzahlung' })], [misread(30, 'Garage Muster'), misread(40, 'Papeterie Muster')]);
  assert.deepEqual(receiptSetsToLink(b, open).sets, [], 'a VAT number on the receipts of two title vendors is no one vendor, even without the firm\'s UID');
  assert.deepEqual(receiptSetsToLink(b, { isOpen: open, firmUid: ws.company.uid }).sets, [], 'two shops, no set');
  assert.deepEqual(proposalsFor(b, b.transactions[0], { isOpen: open, firmUid: ws.company.uid }).sets, []);
});

test('the title\'s vendor routes as a whole word, and the titles prompt says the vendor is the issuer, not a carrier or payment method it mentions', () => {
  const app = batchPayersOf(workspaceAt(DEMO_ROOT));
  const titled = (vendor: string) => receipt(30, { vatId: 'CHE-283.746.519', title: { vendor, what: 'Teile' }, filename: 'r.pdf', extractedText: 'Rechnung' });
  assert.equal(app.ofReceipt(titled('FedEx Express')), 'fedex');
  assert.equal(app.ofReceipt(titled('Fedexo Kurier')), undefined, 'a part of a word is no name');
  assert.match(readFileSync('src/llm/prompts.ts', 'utf8'), /The vendor is who issued the document, as its head names it: never a carrier, payment method or bank/);
});
