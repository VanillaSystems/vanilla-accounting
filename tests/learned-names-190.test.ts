/**
 * #190 part 1: the merchant names a card statement gives a supplier, learned from confirmed links
 * into the company's file of the business (`match.tx`, kept in `learnedTx`), counted as the name in
 * the pair search, and taken out for good by a person. Invented businesses and payments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import './support/jurisdiction.js';
import { LEARN_AFTER, learnMerchantNames, merchantName, namesToLearn, removeLearnedName } from '../src/knowledge/learned-names.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { businesses } from '../src/intake/batch-payers.js';
import { searchPairs } from '../src/intake/pairing.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import { APP_FOLDER, APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import { initRepository } from '../src/workspace/git.js';
import { execFileSync } from 'node:child_process';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';

const UID = 'CHE-111.222.333';
const OTHER = 'CHE-192.837.465';
const toChf = (a: number) => a;
const kontor = (more = '') => compileCounterparty(parse(`id: kontor\nname: Kontorwaren Muster AG\nmatch:\n  uid: [ "${UID}" ]\n${more}`), { binding: 'knowledge/suppliers/kontor.yaml' }, 'supplier');
const atelier = () => compileCounterparty(parse(`id: atelier\nname: Atelier Beispiel GmbH\nmatch:\n  uid: [ "${OTHER}" ]\n`), { binding: 'knowledge/suppliers/atelier.yaml' }, 'supplier');

let n = 0;
const receipt = (over: Partial<Receipt> = {}): Receipt => {
  const k = ++n;
  return {
    id: `r${k}`, filename: `beleg-${k}.pdf`, originalFilename: `beleg-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
    date: '2026-08-10', amount: 40, currency: 'CHF', vatId: UID, title: { vendor: 'Kontorwaren Muster AG', what: 'Papier' }, extractedText: 'Kontorwaren Muster AG Rechnung', ...over,
  } as Receipt;
};
const pay = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Wise', date: '2026-08-11', amount: 40, currency: 'CHF', direction: 'DBIT', description: `Card transaction of 40.00 CHF issued by PAYPAL *KTWSHOP 4029${ref}`, ...over });
const booksOf = (transactions: BankTransaction[], receipts: Receipt[], mappings: Mapping[] = []): Books =>
  ({ transactions, receipts, mappings, bankStatements: [], journalEntries: [], config: {} }) as unknown as Books;
/** Two payments with the same card name, each linked to a receipt of the business, by `by`. */
const twice = (by: Mapping['by'], receiptOver: Partial<Receipt> = {}) => {
  const rs = [receipt(receiptOver), receipt(receiptOver)];
  return booksOf([pay('P1'), pay('P2')], rs, [{ transactionRef: 'P1', receiptId: rs[0].id, by }, { transactionRef: 'P2', receiptId: rs[1].id, by }]);
};

test('merchantName: the name before the card\'s reference, none for the bank\'s own words', () => {
  assert.equal(merchantName({ description: 'Card transaction of 12.40 CHF issued by AMZN Mktp DE*AB12CD34' }), 'AMZN Mktp DE');
  assert.equal(merchantName({ description: 'Card transaction of 9.00 EUR issued by PAYPAL *KTWSHOP 4029357733' }), 'PAYPAL *KTWSHOP');
  assert.equal(merchantName({ description: 'egal', counterparty: 'Kontorwaren Muster AG' }), 'Kontorwaren Muster AG', 'the counterparty field first');
  assert.equal(merchantName({ description: 'Karte 5412 Einkauf' }), undefined, 'only bank words before the number');
  assert.equal(merchantName({ description: 'ABC 123' }), undefined, 'fewer than four letters');
});

test(`namesToLearn: ${LEARN_AFTER} payments a person or the model linked to the business's receipts teach their name`, () => {
  for (const by of ['human', 'llm', undefined] as const) {
    assert.deepEqual(namesToLearn(twice(by), [kontor()]), [{ business: 'kontor', name: 'PAYPAL *KTWSHOP', payments: 2 }], String(by));
  }
  const once = twice('human');
  once.mappings.pop();
  assert.deepEqual(namesToLearn(once, [kontor()]), [], 'one payment is no practice yet');
  assert.deepEqual(namesToLearn(twice('rule'), [kontor()]), [], 'code alone confirms nothing');
  assert.deepEqual(namesToLearn(twice('human', { vatId: undefined, title: { vendor: 'Unbekannt', what: 'x' }, extractedText: 'Unbekannt' }), [kontor()]), [], 'a receipt of no known business teaches no business');
});

test('namesToLearn: never a name another business\'s receipt is linked to, one a file holds, or one learned before (a person\'s removal)', () => {
  const both = twice('human');
  const theirs = receipt({ vatId: OTHER, title: { vendor: 'Atelier Beispiel GmbH', what: 'Farbe' } });
  both.receipts.push(theirs);
  both.transactions.push(pay('P3'));
  both.mappings.push({ transactionRef: 'P3', receiptId: theirs.id, by: 'rule' });
  assert.deepEqual(namesToLearn(both, [kontor(), atelier()]), [], 'the name pays two businesses');
  assert.deepEqual(namesToLearn(twice('human'), [kontor('  tx: [ "paypal *ktwshop" ]\n')]), [], 'the file names it already');
  assert.deepEqual(namesToLearn(twice('human'), [kontor('learnedTx: [ "PAYPAL *KTWSHOP" ]\n')]), [], 'learned once and taken out by a person');
});

test('the pair search counts a payment that names the receipt\'s business by its file as its name: code links it alone', async () => {
  const r = receipt();
  const books = booksOf([pay('P9', { date: '2026-08-12' })], [r]);
  const bare = searchPairs(books, toChf, () => false, { businesses: businesses([kontor()]) }).byReceipt.get(r.id)![0];
  assert.equal(bare.words, 0, 'the card name shares no word with the vendor');
  assert.equal(bare.business, false);
  const withName = businesses([kontor('  tx: [ "paypal *ktwshop" ]\n')]);
  const c = searchPairs(books, toChf, () => false, { businesses: withName }).byReceipt.get(r.id)![0];
  assert.equal(c.business, true);
  assert.equal(c.score - bare.score, 20, 'as much as two words of the name');
  const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
  const without = await runPairChain(port(structuredClone(books)), { toChf });
  assert.equal(without.linked.length, 0, 'amount and day alone: the person\'s');
  const linked = await runPairChain(port(structuredClone(books)), { toChf, businesses: withName });
  assert.deepEqual(linked.linked.map((l) => [l.receipt, l.payment, l.signals.includes('name')]), [[r.id, 'P9', true]]);
});

test('learnMerchantNames writes the name into the company\'s file once; a person\'s removal sticks', () => {
  const repo = mkdtempSync(join(tmpdir(), 'learned-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  const path = 'knowledge/suppliers/kontor.yaml';
  const file = join(ws.paths.root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Kontorwaren, our paper supplier.\nid: kontor\nname: Kontorwaren Muster AG\nmatch:\n  uid: [ "${UID}" ]\n`);
  const books = twice('human');
  assert.deepEqual(learnMerchantNames(ws, books).map((l) => l.name), ['PAYPAL *KTWSHOP']);
  const learned = parse(readFileSync(file, 'utf8'));
  assert.deepEqual(learned.match, { uid: [UID], tx: ['PAYPAL *KTWSHOP'] });
  assert.deepEqual(learned.learnedTx, ['PAYPAL *KTWSHOP']);
  assert.match(readFileSync(file, 'utf8'), /^# Kontorwaren, our paper supplier\./, 'the file\'s comments stay');
  const cp = loadKnowledge(APP_ROOT, ws.paths.root).counterparties.find((c) => c.id === 'kontor')!;
  assert.deepEqual(cp.learnedTx, ['PAYPAL *KTWSHOP']);
  assert.equal(businesses([cp]).ofPayment(pay('P7')), 'kontor', 'the next payment with the name is the business\'s');
  assert.deepEqual(learnMerchantNames(ws, books), [], 'learned once');

  assert.equal(removeLearnedName(ws, cp, 'paypal *ktwshop'), path);
  const removed = parse(readFileSync(file, 'utf8'));
  assert.deepEqual(removed.match, { uid: [UID], tx: [] });
  assert.deepEqual(removed.learnedTx, ['PAYPAL *KTWSHOP'], 'kept, so it is not learned again');
  assert.deepEqual(learnMerchantNames(ws, books), [], 'the person\'s removal sticks');
  assert.equal(removeLearnedName(ws, cp, 'PAYPAL *KTWSHOP'), undefined, 'nothing left to take out');
});

test('Geschäftspartner marks a learned name; POST …/learned-names/remove takes it out at once as the person\'s save, and again is refused', async () => {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';
  const api = await startApi('demo/vanilla-accounting');
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const file = join(api.root, 'knowledge/suppliers/kontor.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `id: kontor\nname: Kontorwaren Muster AG\nmatch:\n  uid: [ "${UID}" ]\n  tx: [ "PAYPAL *KTWSHOP" ]\nlearnedTx: [ "PAYPAL *KTWSHOP" ]\n`);
  await initRepository(api.root, 'Workspace set up');
  try {
    const page = await api.send('GET', '/api/partners/kontor');
    assert.equal(page.status, 200, JSON.stringify(page.json));
    assert.deepEqual(page.json.learned, ['PAYPAL *KTWSHOP']);
    const removed = await api.send('POST', '/api/partners/kontor/learned-names/remove', { name: 'PAYPAL *KTWSHOP' });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.deepEqual(removed.json, { path: 'knowledge/suppliers/kontor.yaml', committed: true });
    assert.match(execFileSync('git', ['-C', api.root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /^Gelernter Name entfernt: kontor/);
    const after = await api.send('GET', '/api/partners/kontor');
    assert.deepEqual([after.json.learned, (after.json.match as { tx: string[] }).tx], [[], []]);
    const again = await api.send('POST', '/api/partners/kontor/learned-names/remove', { name: 'PAYPAL *KTWSHOP' });
    assert.deepEqual([again.status, (again.json as { code?: string }).code], [409, 'learnedNameGone']);
  } finally {
    await api.stop();
  }
});
