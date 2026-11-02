/**
 * An invoice in the books' currency paid from a foreign-currency account: the input tax booked is
 * the tax the invoice states, not one taken out of the payment converted at the ESTV daily sell
 * rate (src/booking/receipt-tax.ts). An invoice in the payment's currency keeps the conversion.
 * Synthetic supplier and amounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { parseRule, type RuleFacts } from '../src/booking/rules.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { vatInFigures } from '../src/accounting/vat-in-figures.js';
import { chfAmount } from '../src/accounting/ledger.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const DATE = '2026-10-01';
const RATE = fx.daily('EUR', DATE)!;

const context: ClassifyContext = {
  companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '',
  bankAccounts: [{ bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' }],
};

const pay: BankTransaction = { ref: 'T1', bank: 'Wise', date: DATE, amount: 575, currency: 'EUR', direction: 'DBIT', description: 'Sent money to Lieferant Muster AG' };

/** A monthly invoice in CHF: net 500.00, 8.1 % tax 40.50, total 540.50. */
const chfInvoice: Receipt = { id: 'r1', filename: 'rechnung.pdf', extractedText: 'Monatsrechnung Lieferant Muster AG', currency: 'CHF', amount: 540.5, date: '2026-09-30', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 500, vat: 40.5 }] } as Receipt;

const model = (entries: ClassifyEntry[]): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Monatsrechnung.' }])));
};

async function book(receipts: Receipt[], ctx: ClassifyContext = context, ask: ClassifyDeps['ask'] = model([{ accountDebit: '4001', accountCredit: '1023', amount: 575, vatCode: 'M81', description: 'Lieferant Muster, Monatsrechnung' }])): Promise<JournalEntry[]> {
  const books = {
    transactions: [pay], receipts, mappings: receipts.map((r) => ({ transactionRef: pay.ref, receiptId: r.id })),
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  const { classified, failed } = await classifyTransactions(books, [pay], { ask, fx, context: ctx });
  assert.deepEqual([classified, failed.map((f) => f.reason)], [[pay.ref], []]);
  return books.journalEntries;
}

const inputTax = (entries: JournalEntry[]) => vatInFigures(entries, '2026-01-01', '2026-12-31')?.input;
const bankPaid = (entries: JournalEntry[]) => entries.filter((e) => e.accountCredit === '1023').reduce((s, e) => s + e.amount, 0);

test('an invoice that states its tax in CHF, paid in EUR: the input tax is the invoice\'s 40.50, the bank side stays the EUR payment at the ESTV rate', async () => {
  const entries = await book([chfInvoice]);
  assert.equal(inputTax(entries), 40.5, 'the invoice\'s tax, not 8.1 % of the converted payment');
  assert.equal(bankPaid(entries), 575, 'the bank pays the payment');
  const purchase = entries.find((e) => e.accountCredit === '1023')!;
  assert.deepEqual([purchase.accountDebit, purchase.vatCode, purchase.exchangeCurrency, purchase.exchangeRate], ['4001', undefined, 'EUR', RATE]);
  const tax = entries.find((e) => e.vatCode === 'M81-2')!;
  assert.deepEqual([tax.accountDebit, tax.accountCredit, tax.amount, tax.exchangeCurrency, tax.by], ['', '4001', 40.5, undefined, { kind: 'code', check: 'purchaseVat' }]);
  assert.equal(tax.transactionRef, pay.ref);
  const net = chfAmount(purchase) - tax.amount;
  assert.equal(Math.round(net * 100) / 100, Math.round((575 * RATE - 40.5) * 100) / 100, 'the account carries the converted payment less the tax');
});

test('an invoice in EUR that states its tax in EUR keeps the conversion: one gross line at the ESTV rate', async () => {
  const eurInvoice = { ...chfInvoice, currency: 'EUR', amount: 575, vatSummary: [{ ratePercent: 8.1, net: 531.91, vat: 43.09 }] } as Receipt;
  const entries = await book([eurInvoice]);
  assert.deepEqual(entries.map((e) => e.vatCode), ['M81']);
  const gross = Math.round(575 * RATE * 100) / 100;
  assert.equal(inputTax(entries), Math.round((gross * 8.1 / 108.1) * 100) / 100);
});

test('a payment that pays only part of the CHF invoice keeps the gross code: the invoice\'s tax is not all its own', async () => {
  const bigger = { ...chfInvoice, amount: 1081, vatSummary: [{ ratePercent: 8.1, net: 1000, vat: 81 }] } as Receipt;
  const entries = await book([bigger]);
  assert.deepEqual(entries.map((e) => e.vatCode), ['M81']);
});

test('a company rule that books the supplier on 8.1 % takes the CHF invoice\'s tax too', async () => {
  const facts: RuleFacts = { account: () => true, vat: () => 'taken', counterparty: () => true };
  const parsed = parseRule({ id: 'lieferant', when: { text: 'Lieferant Muster' }, then: { account: '4001', vat: 'M81' } }, facts);
  assert.ok(parsed.ok);
  const entries = await book([chfInvoice], { ...context, rules: [{ rule: parsed.rule }] }, undefined);
  assert.equal(inputTax(entries), 40.5);
  assert.equal(bankPaid(entries), 575);
});

test('a collective EUR payment whose CHF invoices are the whole payment\'s: a part booked by a rule keeps its gross code, no part takes the invoices\' tax', async () => {
  const batch: BankTransaction = { ...pay, ref: 'T2', amount: 595, description: 'Sammelauftrag', parts: [
    { amount: 575, currency: 'EUR', counterparty: 'Lieferant Muster AG', reference: 'RE-1' },
    { amount: 20, currency: 'EUR', counterparty: 'Beta GmbH', reference: 'RE-2' },
  ] };
  const small = { ...chfInvoice, id: 'r2', amount: 18, vatSummary: [{ ratePercent: 8.1, net: 16.65, vat: 1.35 }] } as Receipt;
  const facts: RuleFacts = { account: () => true, vat: () => 'taken', counterparty: () => true };
  const rules = [
    parseRule({ id: 'muster', when: { text: 'Lieferant Muster' }, then: { account: '4001', vat: 'M81' } }, facts),
    parseRule({ id: 'beta', when: { text: 'Beta GmbH' }, then: { account: '4001', vat: 'M81' } }, facts),
  ].map((p) => { assert.ok(p.ok); return { rule: p.rule }; });
  const receipts = [chfInvoice, small];
  const books = {
    transactions: [batch], receipts, mappings: receipts.map((r) => ({ transactionRef: batch.ref, receiptId: r.id })),
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  const { classified } = await classifyTransactions(books, [batch], { fx, context: { ...context, rules } });
  assert.deepEqual(classified, [batch.ref]);
  assert.deepEqual(books.journalEntries.map((e) => [e.amount, e.vatCode]), [[575, 'M81'], [20, 'M81']], 'each part gross at the ESTV rate, no tax-amount line from receipts the part does not hold alone');
});
