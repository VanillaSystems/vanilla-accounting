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

test('2a: a centime off the original amount is a proposal, never a link; two sets that fit it are proposals too', () => {
  const off = booksOf([pay('W1', 47.12)], [receipt(19.31), receipt(25)]);
  assert.deepEqual(receiptSetsToLink(off, open).sets, []);
  assert.deepEqual(proposalsFor(off, off.transactions[0], open).sets.map((s) => [s.sum, s.paid, s.exact, s.basis]), [[44.31, 44.3, false, 'original']]);
  const two = booksOf([pay('W1', 47.12)], [receipt(19.3), receipt(25), receipt(20.3), receipt(24)]);
  assert.deepEqual(receiptSetsToLink(two, open).sets, []);
  assert.equal(proposalsFor(two, two.transactions[0], open).sets.filter((s) => s.exact).length, 2);
});

// ─── 2b ─────────────────────────────────────────────────────────────────────

const ORIGINAL = 'Card transaction of 156.86 CHF issued by Marktplatz Beispiel';
const eurLeg = (over: Partial<BankTransaction> = {}) => pay('CARD-1-EUR', 100, { description: `${ORIGINAL} (fee: 0.58 EUR)`, ...over });
const chfLeg = (over: Partial<BankTransaction> = {}) => pay('CARD-1-CHF', 63.36, { currency: 'CHF', description: ORIGINAL, ...over });

test('2b: the legs of one card charge split across balances are one charge; other merchants, the same balance twice, a leg that paid it all or two bank ids are not', () => {
  assert.deepEqual(chargesOf([eurLeg(), chfLeg()]).splits.map((c) => c.refs), [['CARD-1-CHF', 'CARD-1-EUR']]);
  assert.deepEqual(chargesOf([eurLeg(), chfLeg({ description: 'Card transaction of 156.86 CHF issued by Andere Firma' })]).splits, [], 'another merchant');
  assert.deepEqual(chargesOf([eurLeg(), eurLeg({ ref: 'CARD-2-EUR' })]).splits, [], 'the same balance twice: two charges');
  assert.deepEqual(chargesOf([eurLeg(), chfLeg({ amount: 156.86 })]).splits, [], 'the CHF movement paid the whole charge: a charge of its own');
  assert.deepEqual(chargesOf([eurLeg({ bankTxId: 'CARD-1' }), chfLeg({ bankTxId: 'CARD-2' })]).splits, [], 'two bank ids');
  assert.deepEqual(chargesOf([eurLeg({ date: '2026-08-13' }), chfLeg()]).splits, [], 'another day');
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
  const { sets } = linkReceiptSets(b, open);
  assert.deepEqual(sets.map((s) => [s.legs, s.receipts, s.basis]), [[['CARD-1-CHF', 'CARD-1-EUR'], ids(rs), 'original']]);
  assert.equal(b.mappings.length, 4);
});

test('2b: a leg that waits while the other holds the charge\'s receipt gets it too; never one a person took apart, never on a sum that is not the charge', () => {
  const r = receipt(156.86);
  const b = booksOf([eurLeg(), chfLeg()], [r], [{ transactionRef: 'CARD-1-EUR', receiptId: r.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b, open), [{ legs: ['CARD-1-CHF'], receipts: [r.id] }]);
  assert.deepEqual(linksOf(b), [`${r.id}>CARD-1-CHF`, `${r.id}>CARD-1-EUR`]);
  const apart = receipt(156.86, { notPaidBy: ['CARD-1-CHF'] });
  const b2 = booksOf([eurLeg(), chfLeg()], [apart], [{ transactionRef: 'CARD-1-EUR', receiptId: apart.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b2, open), []);
  const part = receipt(100);
  const b3 = booksOf([eurLeg(), chfLeg()], [part], [{ transactionRef: 'CARD-1-EUR', receiptId: part.id, by: 'human' }]);
  assert.deepEqual(linkSplitLegs(b3, open), [], 'the receipt is not the whole charge');
});

test('2b: each leg books its own share in its own currency at the ESTV rate of its day, with the receipt\'s VAT, and the wait releases every leg', async () => {
  const r = receipt(156.86, { kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 11.76, gross: 156.86 }] });
  const legs = [eurLeg(), chfLeg()];
  const b = booksOf(legs, [r]);
  const ctx: WaitContext = { free: new Set(), wordings: [], assumesUnread: new Set(), ownIbans: new Set(), settles: () => false, inputTax: true };
  const waits = () => legs.map((t) => receiptWait(t, { linked: linkedOf(mappedReceipts(b, t)) }, ctx).wait);
  assert.deepEqual(waits(), [true, true], 'no receipt yet: both legs wait');
  linkReceiptSets(b, open);
  linkSplitLegs(b, open);
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
  const rs = Array.from({ length: MAX_TRIED + 3 }, (_, i) => receipt(10 + i, { date: day(i) }));
  const paid = rs.slice(0, 5).reduce((s, r) => s + r.amount!, 0);
  const b = booksOf([chf('S1', paid, { date: '2026-08-01' })], rs);
  assert.deepEqual(receiptSetsToLink(b, open).sets, [], 'without the flag: more than code combines, only proposed');
  assert.deepEqual(proposalsFor(b, b.transactions[0], open).cut, { near: MAX_TRIED + 3, tried: MAX_TRIED, limit: 'combinations' }, 'the limit is named to the person');
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
  const twice = booksOf([eur], [receipt(40, { date: day(1) }), receipt(55, { date: day(2) }), receipt(0.5, { date: day(3) })]);
  assert.deepEqual(receiptSetsToLink(twice, { isOpen: open, payers, toChf }).sets, [], '95.00 and 95.50 both in the band');
});

// ─── 2d ─────────────────────────────────────────────────────────────────────

test('2d: no vendor is named in the match step; a batch payer is its file\'s, recognised by its match', () => {
  assert.doesNotMatch(readFileSync('src/intake/match.ts', 'utf8'), /amazon|aliexpress|fedex/i);
  const r = receipt(30);
  assert.equal(payers.ofReceipt(r), 'marktplatz');
  assert.equal(payers.ofReceipt(receipt(30, { vatId: 'CHE-999.888.777', extractedText: 'Andere Firma' })), undefined);
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

test('2e: a copy by its number (a scan beside the PDF), and copies a person linked both: counted once', () => {
  const pdf = receipt(30, { extractedText: 'Marktplatz Beispiel Rechnung Nr. 4711000 vom 10.08.2026 Total CHF 30.00 MWST 8.1%' });
  const scan = receipt(30, { extractedText: 'MARKTPLATZ BElSPIEL Rechnunq 4711000 30.00' });
  const rest = receipt(57.4);
  const b = booksOf([chf('S1', 87.4)], [pdf, scan, rest]);
  assert.equal(receiptSetsToLink(b, open).sets.length, 1);
  const linked = booksOf([chf('S1', 87.4)], [pdf, scan, rest], [{ transactionRef: 'S1', receiptId: pdf.id, by: 'human' }, { transactionRef: 'S1', receiptId: scan.id, by: 'human' }]);
  assert.deepEqual(receiptSetsToLink(linked, open).sets.map((s) => [s.receipts, s.sum]), [[[rest.id], 87.4]], 'the two linked documents count 30.00, not 60.00');
});

test('2e: two receipts of one amount and day with their own order numbers are two documents, not copies', () => {
  const b = booksOf([chf('S1', 60)], [receipt(30), receipt(30)]);
  assert.deepEqual(receiptSetsToLink(b, open).sets.map((s) => s.receipts.length), [2]);
});
