/**
 * The model reads facts, code decides the code (issue #64, src/booking/line-vat.ts): the model
 * states per line whether Swiss VAT was charged and at what rate, Bezugsteuer, a tax amount; the
 * letter follows the account, the minus the money, the suffix the booking pattern. A code the model
 * still writes counts only for the facts it states. Rules take a rate (`vat: 81`) and read an old
 * code (`vat: I81`) with the letter of their account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { parseRule, type RuleFacts } from '../src/booking/rules.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { formTakes, lookupVatCode } from '../src/accounting/vat-codes.js';
import { parseVatFacts } from '../src/accounting/vat-facts.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, Receipt, VatFacts } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const bankAccounts: LedgerBankAccount[] = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };

const tx = (ref: string, direction: BankTransaction['direction'] = 'DBIT', amount = 100): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-08-14', amount, currency: 'CHF', direction, description: 'Bank text' });

function books(txs: BankTransaction[], receipts: Array<Partial<Receipt> & { id: string; ref: string }> = []): Books {
  return {
    transactions: txs,
    receipts: receipts.map(({ ref, ...r }) => ({ filename: `${r.id}.pdf`, extractedText: 'Beleg mit genug Text', ...r }) as Receipt),
    mappings: receipts.map((r) => ({ transactionRef: r.ref, receiptId: r.id })),
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}

/** The codes the classifier books for each payment when the model answers `answers[ref]`. */
async function booked(b: Books, answers: Record<string, ClassifyEntry[]>): Promise<Record<string, Array<string | undefined>>> {
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: answers[ref] }])));
  };
  const { failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(failed, []);
  const out: Record<string, Array<string | undefined>> = {};
  for (const e of b.journalEntries) (out[e.transactionRef] ??= []).push(e.vatCode);
  return out;
}

const line = (e: Partial<ClassifyEntry>): ClassifyEntry => ({ accountDebit: '', accountCredit: '', amount: 100, description: 'Lieferant, Ware', ...e });

test('the model states facts, code derives the code: the letter from the account, the minus from the money, the suffix from the pattern', async () => {
  const shows = (ref: string, ratePercent: number) => ({ id: `r-${ref}`, ref, hasSwissVat: true, vatSummary: [{ ratePercent, vat: (100 * ratePercent) / (100 + ratePercent), gross: 100 }] });
  const b = books([tx('MAT'), tx('OPS'), tx('BACK', 'CRDT'), tx('NONE'), tx('SUFFIX'), tx('ABROAD'), tx('SALE', 'CRDT'), tx('TAX')],
    [shows('MAT', 8.1), shows('OPS', 2.6), shows('SUFFIX', 8.1)]);
  const codes = await booked(b, {
    MAT: [line({ accountDebit: '4400', vat: 'charged', vatRate: 8.1 })],
    OPS: [line({ accountDebit: '6570', vat: 'charged', vatRate: 2.6 })],
    BACK: [line({ accountCredit: '4400', vat: 'charged', vatRate: 8.1 })],
    NONE: [line({ accountDebit: '4400', vat: 'none' })],
    SUFFIX: [line({ accountDebit: '6570', vat: 'charged', vatRate: 81 })],
    ABROAD: [line({ accountDebit: '6570', vat: 'acquisition' })],
    SALE: [line({ accountCredit: '3200', vat: 'charged', vatRate: 8.1 })],
    TAX: [line({ accountDebit: '6570', vat: 'none' }), line({ accountCredit: '6580', amount: 3.75, vat: 'charged', vatRate: 8.1, amountIs: 'tax' })],
  });
  assert.deepEqual(codes, {
    MAT: ['M81'], OPS: ['I26'], BACK: ['-M81'], NONE: ['M0'], SUFFIX: ['I81'], ABROAD: ['B81-1'], SALE: ['V81'], TAX: ['I0', 'I81-2'],
  });
  assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'TAX').map((e) => [e.accountDebit, e.accountCredit]), [['6570', '1021'], ['', '6580']], 'a tax amount keeps its one empty leg');
});

test('a model answer that still carries a letter comes out by code: I81 on a material line is M81, the minus follows the money, not the model', async () => {
  const b = books([tx('L'), tx('R', 'CRDT')], [{ id: 'r1', ref: 'L', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 7.49, gross: 100 }] }]);
  const codes = await booked(b, {
    L: [line({ accountDebit: '4400', vatCode: 'I81' })],
    R: [line({ accountCredit: '6570', vatCode: 'M81' })],
  });
  assert.deepEqual(codes, { L: ['M81'], R: ['-I81'] });
});

test('stated facts win over a code the model also wrote; a rate that is no Swiss rate is no Swiss VAT', async () => {
  const b = books([tx('BOTH'), tx('FOREIGN')]);
  const codes = await booked(b, {
    BOTH: [line({ accountDebit: '6570', vat: 'none', vatCode: 'I81' })],
    FOREIGN: [line({ accountDebit: '6570', vat: 'charged', vatRate: 19 })],
  });
  assert.deepEqual(codes, { BOTH: ['I0'], FOREIGN: ['I0'] });
});

test('a receipt\'s facts take no code: neither the type nor the API accepts one', () => {
  // @ts-expect-error: a receipt states facts; the code is the booking's, derived in code (issue #64)
  const typed: VatFacts = { hasSwissVat: true, vatSummary: [], vatCode: 'I81' };
  assert.ok(typed);
  const fail = (what: string): never => { throw new Error(what); };
  assert.throws(() => parseVatFacts({ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 1 }], vatCode: 'I81' }, fail), /Steuercode/);
  assert.deepEqual(parseVatFacts({ hasSwissVat: false, vatSummary: [] }, fail), { hasSwissVat: false, vatSummary: [] });
});

test('a rule takes a rate and reads an old code with the letter its account takes', () => {
  const facts: RuleFacts = { account: () => true, vat: (c) => (!lookupVatCode(c) ? 'unknown' : formTakes(c) ? 'taken' : 'notTaken'), counterparty: () => true };
  const vat = (then: Record<string, unknown>) => {
    const r = parseRule({ id: 'r', then }, facts, true);
    if (!r.ok) return `refused ${r.refusal.code}`;
    return r.rule.then.kind === 'book' ? [r.rule.then.booking.vat] : [];
  };
  assert.deepEqual(vat({ account: '6510', vat: 81 }), ['I81'], 'a rate as the code\'s suffix');
  assert.deepEqual(vat({ account: '4400', vat: '8.1' }), ['M81'], 'a rate in percent');
  assert.deepEqual(vat({ account: '4400', vat: 'I81' }), ['M81'], 'an old code: the letter is the account\'s');
  assert.deepEqual(vat({ account: '6510', vat: 'I81' }), ['I81']);
  assert.deepEqual(vat({ account: '6570', vat: 0 }), ['I0']);
  assert.deepEqual(vat({ account: '3400', vat: 81, fees: { account: '6840', vat: 0 } }), 'refused fees', 'a payout\'s split is the provider\'s clearing account now (#203)');
  assert.deepEqual(vat({ account: '6510', vat: 'B81-1' }), ['B81-1'], 'a code facts cannot be read off a rate stays as written');
  assert.deepEqual(vat({ account: '6510', vat: 'none' }), [null]);
  assert.equal(vat({ account: '6510', vat: 19 }), 'refused vat', 'no rate of the jurisdiction');
});
