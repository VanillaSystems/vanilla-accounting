/**
 * Bezugsteuer (MWSTG Art. 45, processes/booking.guide.yaml#purchase_vat pv-bezugsteuer) is applied
 * by code, not left to the model (issue #28): the model reads two facts off the receipt, whether the
 * line is a service, goods or an exempt service and where the supplier sits; code books a foreign
 * service whose receipts show no Swiss VAT and no Swiss UID with the acquisition code, and takes the
 * acquisition code back from a line whose facts say otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';

const jurisdiction = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
const fx = loadFxResolver();
const bankAccounts = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank' }];

const foreignInvoice = { id: 'r1', filename: 'wincher.pdf', extractedText: 'Wincher ApS, Copenhagen, Denmark. VAT DK12345678. Invoice. Total CHF 200.00. Reverse charge.', hasSwissVat: false, vatSummary: [] } as unknown as Receipt;
const swissVatInvoice = { id: 'r1', filename: 'saas.pdf', extractedText: 'Cloud Ltd, Dublin, Ireland. CHE-123.456.789 MWST. Total CHF 200.00 incl. 8.1% MWST 14.98', hasSwissVat: true, vatId: 'CHE-123.456.789', vatSummary: [{ ratePercent: 8.1, gross: 200, vat: 14.98 }] } as unknown as Receipt;
const swissUidNoVat = { id: 'r1', filename: 'shop.pdf', extractedText: 'Laden AG, Zürich. CHE-111.222.333. Total CHF 200.00, 0% MWST', hasSwissVat: false, vatId: 'CHE-111.222.333', vatSummary: [] } as unknown as Receipt;

const pay = (direction: 'DBIT' | 'CRDT' = 'DBIT'): BankTransaction =>
  ({ ref: 'P1', bank: 'Raiffeisen', date: '2026-10-17', amount: 200, currency: 'CHF', direction, description: 'Card payment' });

function books(tx: BankTransaction, receipt: Receipt | null): Books {
  return {
    transactions: [tx],
    receipts: receipt ? [receipt] : [],
    mappings: receipt ? [{ transactionRef: tx.ref, receiptId: receipt.id }] : [],
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
}

/** Books the payment with the jurisdiction set up as `setup`, the model answering `line` (the bank side left empty). */
async function booked(setup: VatSetup, line: Partial<ClassifyEntry>, receipt: Receipt | null = foreignInvoice, direction: 'DBIT' | 'CRDT' = 'DBIT'): Promise<JournalEntry> {
  setJurisdiction(jurisdiction, setup);
  try {
    const tx = pay(direction);
    const b = books(tx, receipt);
    const sides = direction === 'DBIT' ? { accountDebit: '6570', accountCredit: '' } : { accountDebit: '', accountCredit: '6570' };
    const entry = { ...sides, amount: 200, vatCode: 'I0', description: 'Wincher, Abo SEO', ...line } as ClassifyEntry;
    const context: ClassifyContext = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', vatCodes: '', bankAccounts, vat: setup };
    const ask = async () => JSON.stringify({ P1: { entries: [entry], reason: 'Beleg ohne Schweizer MWST: I0.' } });
    const { classified } = await classifyTransactions(b, [tx], { ask, fx, context });
    assert.deepEqual(classified, ['P1']);
    assert.equal(b.journalEntries.length, 1);
    return b.journalEntries[0];
  } finally {
    setJurisdiction(jurisdiction);
  }
}

const ziffern = (setup: VatSetup, e: JournalEntry) => {
  setJurisdiction(jurisdiction, setup);
  try {
    return vat().figures([e], setup.registered && setup.method === 'net-rate' ? '2026-H2' : '2026-Q4', []).ziffern;
  } finally {
    setJurisdiction(jurisdiction);
  }
};

test('effective method: a foreign service whose receipt shows no Swiss VAT is booked B81-1 though the model wrote I0, declared in 383 and deducted in 405', async () => {
  const e = await booked(EFFECTIVE_QUARTERLY, { supply: 'service', supplierCountry: 'DK' });
  assert.equal(e.vatCode, 'B81-1');
  assert.deepEqual(e.by, { kind: 'code', check: 'acquisitionTax' });
  assert.match(e.reason ?? '', /Bezugsteuer/);
  const z = ziffern(EFFECTIVE_QUARTERLY, e);
  assert.equal(z['383'], 200, 'the acquisition is declared at its net amount');
  assert.ok((z['405'] ?? 0) > 0, 'and its tax deducted again');
});

test('net tax rate method: the same service is booked B81-1, owed in 383 without a deduction', async () => {
  const e = await booked(NET_RATE, { vatCode: '', supply: 'service', supplierCountry: 'DK' });
  assert.equal(e.vatCode, 'B81-1');
  const z = ziffern(NET_RATE, e);
  assert.equal(z['383'], 200);
  assert.equal(z['405'] ?? 0, 0, 'the net-rate form has no input tax');
});

test('not registered: no code, even when the model wrote B81-1', async () => {
  const e = await booked(NOT_REGISTERED, { vatCode: 'B81-1', supply: 'service', supplierCountry: 'DK' });
  assert.equal(e.vatCode, undefined);
});

test('goods from abroad are no Bezugsteuer: the model\'s zero code stands, and its B81-1 becomes the zero code of the account', async () => {
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { accountDebit: '4400', vatCode: 'M0', supply: 'goods', supplierCountry: 'CN' })).vatCode, 'M0');
  const e = await booked(EFFECTIVE_QUARTERLY, { accountDebit: '4400', vatCode: 'B81-1', supply: 'goods', supplierCountry: 'CN' });
  assert.equal(e.vatCode, 'M0');
  assert.deepEqual(e.by, { kind: 'code', check: 'acquisitionTax' });
});

test('an exempt financial service from abroad (payment processing) is no Bezugsteuer', async () => {
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { accountDebit: '6840', supply: 'exempt', supplierCountry: 'US' })).vatCode, 'I0');
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { accountDebit: '6840', vatCode: 'B81-1', supply: 'exempt', supplierCountry: 'US' })).vatCode, 'I0');
});

test('a foreign vendor whose receipt shows Swiss VAT is I81, not B81: the model\'s I81 stands, its B81-1 becomes I81', async () => {
  const kept = await booked(EFFECTIVE_QUARTERLY, { vatCode: 'I81', supply: 'service', supplierCountry: 'IE' }, swissVatInvoice);
  assert.deepEqual([kept.vatCode, kept.by?.kind], ['I81', 'model']);
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { vatCode: 'B81-1', supply: 'service', supplierCountry: 'IE' }, swissVatInvoice)).vatCode, 'I81');
});

test('a supplier with a Swiss UID that charged no VAT is no Bezugsteuer (a UID alone is no proof of either)', async () => {
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { supply: 'service', supplierCountry: 'DK' }, swissUidNoVat)).vatCode, 'I0');
});

test('a domestic supplier without VAT (below the threshold) is no Bezugsteuer', async () => {
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { vatCode: 'B81-1', supply: 'service', supplierCountry: 'CH' })).vatCode, 'I0');
});

test('no receipt: the receipt gate stands, the model\'s I0 is kept', async () => {
  const e = await booked(EFFECTIVE_QUARTERLY, { supply: 'service', supplierCountry: 'DK' }, null);
  assert.deepEqual([e.vatCode, e.by?.kind], ['I0', 'model']);
});

test('a refund of a foreign service takes the acquisition code with the minus', async () => {
  const e = await booked(EFFECTIVE_QUARTERLY, { vatCode: '-I0', supply: 'service', supplierCountry: 'DK' }, foreignInvoice, 'CRDT');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode], ['1020', '6570', '-B81-1']);
});

test('without the facts the model\'s code stands: code decides only on what it was told', async () => {
  assert.equal((await booked(EFFECTIVE_QUARTERLY, {})).vatCode, 'I0');
  assert.equal((await booked(EFFECTIVE_QUARTERLY, { vatCode: 'B81-1' })).vatCode, 'B81-1');
});
