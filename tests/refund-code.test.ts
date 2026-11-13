/**
 * A refund inverts the code of the purchase it refunds (AGENTS.md § VAT code rules, #288): money
 * back onto an asset account never claims input tax, a refund of a booked purchase of the same
 * merchant, account and amount takes that purchase's code with the minus whatever the model wrote,
 * and a credit note's code keeps the family of the account it credits.
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

const card = (ref: string, date: string, direction: 'DBIT' | 'CRDT', amount: number, merchant = 'Shopmax* Ab12cd34 BERLIN'): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction, description: `Card transaction of ${direction === 'CRDT' ? '-' : ''}${amount.toFixed(2)} CHF issued by ${merchant}` });

/** A purchase of 120.00 booked on `account` with `code`, and the refund R1 with its own document (no Swiss VAT shown). */
function books(account: string, code: string, refund: BankTransaction): Books {
  const purchase = card('P1', '2026-10-02', 'DBIT', 120);
  const booked: JournalEntry = { id: 'e1', transactionRef: 'P1', date: '2026-10-02', accountDebit: account, accountCredit: '1020', amount: 120, vatCode: code, description: 'Shopmax Kamera' };
  const note = { id: 'r1', filename: 'refund.pdf', extractedText: 'Shopmax refund for your order, amount CHF 120.00', hasSwissVat: false } as Receipt;
  return {
    transactions: [purchase, refund],
    receipts: [note],
    mappings: [{ transactionRef: refund.ref, receiptId: 'r1' }],
    bankStatements: [],
    journalEntries: [booked],
    config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
}

const model = (line: ClassifyEntry): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [line], reason: 'Rückerstattung.' }])));
};

async function booked(b: Books, line: ClassifyEntry): Promise<JournalEntry> {
  const refund = b.transactions.find((t) => t.direction === 'CRDT')!;
  const { classified } = await classifyTransactions(b, [refund], { ask: model(line), fx, context });
  assert.deepEqual(classified, [refund.ref]);
  return b.journalEntries.find((e) => e.transactionRef === refund.ref)!;
}

test('money back onto an asset account with a plain input-tax code books its minus', async () => {
  const b = books('1540', 'I81', card('R1', '2026-10-09', 'CRDT', 80));
  const e = await booked(b, { accountDebit: '', accountCredit: '1540', amount: 80, vatCode: 'I81', description: 'Teilgutschrift' });
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode], ['1020', '1540', '-I81']);
});

test('a refund of a booked I81 purchase on an asset account takes -I81, though the model wrote I0', async () => {
  const b = books('1540', 'I81', card('R1', '2026-10-09', 'CRDT', 120));
  const e = await booked(b, { accountDebit: '', accountCredit: '1540', amount: 120, vatCode: 'I0', description: 'Retoure Kamera' });
  assert.deepEqual([e.accountCredit, e.vatCode, e.by], ['1540', '-I81', { kind: 'code', check: 'creditNote' }]);
  assert.match(e.reason ?? '', /02\.10\.2026/);
  assert.match(e.reason ?? '', /-I81/);
});

test('a refund of a booked M81 purchase on an expense account takes -M81, though the model wrote -I0', async () => {
  const b = books('4200', 'M81', card('R1', '2026-10-09', 'CRDT', 120));
  const e = await booked(b, { accountDebit: '', accountCredit: '4200', amount: 120, vatCode: '-I0', description: 'Retoure Ware' });
  assert.equal(e.vatCode, '-M81');
});

test('a part of the purchase refunded takes its code with the minus, at its rate (#357)', async () => {
  const b = books('1540', 'I81', card('R1', '2026-10-09', 'CRDT', 30));
  const e = await booked(b, { accountDebit: '', accountCredit: '1540', amount: 30, vatCode: 'I0', description: 'Kulanz' });
  assert.equal(e.vatCode, '-I81');
});

test('more back than the purchase was is no refund of it: the zero code with its minus', async () => {
  const b = books('1540', 'I81', card('R1', '2026-10-09', 'CRDT', 150));
  const e = await booked(b, { accountDebit: '', accountCredit: '1540', amount: 150, vatCode: 'I0', description: 'Gutschrift' });
  assert.equal(e.vatCode, '-I0');
});

test('money from another merchant of the same amount is no refund of the purchase', async () => {
  const b = books('1540', 'I81', card('R1', '2026-10-09', 'CRDT', 120, 'Otherstore Zuerich'));
  const e = await booked(b, { accountDebit: '', accountCredit: '1540', amount: 120, vatCode: 'I0', description: 'Gutschrift' });
  assert.equal(e.vatCode, '-I0');
});

test('a credit note naming an I81 invoice, booked on a materials account, takes -M81 there', async () => {
  const invoice = { id: 'inv', filename: 'FM-78230.pdf', extractedText: 'Farbenmarkt AG Rechnung FM-78230 Total CHF 2000.00 MWST 8.1 %', hasSwissVat: true } as Receipt;
  const pay = (ref: string, description: string, direction: 'DBIT' | 'CRDT', amount: number): BankTransaction => ({ ref, bank: 'Raiffeisen', date: '2026-10-17', amount, currency: 'CHF', direction, description });
  const b = {
    transactions: [pay('P1', 'Farbenmarkt AG FM-78230', 'DBIT', 2000), pay('C1', 'Gutschrift GS-1207 zu FM-78230', 'CRDT', 408.6)],
    receipts: [invoice],
    mappings: [{ transactionRef: 'P1', receiptId: 'inv' }],
    bankStatements: [],
    journalEntries: [{ id: 'e1', transactionRef: 'P1', date: '2026-10-05', accountDebit: '6570', accountCredit: '1020', amount: 2000, vatCode: 'I81', description: 'Farbenmarkt FM-78230' }],
    config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  const e = await booked(b, { accountDebit: '', accountCredit: '4400', amount: 408.6, vatCode: 'M0', description: 'Farbenmarkt Gutschrift' });
  assert.deepEqual([e.accountCredit, e.vatCode], ['4400', '-M81']);
});
