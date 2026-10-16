/**
 * The correction of a filed entry by what was wrong (persona round 3, corner-29): a VAT code taken
 * back leaves the bank where the statement has it, an account moved leaves bank and VAT, and only
 * the storno reverses the bank side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { banksMoved, correctionKinds, correctionOf } from '../src/accounting/correction.js';
import { bookBalanceNative } from '../src/accounting/reconcile-bank.js';
import { vat } from '../src/engines/index.js';
import type { JournalEntry } from '../src/types/index.js';
import type { BookChange } from '../src/types/assistant.js';
import { changesIn } from '../src/assistant/changes.js';
import { applyAnswer } from '../src/server/edits.js';

/** The changes an answer of the AI asks for, as its ```vanilla-changes block says them. */
const asked = (json: string) => changesIn('```vanilla-changes\n' + json + '\n```') as BookChange[];

const isBank = (a: string) => a === '1020';
const natel: JournalEntry = { id: 'natel', transactionRef: 'RB-13', date: '2026-08-15', accountDebit: '6510', accountCredit: '1020', amount: 89, vatCode: 'I81', description: 'Natel August' };
const entry = (d: ReturnType<typeof correctionOf>): JournalEntry => ({ id: 'corr', transactionRef: 'M2026-001', corrects: '2026-Q3', ...d });
const bank = (es: JournalEntry[]) => bookBalanceNative(es, '1020', 'CHF', '2026', '2026-12-31', 0);
const tax = (e: JournalEntry) => Math.round((vat().vatLine(e)?.tax ?? 0) * 100) / 100;

test('a VAT code taken back: the expense against itself, the code turned; the bank stays, the input tax goes', () => {
  const d = correctionOf(natel, 'vat', '2026-10-16', 'Korrektur', isBank);
  assert.deepEqual(d, { date: '2026-10-16', accountDebit: '6510', accountCredit: '6510', amount: 89, vatCode: '-I81', description: 'Korrektur' });
  assert.equal(bank([natel, entry(d)]), bank([natel]), 'the payment happened: the bank is as the statement says');
  assert.equal(tax(natel), 6.67);
  assert.equal(tax(entry(d)), -6.67, 'the 0535 takes the input tax back');
  assert.deepEqual(banksMoved(d, isBank), []);
});

test('the storno moves the bank, and says so; it is offered last', () => {
  const d = correctionOf(natel, 'storno', '2026-10-16', 'Storno', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['1020', '6510', '-I81']);
  assert.equal(bank([natel, entry(d)]), bank([natel]) + 89, 'CHF 89 back on the bank in the books');
  assert.deepEqual(banksMoved(d, isBank), ['1020']);
  assert.deepEqual(correctionKinds(natel), ['vat', 'account', 'storno']);
  assert.deepEqual(correctionKinds({ ...natel, vatCode: undefined }), ['account', 'storno'], 'no code, nothing to take back');
});

test('an account moved: from the old to a new one the person types, bank and VAT untouched; a sale moves its revenue side', () => {
  const d = correctionOf(natel, 'account', '2026-10-16', 'Konto', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['', '6510', undefined]);
  const sale: JournalEntry = { ...natel, accountDebit: '1020', accountCredit: '3400', vatCode: 'V81' };
  const s = correctionOf(sale, 'account', '2026-10-16', 'Konto', isBank);
  assert.deepEqual([s.accountDebit, s.accountCredit], ['3400', '']);
  const v = correctionOf(sale, 'vat', '2026-10-16', 'MWST', isBank);
  assert.deepEqual([v.accountDebit, v.accountCredit, v.vatCode], ['3400', '3400', '-V81']);
  assert.equal(tax(entry(v)), -tax(sale), 'the output tax taken back exactly');
});

test('a one-sided VAT entry is turned whole: it has no bank side to keep', () => {
  const shopify: JournalEntry = { ...natel, accountDebit: '', accountCredit: '6580', amount: 12.4, vatCode: 'M81-2' };
  const d = correctionOf(shopify, 'vat', '2026-10-16', 'MWST', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['6580', '', '-M81-2']);
});

test('the AI turns that storno into a VAT-only correction: the same account on both sides is a change it can ask for (corner-30)', () => {
  const storno: JournalEntry = { ...entry(correctionOf(natel, 'storno', '2026-10-16', 'Korrektur', isBank)), origin: 'manual' };
  const books = () => ({
    receipts: [], transactions: [], mappings: [], bankStatements: [],
    journalEntries: [natel, structuredClone(storno)], config: { closedThrough: '2026-09-30' },
  });
  const ctx = { bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen' }], chart: new Set(['1020', '6510']), earlier: [] };
  for (const set of ['{"accountDebit":"6510"}', '{"accountDebit":6510,"accountCredit":6510}', '{"accountDebit":"6510","accountCredit":"6510","vatCode":"-I81"}']) {
    const b = books();
    applyAnswer(b, asked('[{"kind":"entry","id":"corr","set":' + set + '}]'), ctx);
    const corr = b.journalEntries.find((e) => e.id === 'corr')!;
    assert.deepEqual([corr.accountDebit, corr.accountCredit, corr.vatCode, corr.corrects], ['6510', '6510', '-I81', '2026-Q3'], set);
    assert.equal(bank(b.journalEntries), bank([natel]), `${set}: the bank is as the statement says`);
  }
  const added = books();
  applyAnswer(added, asked('[{"kind":"newEntry","entry":{"date":"2026-10-16","accountDebit":"6510","accountCredit":"6510","amount":89,"vatCode":"-I81","description":"nur die Vorsteuer","corrects":"2026-Q3"}}]'), ctx);
  assert.equal(tax(added.journalEntries.at(-1)!), -6.67, 'a new VAT-only correction as well');
  assert.throws(() => applyAnswer(books(), asked('[{"kind":"entry","id":"corr","set":{"accountDebit":"","accountCredit":""}}]'), ctx), /Soll- oder Habenkonto fehlt/);
});

test('a side left empty is refused with the way that works: the account on both sides', () => {
  const b = { receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [natel, { ...entry(correctionOf(natel, 'storno', '2026-10-16', 'K', isBank)), origin: 'manual' as const }], config: { closedThrough: '2026-09-30' } };
  const ctx = { bankAccounts: [], chart: new Set<string>(), earlier: [] };
  assert.throws(() => applyAnswer(b, asked('[{"kind":"entry","id":"corr","set":{"accountDebit":"6510","accountCredit":""}}]'), ctx), /6510\/6510/);
});
