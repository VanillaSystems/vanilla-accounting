/**
 * Every payment of the books has a reference of its own (#401). A Wise camt.053 whose entries carry
 * the bank's reference only in their one transaction detail is read by it; the entry's own reference
 * wins; the other banks' entries without any keep their number in the statement (`<Stmt>#n`), so two
 * equal payments of one file are two. Books that hold payments on an empty ref (a Wise file read
 * before the fix) keep them exactly as they are, a filed one as filed, and a file's row of the same
 * movement adds none beside them; no write adds a payment, a link or an entry on an empty ref.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignUniqueRefs, readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { mergeIndex, type Scan } from '../src/books/bank-import.js';
import { PERSON, update, type Books } from '../src/books/store.js';
import { sealOf } from '../src/books/seal.js';
import type { StatementKind } from '../src/workspace/banks.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';

const FILE = readFileSync(join(import.meta.dirname, 'fixtures/camt053/wise_EUR_refs_in_txdtls.xml'), 'utf8');
const ENTRIES = FILE.match(/<Ntry>[\s\S]*?<\/Ntry>/g)!;
const wrap = (es: string[]) => FILE.replace(/<Ntry>[\s\S]*<\/Ntry>/, es.join(''));
const strip = (e: string) => e.replace(/<Refs>.*?<\/Refs>/g, '');
const read = (xml: string, kind: StatementKind = 'wise') => readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: 'Wise', statements: kind }));
const REFS = ['CARD-910000', 'CARD-910037', 'CARD-910074', 'CARD-910111', 'TRANSFER-910148', 'CARD-910185', 'CARD-910222'];

test('a Wise entry whose reference is only in its transaction details is read by it', () => {
  assert.deepEqual(read(FILE).map((t) => t.ref), REFS);
});

test('the entry\'s own reference wins over its detail\'s, for Wise and the other banks', () => {
  const both = ENTRIES[0].replace('<Ntry>', '<Ntry><AcctSvcrRef>ENTRY-REF</AcctSvcrRef>');
  assert.equal(read(wrap([both]))[0].ref, 'ENTRY-REF');
  assert.equal(read(wrap([both]), 'camt053')[0].ref, 'ENTRY-REF');
});

test('a Wise fee whose FEE- id stands only in the transaction details is still the Wise fee', () => {
  const fee = ENTRIES[0].replace('CARD-910000', 'FEE-CARD-910000');
  const [t] = read(wrap([fee]));
  assert.equal(t.ref, 'FEE-CARD-910000');
  assert.equal(t.type, 'wise-fee');
});

test('a Wise entry with no reference anywhere stays without one: its statement is refused at the import', () => {
  assert.deepEqual(read(wrap([strip(ENTRIES[0])])).map((t) => t.ref), ['']);
});

const books = (over: Partial<Index> = {}): Index => ({
  receipts: [{ id: 'r1', filename: 'r1.pdf', extractedText: 'x', location: 'archived' } as Receipt], transactions: [], mappings: [], bankStatements: [], journalEntries: [],
  config: { closedThrough: '2026-06-30' } as Index['config'], ...over,
});
const scan = (bankTransactions: BankTransaction[]): Scan => ({ receipts: books().receipts, bankTransactions, reads: [], camtBalances: [], bankStatements: [] });

test('two payments of one file on the same day and amount, one with a reference and one without, are both imported (other banks)', () => {
  const other = strip(ENTRIES[0]).replace(/<Nm>[^<]*<\/Nm>/, '<Nm>Ganz Anderer Laden</Nm>');
  const rows = assignUniqueRefs(read(wrap([ENTRIES[0], other]), 'camt053'));
  assert.equal(rows.length, 2);
  assert.match(rows[1].ref, /#2$/, 'numbered within its statement, as before');
  const once = mergeIndex(books(), scan(rows)).index;
  assert.deepEqual(once.transactions.map((t) => t.ref), rows.map((t) => t.ref));
  assert.deepEqual(mergeIndex(once, scan(rows)).index.transactions.map((t) => t.ref), rows.map((t) => t.ref), 'read again: still both');
  assert.ok(once.transactions.every((t) => t.statement === undefined), 'no payment is taken for another');
});

// ─── Books that hold payments on an empty ref ─────────────────────────────────

const real = read(FILE);
const empty = real.map((t) => ({ ...t, ref: '' }));
const line = (over: Partial<JournalEntry> = {}): JournalEntry => ({ id: 'e', transactionRef: '', date: real[0].date, accountDebit: '6570', accountCredit: '1021', amount: 12, ...over });

test('payments on an empty ref in a filed period: the next read adds nothing beside them, the filed records and the seal stay', () => {
  const b = books({ transactions: empty, mappings: [{ transactionRef: '', receiptId: 'r1', by: 'llm' }], journalEntries: [line({ id: 'app', origin: 'classify' })], config: { closedThrough: '2026-09-30' } as Index['config'] }) as Books;
  const seal = sealOf(b, '2026-Q3', '2026-10-01').sha256;
  const before = JSON.stringify({ t: b.transactions, m: b.mappings, e: b.journalEntries });
  update(b, PERSON, (x) => { Object.assign(x, mergeIndex(x, scan(real)).index); });
  assert.equal(JSON.stringify({ t: b.transactions, m: b.mappings, e: b.journalEntries }), before);
  assert.equal(sealOf(b, '2026-Q3', '2026-10-01').sha256, seal);
});

test('half of them filed, half open: the read adds none and drops none', () => {
  const b = books({ transactions: empty, mappings: [{ transactionRef: '', receiptId: 'r1', by: 'llm' }], journalEntries: [line({ id: 'app', origin: 'classify', date: real.at(-1)!.date })], config: { closedThrough: real[2].date } as Index['config'] }) as Books;
  update(b, PERSON, (x) => { Object.assign(x, mergeIndex(x, scan(real)).index); });
  assert.equal(b.transactions.length, 7);
  assert.ok(b.transactions.every((t) => t.ref === ''));
  assert.equal(b.mappings.length, 1);
  assert.deepEqual(b.journalEntries.map((e) => e.id), ['app']);
});

test('open payments on an empty ref with a person\'s entry: a read without the repair leaves them and her entry, adds nothing', () => {
  const b = books({ transactions: empty, mappings: [{ transactionRef: '', receiptId: 'r1', by: 'human' }], journalEntries: [line({ id: 'hers', origin: 'manual' })] }) as Books;
  update(b, PERSON, (x) => { Object.assign(x, mergeIndex(x, scan(real)).index); });
  assert.equal(b.transactions.length, 7);
  assert.deepEqual(b.journalEntries.map((e) => e.id), ['hers']);
  assert.deepEqual(b.mappings, [{ transactionRef: '', receiptId: 'r1', by: 'human' }]);
});

test('the write door refuses a payment, a link or an entry on an empty ref, also one in place of another', () => {
  const b = books({ transactions: real.slice() }) as Books;
  assert.throws(() => update(b, PERSON, (x) => { x.transactions.push({ ...x.transactions[0], ref: '' }); }), /ohne Referenz/);
  assert.throws(() => update(b, PERSON, (x) => { x.mappings.push({ transactionRef: '', receiptId: 'r1' }); }), /ohne Referenz/);
  assert.throws(() => update(b, PERSON, (x) => { x.journalEntries.push(line({ transactionRef: ' ' })); }), /ohne Referenz/);
  const held = books({ transactions: [empty[0]], journalEntries: [line({ id: 'a' })] }) as Books;
  assert.throws(() => update(held, PERSON, (x) => { x.journalEntries = [line({ id: 'b' })]; }), /ohne Referenz/, 'one taken away, another added');
  assert.throws(() => update(held, PERSON, (x) => { x.transactions = [empty[1]]; }), /ohne Referenz/, 'another payment in its place');
  update(held, PERSON, (x) => { x.journalEntries[0].accountDebit = '6600'; });
  update(held, PERSON, (x) => { x.transactions = []; x.journalEntries = []; });
});
