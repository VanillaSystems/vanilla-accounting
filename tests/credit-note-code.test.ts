/**
 * A supplier's credit note without its own document that names an invoice already booked takes the
 * invoice's code with the minus (owner's decision 16.10.2026), not the zero code of the receipt rule;
 * a credit note that names nothing booked keeps the receipt rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const bankAccounts: LedgerBankAccount[] = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };

const pay = (ref: string, description: string, direction: 'DBIT' | 'CRDT', amount: number): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-10-17', amount, currency: 'CHF', direction, description });

function booksWith(invoiceAccount: string, invoiceCode: string, credit: BankTransaction, creditPdf = false): Books {
  const invoice = { id: 'inv', filename: 'FM-78230.pdf', extractedText: 'Farbenmarkt AG Rechnung FM-78230 Kunde 40211 Total CHF 2000.00 MWST 8.1 % CHE-123.456.789', hasSwissVat: true } as Receipt;
  const own = { id: 'gs', filename: 'GS-1207.pdf', extractedText: 'Gutschrift GS-1207 ohne MWST-Ausweis', hasSwissVat: false } as Receipt;
  const booked: JournalEntry = { id: 'e1', transactionRef: 'P1', date: '2026-10-05', accountDebit: invoiceAccount, accountCredit: '1020', amount: 2000, vatCode: invoiceCode, description: 'Farbenmarkt FM-78230' };
  return {
    transactions: [pay('P1', 'Farbenmarkt AG FM-78230', 'DBIT', 2000), credit],
    receipts: creditPdf ? [invoice, own] : [invoice],
    mappings: [{ transactionRef: 'P1', receiptId: 'inv' }, ...(creditPdf ? [{ transactionRef: credit.ref, receiptId: 'gs' }] : [])],
    bankStatements: [],
    journalEntries: [booked],
    config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
}

/** The model books the credit note as the receipt rule says: no document with Swiss VAT, the zero code. */
const model = (account: string, code: string): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  const entries: ClassifyEntry[] = [{ accountDebit: '', accountCredit: account, amount: 408.6, vatCode: code, description: 'Farbenmarkt Gutschrift' }];
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Kein Beleg: Nullcode.' }])));
};

async function creditEntry(b: Books, account: string, code: string): Promise<JournalEntry> {
  const credit = b.transactions.find((t) => t.ref === 'C1')!;
  const { classified } = await classifyTransactions(b, [credit], { ask: model(account, code), fx, context });
  assert.deepEqual(classified, ['C1']);
  return b.journalEntries.find((e) => e.transactionRef === 'C1')!;
}

test('a credit note without its own PDF naming an M81 invoice is booked -M81, and its reason names the invoice', async () => {
  const e = await creditEntry(booksWith('4400', 'M81', pay('C1', 'Gutschrift GS-1207 zu FM-78230', 'CRDT', 408.6)), '4400', 'M0');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.by], ['1020', '4400', '-M81', { kind: 'code', check: 'creditNote' }]);
  assert.match(e.reason ?? '', /FM-78230/);
  assert.match(e.reason ?? '', /-M81/);
});

test('a credit note without its own PDF naming an I81 invoice is booked -I81, also when the model wrote -I0', async () => {
  const e = await creditEntry(booksWith('6570', 'I81', pay('C1', 'Gutschrift GS-1207 zu FM-78230', 'CRDT', 408.6)), '6570', '-I0');
  assert.equal(e.vatCode, '-I81');
  assert.match(e.reason ?? '', /FM-78230/);
});

test('a credit note naming nothing booked keeps the receipt rule\'s zero code and the model\'s reason', async () => {
  const e = await creditEntry(booksWith('4400', 'M81', pay('C1', 'Gutschrift GS-1207 Farbenmarkt', 'CRDT', 408.6)), '4400', '-M0');
  assert.deepEqual([e.vatCode, e.reason, e.by?.kind], ['-M0', 'Kein Beleg: Nullcode.', 'model']);
});

test('a credit note with its own document keeps the code its document gives, though it names the invoice', async () => {
  const e = await creditEntry(booksWith('4400', 'M81', pay('C1', 'Gutschrift GS-1207 zu FM-78230', 'CRDT', 408.6), true), '4400', '-M0');
  assert.equal(e.vatCode, '-M0');
});
