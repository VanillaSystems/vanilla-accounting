/**
 * Every payment of the books has a reference of its own (#401). A camt.053 whose entries carry the
 * bank's reference only in their transaction details is read by it; an entry with no reference
 * anywhere gets one derived from its own facts, the same on every read; a later export that names
 * the same payment by the bank's reference is that payment, not a second one; and no write puts a
 * payment, a link or an entry on an empty reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDerivedRef, readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { mergeIndex, type Scan } from '../src/books/bank-import.js';
import { PERSON, update, type Books } from '../src/books/store.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';

const FILE = readFileSync(join(import.meta.dirname, 'fixtures/camt053/wise_EUR_refs_in_txdtls.xml'), 'utf8');
/** The same statement with no reference anywhere: the entries' facts are all there is. */
const NO_REFS = FILE.replace(/<Refs>.*?<\/Refs>/g, '');
const read = (xml: string) => readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: 'Wise', statements: 'wise' }));

test('a Wise entry whose reference is only in its transaction details is read by it', () => {
  const txs = read(FILE);
  assert.equal(txs.length, 7);
  assert.deepEqual(txs.map((t) => t.ref), ['CARD-910000', 'CARD-910037', 'CARD-910074', 'CARD-910111', 'TRANSFER-910148', 'CARD-910185', 'CARD-910222']);
});

test('an entry with no reference anywhere gets one derived from its facts, unique and the same on every read', () => {
  const txs = read(NO_REFS);
  const refs = txs.map((t) => t.ref);
  assert.ok(refs.every((r) => r.trim() && isDerivedRef(r)), refs.join(', '));
  assert.equal(new Set(refs).size, 7, 'each payment its own');
  assert.deepEqual(read(NO_REFS).map((t) => t.ref), refs, 'read twice, the same refs');
  assert.ok(!read(FILE).some((t) => isDerivedRef(t.ref)), 'a bank reference is never marked derived');
});

test('two equal payments on one day without a reference are told apart by their place among equals', () => {
  const entry = FILE.match(/<Ntry>[\s\S]*?<\/Ntry>/)![0].replace(/<Refs>.*?<\/Refs>/g, '');
  const xml = FILE.replace(/<Ntry>[\s\S]*<\/Ntry>/, entry + entry);
  const refs = read(xml).map((t) => t.ref);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1]);
});

// ─── The books: a later export with the bank's references ─────────────────────

const receipt = (id: string): Receipt => ({ id, filename: `${id}.pdf`, extractedText: 'text', location: 'archived' } as Receipt);
const books = (over: Partial<Index> = {}): Index => ({
  receipts: [receipt('r1')], transactions: [], mappings: [], bankStatements: [], journalEntries: [],
  config: { closedThrough: '2026-06-30' } as Index['config'], ...over,
});
const scan = (bankTransactions: BankTransaction[]): Scan => ({ receipts: [receipt('r1')], bankTransactions, reads: [], camtBalances: [], bankStatements: [] });

test('the books hold the payments by derived refs: the export with the bank references adds none and keeps their bookings', () => {
  const derived = read(NO_REFS);
  const real = read(FILE);
  const entry = { id: 'e1', transactionRef: derived[0].ref, date: derived[0].date, accountDebit: '6570', accountCredit: '1021', amount: 12, origin: 'classify' as const };
  const before = books({ transactions: derived, mappings: [{ transactionRef: derived[0].ref, receiptId: 'r1', by: 'llm' }], journalEntries: [entry] });
  const after = mergeIndex(before, scan([...derived, ...real])).index;
  assert.equal(after.transactions.length, 7, 'one payment each, not two');
  assert.deepEqual(after.transactions.map((t) => t.ref), derived.map((t) => t.ref), 'the refs the bookings stand on');
  assert.deepEqual(after.transactions.map((t) => t.statement), real.map((t) => t.ref), 'each names the bank\'s reference');
  assert.deepEqual(after.mappings, before.mappings);
  // Read again, and with the derived file gone: still the same seven.
  const again = mergeIndex(after, scan([...derived, ...real])).index;
  assert.deepEqual(again.transactions.map((t) => t.ref), derived.map((t) => t.ref));
  const without = mergeIndex(after, scan(real)).index;
  assert.deepEqual(without.transactions.map((t) => t.ref), derived.map((t) => t.ref), 'the export alone: the same payments');
});

test('the books hold the bank references: a statement of the same payments without references adds none', () => {
  const real = read(FILE);
  const after = mergeIndex(books({ transactions: real }), scan([...real, ...read(NO_REFS)])).index;
  assert.deepEqual(after.transactions.map((t) => t.ref), real.map((t) => t.ref));
});

test('both files dropped at once: the bank references stand', () => {
  const real = read(FILE);
  const after = mergeIndex(books(), scan([...read(NO_REFS), ...real])).index;
  assert.deepEqual(after.transactions.map((t) => t.ref).sort(), real.map((t) => t.ref).sort());
});

// ─── Books that hold payments without a reference ─────────────────────────────

test('books that hold payments with an empty ref: the next read replaces them, and the link to "" goes', () => {
  const empty = read(FILE).map((t) => ({ ...t, ref: '' }));
  const line = { transactionRef: '', date: '2026-07-13', accountDebit: '6570', accountCredit: '1021', amount: 12 };
  const before = books({
    transactions: empty, mappings: [{ transactionRef: '', receiptId: 'r1', by: 'llm' }],
    journalEntries: [{ id: 'app', origin: 'classify', ...line }, { id: 'hers', origin: 'manual', ...line }],
  });
  const after = mergeIndex(before, scan(read(FILE))).index;
  assert.equal(after.transactions.length, 7);
  assert.ok(after.transactions.every((t) => t.ref), 'no payment without a ref');
  assert.deepEqual(after.mappings, []);
  assert.deepEqual(after.journalEntries!.map((e) => e.id), ['hers'], "the app's entry goes, a person's stays");
});

test('the write door refuses a payment, a link or an entry on an empty ref', () => {
  const b = books({ transactions: read(FILE) }) as Books;
  assert.throws(() => update(b, PERSON, (x) => { x.transactions.push({ ...x.transactions[0], ref: '' }); }), /Referenz/);
  assert.throws(() => update(b, PERSON, (x) => { x.mappings.push({ transactionRef: '', receiptId: 'r1' }); }), /Referenz/);
  assert.throws(() => update(b, PERSON, (x) => { x.journalEntries!.push({ id: 'e', transactionRef: ' ', date: '2026-08-01', accountDebit: '6570', accountCredit: '1021', amount: 1 }); }), /Referenz/);
  // Books that hold one already can still be written, and repaired.
  const held = books({ transactions: [{ ...read(FILE)[0], ref: '' }] }) as Books;
  update(held, PERSON, (x) => { x.mappings.push({ transactionRef: 'CARD-910037', receiptId: 'r1' }); });
  update(held, PERSON, (x) => { x.transactions = []; });
});
