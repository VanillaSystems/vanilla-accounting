/**
 * A payment in the books' currency that pays its invoice rounded to 5 Rappen (#478): the input tax
 * is the tax the invoice states, not one taken out of the payment. The painter's Swisscom bill
 * states 88.98 with 6.65 tax, the bank paid 89.00; 8.1 % of the payment is 6.67. The payment's line
 * keeps the account without a code and a single-leg line of the tax-amount code takes the invoice's
 * tax off that account (src/booking/receipt-tax.ts), for the classifier, a rule and a booking by
 * hand alike. A payment of exactly what an invoice states, whose stated tax is what the code takes,
 * stays one gross line; a payment less a cash discount stays one gross line of what was paid (#397,
 * guide spl-skonto). Synthetic amounts beside the persona's bill.
 */
import './support/demo-workspace.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { parseRule, type RuleFacts } from '../src/booking/rules.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { vatInFigures } from '../src/accounting/vat-in-figures.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import { bookPayment } from '../src/server/edits.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const ACCOUNTS: LedgerBankAccount[] = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', role: 'bank' }];
const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: ACCOUNTS };

const pay = (amount: number, description = 'Rechnung Juli Natel'): BankTransaction =>
  ({ ref: 'RB-1', bank: 'Raiffeisen', date: '2026-07-15', amount, currency: 'CHF', direction: 'DBIT', description, counterparty: 'Swisscom (Schweiz) AG' } as BankTransaction);

/** The painter's bill as read: total 88.98, net 82.33, tax 6.65. */
const swisscom: Receipt = { id: 'r1', filename: 'swisscom_juli.pdf', extractedText: 'Swisscom (Schweiz) AG\nTotal CHF 88.98', currency: 'CHF', amount: 88.98, date: '2026-07-10', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 82.33, vat: 6.65, gross: 88.98 }] } as Receipt;

const booksOf = (tx: BankTransaction, receipts: Receipt[]): Books => ({
  transactions: [tx], receipts, mappings: receipts.map((r) => ({ transactionRef: tx.ref, receiptId: r.id })),
  bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
} as unknown as Books);

const model = (entries: ClassifyEntry[]): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Mobilabo.' }])));
};

async function classified(tx: BankTransaction, receipts: Receipt[], ctx: ClassifyContext = context, ask: ClassifyDeps['ask'] | undefined = model([{ accountDebit: '6510', accountCredit: '1020', amount: tx.amount, vatCode: 'I81', description: 'Swisscom, Mobilabo Juli' }])): Promise<JournalEntry[]> {
  const books = booksOf(tx, receipts);
  const { classified, failed } = await classifyTransactions(books, [tx], { ...(ask && { ask }), fx, context: ctx });
  assert.deepEqual([classified, failed.map((f) => f.reason)], [[tx.ref], []]);
  return books.journalEntries;
}

const inputTax = (entries: JournalEntry[]) => vatInFigures(entries, '2026-01-01', '2026-12-31')?.input;
const onAccount = (entries: JournalEntry[], account: string) => Math.round(entries.reduce((s, e) => s + (e.accountDebit === account ? e.amount : 0) - (e.accountCredit === account ? e.amount : 0), 0) * 100) / 100;
const rows = (entries: JournalEntry[]) => entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);

test('Swisscom 88.98 with 6.65 tax, paid 89.00, booked by the model on I81: the input tax is the bill\'s 6.65, the 0.02 stays on 6510 without tax', async () => {
  const entries = await classified(pay(89), [swisscom]);
  assert.equal(inputTax(entries), 6.65, 'the tax the bill states, not 8.1 % of 89.00 (6.67)');
  assert.deepEqual(rows(entries), [['6510', '1020', 89, ''], ['', '6510', 6.65, 'I81-2']]);
  assert.equal(onAccount(entries, '6510'), 82.35, 'the bill\'s net and the rounding');
  assert.equal(onAccount(entries, '1020'), -89, 'the bank pays the payment');
  const linked = [swisscom];
  assert.deepEqual(entries.map((e) => evidenceCheck(e, linked, '2026-06-30', undefined, entries)), [undefined, undefined], 'no contradiction with the bill');
});

test('a company rule that books Swisscom on 8.1 % takes the bill\'s 6.65 too', async () => {
  const facts: RuleFacts = { account: () => true, vat: () => 'taken', counterparty: () => true };
  const parsed = parseRule({ id: 'swisscom', when: { text: 'Swisscom' }, then: { account: '6510', vat: 'I81' } }, facts);
  assert.ok(parsed.ok);
  const entries = await classified(pay(89), [swisscom], { ...context, rules: [{ rule: parsed.rule }] }, undefined);
  assert.equal(inputTax(entries), 6.65);
  assert.equal(onAccount(entries, '1020'), -89);
});

test('booked by hand, one line of 89.00 at 8.1 %: the input tax is the bill\'s 6.65', () => {
  const tx = pay(89);
  const books = booksOf(tx, [swisscom]);
  const entries = bookPayment(books, tx.ref, [{ accountDebit: '6510', accountCredit: '1020', amount: 89, vatCode: 'I81', description: 'Swisscom Juli' }], ACCOUNTS, fx);
  assert.equal(inputTax(entries), 6.65);
  assert.deepEqual(rows(entries), [['6510', '1020', 89, ''], ['', '6510', 6.65, 'I81-2']]);
  assert.ok(entries.every((e) => e.origin === 'manual' && e.receipts?.includes('r1')));
});

test('a payment of exactly the bill, whose stated tax is what the code takes: one gross line, unchanged', async () => {
  const bill = { ...swisscom, amount: 108.1, vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }] } as Receipt;
  const entries = await classified(pay(108.1), [bill]);
  assert.deepEqual(rows(entries), [['6510', '1020', 108.1, 'I81']]);
  assert.equal(inputTax(entries), 8.1);
});

test('a payment rounded to 5 Rappen whose bill states the tax the code takes anyway: one gross line, unchanged', async () => {
  // 108.12 states 8.10 tax; 8.1 % of 108.10 is 8.10 too.
  const bill = { ...swisscom, amount: 108.12, vatSummary: [{ ratePercent: 8.1, net: 100.02, vat: 8.1, gross: 108.12 }] } as Receipt;
  const entries = await classified(pay(108.1), [bill]);
  assert.deepEqual(rows(entries), [['6510', '1020', 108.1, 'I81']]);
});

test('a payment less 2 % Skonto: one gross line of what was paid, its tax on that (#397)', async () => {
  const bill = { ...swisscom, extractedText: 'Farbmix AG\nTotal CHF 1081.00\n2 % Skonto innert 10 Tagen', amount: 1081, vatSummary: [{ ratePercent: 8.1, net: 1000, vat: 81, gross: 1081 }] } as Receipt;
  const entries = await classified(pay(1059.38, 'Rechnung abzgl. 2% Skonto'), [bill]);
  assert.deepEqual(rows(entries), [['6510', '1020', 1059.38, 'I81']]);
  assert.equal(inputTax(entries), 79.38, '8.1 % of what was paid');
});

test('a payment more than 5 Rappen\'s rounding off the bill keeps its gross code', async () => {
  const entries = await classified(pay(89.1), [swisscom]);
  assert.deepEqual(rows(entries), [['6510', '1020', 89.1, 'I81']]);
});

test('a bill that states no total keeps the gross code', async () => {
  const bill = { ...swisscom, amount: undefined } as Receipt;
  const entries = await classified(pay(89), [bill]);
  assert.deepEqual(rows(entries), [['6510', '1020', 89, 'I81']]);
});

test('a payment of exactly the bill whose stated tax is not what the code takes: the bill\'s tax', async () => {
  const entries = await classified(pay(88.98), [swisscom]);
  assert.equal(inputTax(entries), 6.65, '8.1 % of 88.98 would be 6.67');
  assert.equal(onAccount(entries, '1020'), -88.98);
});

test('a stated tax far off the code\'s is a misread, not the bill\'s rounding: the gross code stays', async () => {
  const misread = { ...swisscom, vatSummary: [{ ratePercent: 8.1, net: 22.48, vat: 66.5, gross: 88.98 }] } as Receipt;
  const entries = await classified(pay(89), [misread]);
  assert.deepEqual(rows(entries), [['6510', '1020', 89, 'I81']]);
});
