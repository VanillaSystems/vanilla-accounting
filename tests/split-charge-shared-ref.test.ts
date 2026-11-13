/**
 * #287: a Wise card charge paid from two balances arrives as two movements with one ref (the camt.053
 * reader keeps a currency split's shared ref), each with its own `FEE-<ref>` movement. Every leg is
 * booked on its own bank account with its share of the receipt's VAT; one booked leg never makes its
 * sibling count as booked. Synthetic payments and receipt, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { separateFeeOf } from '../src/booking/separate-fee.js';
import { legBooked } from '../src/accounting/payment-entries.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { vatInFigures } from '../src/accounting/vat-in-figures.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';

const ORIGINAL = 'Card transaction of 70.00 CHF issued by Tankstelle Beispiel';
const leg = (amount: number, currency: string): BankTransaction => ({ ref: 'CARD-7', bank: 'Wise', date: '2026-08-12', amount, currency, direction: 'DBIT', description: `${ORIGINAL} (fee: ${currency === 'EUR' ? 0.26 : 0.04} ${currency})` });
const feeLeg = (amount: number, currency: string): BankTransaction => ({ ref: 'FEE-CARD-7', bank: 'Wise', date: '2026-08-12', amount, currency, direction: 'DBIT', description: 'Wise Charges for: CARD-7', type: 'wise-fee' });
const receipt = { id: 'r1', filename: 'tank.pdf', originalFilename: 'tank.pdf', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-08-12', amount: 70, currency: 'CHF', kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 5.24, gross: 70 }], description: 'Tanken', extractedText: 'Tankstelle Beispiel Benzin 70.00 CHF MWST 8.1% 5.24' } as Receipt;
const accounts = [{ bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' as const }, { bank: 'Wise', currency: 'USD', account: '1024', label: 'Wise USD', role: 'bank' as const }];
const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: accounts };

/** A model that books each transaction it is shown with the amount the prompt names for it, at 8.1 % (6940 without VAT for a fee). */
const modelAt = (prompts: string[]): ClassifyDeps['ask'] => async (prompt) => {
  prompts.push(prompt);
  const out: Record<string, unknown> = {};
  for (const m of prompt.matchAll(/^### Transaction \d+: (\S+)\n {2}Date: \S+ \| Amount: (\S+) \S+ \| Direction: \S+ \| Bank: \S+\n {2}Bank description: (.*)$/gm)) {
    const fee = m[3].startsWith('Wise Charges');
    out[m[1]] = { entries: [{ accountDebit: fee ? '6940' : '6200', accountCredit: '', amount: Number(m[2]), vatCode: fee ? 'I0' : 'I81', description: fee ? 'Wise, Kartengebühren' : 'Tanken' }] };
  }
  return JSON.stringify(out);
};

test('#287: both legs of a charge split across two balances under one ref, and both fee legs, are booked on their own bank accounts, the receipt\'s VAT shared', async () => {
  const txs = [leg(60, 'EUR'), leg(16.6, 'USD'), feeLeg(0.26, 'EUR'), feeLeg(0.04, 'USD')];
  const b = { transactions: txs, receipts: [receipt], mappings: [{ transactionRef: 'CARD-7', receiptId: 'r1', by: 'human' }], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const prompts: string[] = [];
  const { failed } = await classifyTransactions(b, txs, { ask: modelAt(prompts), fx: loadFxResolver(), context });
  assert.deepEqual(failed, []);
  const rows = b.journalEntries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.exchangeCurrency]).sort();
  assert.deepEqual(rows, [
    ['CARD-7', '6200', '1023', 60, 'I81', 'EUR'],
    ['CARD-7', '6200', '1024', 16.6, 'I81', 'USD'],
    ['FEE-CARD-7', '6940', '1023', 0.26, undefined, 'EUR'],
    ['FEE-CARD-7', '6940', '1024', 0.04, undefined, 'USD'],
  ]);
  assert.match(prompts.join('\n'), /Shared receipt: the receipt below also pays CARD-7 \(16\.6 USD\)/, 'the EUR leg is told the USD leg pays the receipt too');
  assert.match(prompts.join('\n'), /Fee: 0\.04 USD, debited separately as FEE-CARD-7/, 'the USD leg names its own fee leg, not the EUR one');
  const input = vatInFigures(b.journalEntries, '2026-01-01', '2026-12-31')?.input ?? 0;
  assert.ok(Math.abs(input - 5.24) <= 5.24 * 0.03 + 0.05, `input tax of both legs ${input} is the receipt's 5.24`);
});

test('#287: a leg whose input tax with its sibling\'s booking exceeds the receipt is refused, never booked silently', async () => {
  const txs = [leg(60, 'EUR'), leg(16.6, 'USD')];
  const sibling: JournalEntry = { id: 'e1', transactionRef: 'CARD-7', date: '2026-08-12', accountDebit: '6200', accountCredit: '1023', amount: 75, vatCode: 'I81', description: 'Tanken', exchangeCurrency: 'EUR', exchangeRate: 0.93 } as JournalEntry;
  const b = { transactions: txs, receipts: [receipt], mappings: [{ transactionRef: 'CARD-7', receiptId: 'r1', by: 'human' }], bankStatements: [], journalEntries: [sibling], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const { failed } = await classifyTransactions(b, [txs[1]], { ask: modelAt([]), fx: loadFxResolver(), context });
  assert.deepEqual(failed.map((f) => [f.ref, f.refusal?.code]), [['CARD-7', 'classifyInputTaxShared']]);
  assert.deepEqual(b.journalEntries, [sibling]);
});

test('#287: one leg booked leaves its sibling under the same ref unbooked; a ref of one movement is booked by any entry', () => {
  const txs = [leg(60, 'EUR'), leg(16.6, 'USD'), { ...leg(5, 'CHF'), ref: 'SOLO' }];
  const entries = [{ transactionRef: 'CARD-7', accountDebit: '6200', accountCredit: '1023', amount: 60 }, { transactionRef: 'SOLO', accountDebit: '6200', accountCredit: '1020', amount: 5 }] as JournalEntry[];
  const booked = legBooked({ transactions: txs, journalEntries: entries }, accounts);
  assert.deepEqual(txs.map(booked), [true, false, true]);
});

test('#287: a payment\'s separate fee is the one on its own balance', () => {
  const fees = [feeLeg(0.26, 'EUR'), feeLeg(0.04, 'USD')];
  assert.equal(separateFeeOf(leg(16.6, 'USD'), fees)?.currency, 'USD');
  assert.equal(separateFeeOf(leg(60, 'EUR'), fees)?.currency, 'EUR');
  assert.equal(separateFeeOf(leg(3, 'CHF'), fees), undefined, 'a leg on a balance the bank took no fee from has none');
});
