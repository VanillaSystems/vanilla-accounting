/**
 * #402: the model's «no Swiss VAT» on an account that takes no VAT code at all (the wage account, a
 * social insurance's contributions, the bank-charges account, a debt, the owner's account) books no
 * code, as the guide and the hand form do (cls-salary, cls-social-insurance, #359). The zero code
 * there has no box, so no figure changes; a purchase without Swiss VAT keeps its zero code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const bankAccounts: LedgerBankAccount[] = [{ bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };
const tx = (ref: string, description: string): BankTransaction => ({ ref, bank: 'ZKB', date: '2026-08-25', amount: 100, currency: 'CHF', direction: 'DBIT', description });
const line = (e: Partial<ClassifyEntry>): ClassifyEntry => ({ accountDebit: '', accountCredit: '', amount: 100, description: 'Wer, Was', vat: 'none', ...e });

async function codes(answers: Record<string, ClassifyEntry[]>, swissVat: string[] = []): Promise<Record<string, Array<string | undefined>>> {
  const txs = Object.keys(answers).map((ref) => tx(ref, `Zahlung ${ref}`));
  const receipts = swissVat.map((ref) => ({ id: `r-${ref}`, filename: `${ref}.pdf`, extractedText: 'Rechnung mit MWST 8.1 %', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 7.49, gross: 100 }] }));
  const mappings = swissVat.map((ref) => ({ transactionRef: ref, receiptId: `r-${ref}` }));
  const b = { transactions: txs, receipts, mappings, bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: answers[ref] }])));
  };
  const { failed } = await classifyTransactions(b, txs, { ask, fx, context });
  assert.deepEqual(failed, []);
  const out: Record<string, Array<string | undefined>> = {};
  for (const e of b.journalEntries) (out[e.transactionRef] ??= []).push(e.vatCode);
  return out;
}

test('no zero code on a wage, a contribution, the bank charges or a debt; a purchase keeps it', async () => {
  const got = await codes({
    WAGE: [line({ accountDebit: '5000' })],
    BVG: [line({ accountDebit: '2270', amount: 50 }), line({ accountDebit: '5720', amount: 50 })],
    AHV: [line({ accountDebit: '5700' })],
    FEE: [line({ accountDebit: '6940' })],
    BUY: [line({ accountDebit: '6570' })],
    UVG: [line({ accountDebit: '5730' })],
  });
  assert.deepEqual(got, { WAGE: [undefined], BVG: [undefined, undefined], AHV: [undefined], FEE: [undefined], BUY: ['I0'], UVG: ['I0'] });
});

test('Swiss VAT a receipt shows on such an account stays: only the zero code goes', async () => {
  const got = await codes({ FEE: [line({ accountDebit: '6940', vat: 'charged', vatRate: 8.1 })] }, ['FEE']);
  assert.deepEqual(got, { FEE: ['I81'] });
});
