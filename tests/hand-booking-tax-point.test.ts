/**
 * A payment booked by hand on the agreed basis (#360): each coded line is dated by its receipt and
 * booked over the open item, as the classifier books it (atTaxPoint), with the same exceptions: a
 * receipt of a filed period leaves the line on the payment's day with `corrects`, one before the
 * year the basis began leaves it as it is. The cash basis is unchanged. The hand form says so.
 */
import './support/demo-workspace.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT, appFolderIn, MANIFEST_FILE, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../src/workspace/vat-setup.js';
import { attachEntries, bookPayment } from '../src/server/edits.js';
import { runBatch } from '../src/server/batch.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { bookedState } from '../src/accounting/payment-entries.js';
import { chfAmount } from '../src/accounting/ledger.js';
import type { Books } from '../src/books/store.js';
import type { FxResolver } from '../src/accounting/fx-rates.js';
import type { BankTransaction, JournalEntry, QuarterKey, Receipt } from '../src/types/index.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const RATES: Record<string, number> = { '2026-09-28': 0.94, '2026-10-05': 0.95 };
const FX: FxResolver = { daily: (c, d) => (c === 'EUR' ? RATES[d] : undefined), flat: () => undefined };
const ACCOUNTS: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', role: 'bank' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' },
];
const CHART = { chart: ['1021', '1023', '1100', '2000', '6500', '6960'], clearing: new Set<string>() };

const pay = (over: Partial<BankTransaction> = {}): BankTransaction => ({ ref: 'b1', bank: 'Raiffeisen', date: '2026-10-05', amount: 108.1, currency: 'CHF', direction: 'DBIT', counterparty: 'Swisscom AG', description: 'Swisscom', ...over } as BankTransaction);
const bill = (date: string): Receipt => ({ id: 'r1', filename: 'swisscom.pdf', date, amount: 108.1, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }], kind: 'invoice' } as Receipt);
const books = (closedThrough: string, tx: BankTransaction, r: Receipt): Books => ({ receipts: [r], transactions: [tx], mappings: [{ transactionRef: tx.ref, receiptId: r.id }], bankStatements: [], journalEntries: [], config: { closedThrough } } as unknown as Books);
const line = (over: Partial<{ accountCredit: string }> = {}) => [{ accountDebit: '6500', accountCredit: '1021', amount: 108.1, vatCode: 'I81', description: 'Swisscom', ...over }];
const rows = (es: JournalEntry[]) => es.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.corrects ?? '']);
const figures = (entries: JournalEntry[], key: QuarterKey) => Object.fromEntries(Object.entries(vat().figures(entries, key, []).ziffern).filter(([, v]) => v !== 0));
const balance = (entries: JournalEntry[], account: string) => Math.round(entries.reduce((s, e) => s + (e.accountDebit === account ? chfAmount(e) : 0) - (e.accountCredit === account ? chfAmount(e) : 0), 0) * 100) / 100;

test('agreed basis, a bill of the previous open quarter booked by hand: the line on the bill\'s day over 2000, the payment settles 2000 on its own day', () => {
  setJurisdiction(ch, AGREED);
  try {
    const b = books('2026-06-30', pay(), bill('2026-09-20'));
    const made = bookPayment(b, 'b1', line(), ACCOUNTS, FX, undefined, [], {}, CHART);
    assert.deepEqual(rows(made), [
      ['2026-09-20', '6500', '2000', 108.1, 'I81', ''],
      ['2026-10-05', '2000', '1021', 108.1, '', ''],
    ]);
    assert.ok(made.every((e) => e.origin === 'manual' && e.by?.kind === 'person' && e.transactionRef === 'b1'), 'every line is the person\'s');
    assert.deepEqual(rows(b.journalEntries), rows(made), 'what is returned is what is booked, for the undo');
    assert.equal(figures(b.journalEntries, '2026-Q3')['405'], 8.1, 'the input tax in Q3, the bill\'s quarter');
    assert.equal(figures(b.journalEntries, '2026-Q4')['405'], undefined, 'none in the payment\'s quarter');
    assert.equal(balance(b.journalEntries, '2000'), 0);
    assert.equal(bookedState(b, 'b1', ACCOUNTS), 'booked', 'the payment counts as booked');
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('agreed basis, a foreign bill booked by hand: the rate of the bill\'s day, the exchange difference to 6960', () => {
  setJurisdiction(ch, AGREED);
  try {
    const b = books('2026-06-30', pay({ bank: 'Wise', currency: 'EUR' }), { ...bill('2026-09-28'), currency: 'EUR' });
    const made = bookPayment(b, 'b1', line({ accountCredit: '1023' }), ACCOUNTS, FX, undefined, [], {}, CHART);
    assert.deepEqual(made.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.exchangeRate ?? '', chfAmount(e)]), [
      ['2026-09-28', '6500', '2000', 108.1, 0.94, 101.61],
      ['2026-10-05', '2000', '1023', 108.1, 0.95, 102.7],
      ['2026-10-05', '6960', '2000', 1.09, '', 1.09],
    ]);
    assert.equal(balance(made, '2000'), 0);
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('agreed basis, a bill of a filed quarter booked by hand: the line stays on the payment\'s day, declared in that quarter\'s correction; nothing lands in the filed quarter', () => {
  setJurisdiction(ch, AGREED);
  try {
    const b = books('2026-09-30', pay(), bill('2026-09-20'));
    const made = bookPayment(b, 'b1', line(), ACCOUNTS, FX, undefined, [], {}, CHART);
    assert.deepEqual(rows(made), [['2026-10-05', '6500', '1021', 108.1, 'I81', '2026-Q3']]);
    assert.ok(b.journalEntries.every((e) => e.date > '2026-09-30'));
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('agreed basis since 2026, a bill of the year before booked by hand: the line stays on the payment as it is (the switch)', () => {
  setJurisdiction(ch, { ...AGREED, reportingSince: 2026 });
  try {
    const b = books('2025-12-31', pay(), bill('2025-12-20'));
    assert.deepEqual(rows(bookPayment(b, 'b1', line(), ACCOUNTS, FX, undefined, [], {}, CHART)), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']]);
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('cash basis: a payment booked by hand keeps the payment\'s day, whatever its receipt\'s date', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  const b = books('2026-06-30', pay(), bill('2026-09-20'));
  assert.deepEqual(rows(bookPayment(b, 'b1', line(), ACCOUNTS, FX, undefined, [], {}, CHART)), [['2026-10-05', '6500', '1021', 108.1, 'I81', '']]);
});

test('the hand form says what the booking does: on the bill\'s day over 2000, or in the correction of a filed quarter; it proposes the account as on any day; nothing on the cash basis', () => {
  const precedent: JournalEntry = { id: 'p0', transactionRef: 'b0', date: '2026-07-02', accountDebit: '6500', accountCredit: '1021', amount: 90, vatCode: 'I81', description: 'Swisscom', origin: 'manual' };
  const withPrecedent = (closedThrough: string) => {
    const b = books(closedThrough, pay(), bill('2026-09-20'));
    return { ...b, transactions: [...b.transactions, pay({ ref: 'b0', date: '2026-07-02', amount: 90 })], journalEntries: [precedent] };
  };
  setJurisdiction(ch, AGREED);
  try {
    const open = bookingDraft(withPrecedent('2026-06-30'), 'b1', ACCOUNTS, [], { chart: CHART.chart })!;
    assert.deepEqual(open.notes.filter((n) => n.kind.startsWith('taxPoint')), [{ kind: 'taxPoint', date: '2026-09-20', account: '2000' }]);
    assert.deepEqual([open.lines[0].accountDebit, open.lines[0].accountCredit], ['6500', '1021'], 'the account is proposed: the booking dates it right');
    const filed = bookingDraft(withPrecedent('2026-09-30'), 'b1', ACCOUNTS, [], { chart: CHART.chart })!;
    assert.deepEqual(filed.notes.filter((n) => n.kind.startsWith('taxPoint')), [{ kind: 'taxPointCorrects', date: '2026-09-20', corrects: '2026-Q3' }]);
    const sameDay = bookingDraft(books('2026-06-30', pay(), bill('2026-10-05')), 'b1', ACCOUNTS, [], { chart: CHART.chart })!;
    assert.ok(!sameDay.notes.some((n) => n.kind.startsWith('taxPoint')), 'a bill of the payment\'s day moves nothing');
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
  const cash = bookingDraft(withPrecedent('2026-06-30'), 'b1', ACCOUNTS, [], { chart: CHART.chart })!;
  assert.ok(!cash.notes.some((n) => n.kind.startsWith('taxPoint')));
});

test('the route on an agreed-basis workspace: the hand line on its receipt\'s day over 2000, the payment settles it, all the person\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belege-agreed-hand-'));
  const manifest = readFileSync(join(appFolderIn(DEMO_ROOT) ?? DEMO_ROOT, MANIFEST_FILE), 'utf8');
  writeFileSync(join(dir, MANIFEST_FILE), manifest.replace('reporting: received', 'reporting: agreed'));
  const api = await startApi('tests/fixtures/classify-index.json', {}, { manifestOf: dir });
  try {
    assert.equal((await api.send('DELETE', '/api/journal-entries/jw')).status, 200);
    const { status, json } = await api.send('POST', '/api/transactions/W1/entries', { lines: [{ accountDebit: '4400', accountCredit: '1023', amount: 50, vatCode: 'M81', description: 'Shop EU, Material' }] });
    assert.equal(status, 200, String(json.error));
    const booked = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'W1');
    assert.deepEqual(booked.filter((e) => e.accountDebit !== '6960' && e.accountCredit !== '6960').sort((a, b) => a.date.localeCompare(b.date)).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']), [
      ['2026-08-12', '4400', '2000', 50, 'M81'],
      ['2026-08-14', '2000', '1023', 50, ''],
    ], 'the receipt of 12 August is the tax point; the card payment of 14 August settles the payable');
    assert.equal(balance(booked, '2000'), 0, 'an exchange difference between the two days goes to 6960');
    assert.ok(booked.every((e) => e.origin === 'manual' && e.by?.kind === 'person'));
    assert.equal((json.entries as unknown[]).length, booked.length, 'the answer names every line, for the undo');
  } finally {
    api.stop();
  }
});

test('agreed basis: a booking typed without its payment, tied to it, takes the tax point too; the undo learns the line it added', () => {
  setJurisdiction(ch, AGREED);
  try {
    const b = books('2026-06-30', pay(), bill('2026-09-20'));
    b.journalEntries.push({ id: 'typed', transactionRef: 'M2026-001', date: '2026-10-01', accountDebit: '6500', accountCredit: '1021', amount: 108.1, vatCode: 'I81', description: 'Swisscom', origin: 'manual' });
    const { before, made } = attachEntries(b, 'b1', 'M2026-001', ACCOUNTS, FX, CHART);
    assert.deepEqual(before.map((e) => [e.id, e.date, e.transactionRef]), [['typed', '2026-10-01', 'M2026-001']]);
    assert.deepEqual(rows(b.journalEntries), [
      ['2026-09-20', '6500', '2000', 108.1, 'I81', ''],
      ['2026-10-05', '2000', '1021', 108.1, '', ''],
    ]);
    assert.equal(b.journalEntries[0].id, 'typed', 'her line keeps its id');
    assert.deepEqual(made, [b.journalEntries[1].id]);
    assert.ok(b.journalEntries.every((e) => e.transactionRef === 'b1' && e.origin === 'manual'));
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('the form\'s note takes the side and the day from the proposed code: a supplier\'s credit note paid in goes over 2000, a customer\'s refund over 1100, each by the latest document; no known code, no note', () => {
  const twoDocs = (tx: BankTransaction): Books => {
    const b = books('2026-06-30', tx, bill('2026-09-20'));
    b.receipts.push({ ...bill('2026-09-25'), id: 'r2' });
    b.mappings.push({ transactionRef: tx.ref, receiptId: 'r2' });
    return b;
  };
  const rule = (account: string, vat: string) => ({ chart: CHART.chart, rule: { id: 'x', lines: [{ account, vat, amount: 108.1 }] } });
  setJurisdiction(ch, AGREED);
  try {
    const back = bookingDraft(twoDocs(pay({ direction: 'CRDT' })), 'b1', ACCOUNTS, [], rule('6500', '-I81'))!;
    assert.deepEqual(back.notes.filter((n) => n.kind.startsWith('taxPoint')), [{ kind: 'taxPoint', date: '2026-09-25', account: '2000' }]);
    const refund = bookingDraft(twoDocs(pay()), 'b1', ACCOUNTS, [], rule('3400', '-V81'))!;
    assert.deepEqual(refund.notes.filter((n) => n.kind.startsWith('taxPoint')), [{ kind: 'taxPoint', date: '2026-09-25', account: '1100' }]);
    const unknown = bookingDraft(twoDocs(pay()), 'b1', ACCOUNTS, [], { chart: CHART.chart })!;
    assert.ok(!unknown.notes.some((n) => n.kind.startsWith('taxPoint')), JSON.stringify(unknown.lines));
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

test('agreed basis: a batch booking books by the tax point and its preview says what it books', () => {
  setJurisdiction(ch, AGREED);
  try {
    const b = books('2026-06-30', pay(), bill('2026-09-20'));
    const run = runBatch(b, { kind: 'book', account: '6500', vat: 'I81' }, ['b1'], { bankAccounts: ACCOUNTS, fx: FX, point: CHART });
    assert.deepEqual(rows(b.journalEntries), [['2026-09-20', '6500', '2000', 108.1, 'I81', ''], ['2026-10-05', '2000', '1021', 108.1, '', '']]);
    assert.deepEqual(run.changes.map((c) => c.to), ['20.09.2026 6500 / 2000 I81 · 05.10.2026 2000 / 1021']);
  } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
});

/** The by-hand fixture on an agreed-basis copy of the demo's manifest, with her own invoice of 20 June linked to K1 (paid 4 August) and the lock at `closedThrough`. */
async function ownInvoiceOfJune(closedThrough: string) {
  const dir = mkdtempSync(join(tmpdir(), 'belege-agreed-sale-'));
  const manifest = readFileSync(join(appFolderIn(DEMO_ROOT) ?? DEMO_ROOT, MANIFEST_FILE), 'utf8');
  writeFileSync(join(dir, MANIFEST_FILE), manifest.replace('reporting: received', 'reporting: agreed'));
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: dir });
  const b = loadBooks(api.ws);
  const k1 = b.transactions.find((t) => t.ref === 'K1')!;
  for (const e of b.journalEntries.filter((x) => x.transactionRef === 'K1')) await api.send('DELETE', `/api/journal-entries/${e.id}`);
  const after = loadBooks(api.ws);
  const text = `${api.ws.company.name}\nMWST-Nr. ${api.ws.company.uid} MWST\nFamilie Bauer\nRechnung 2026-029\nTreppenhaus\nTotal CHF ${k1.amount}`;
  after.receipts.push({ id: 'own', filename: 'own.pdf', date: '2026-06-20', location: 'archived', extractedText: text, extractionMethod: 'pdftotext', kind: 'invoice', amount: k1.amount, currency: 'CHF' } as unknown as Receipt);
  after.mappings.push({ transactionRef: 'K1', receiptId: 'own' });
  after.config.closedThrough = closedThrough;
  saveBooks(api.ws, after);
  const bank = api.ws.bankAccounts.find((a) => a.bank === k1.bank)!.account;
  const sale = () => api.send('POST', '/api/transactions/K1/sale', { by: 'Anna', choice: 'saleDomestic', lines: [{ accountDebit: bank, accountCredit: '3400', amount: k1.amount, description: k1.description }], links: [] });
  const k1Rows = () => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'K1').sort((x, y) => x.date.localeCompare(y.date))
    .map((e) => [e.date, e.accountDebit === bank ? 'bank' : e.accountDebit, e.accountCredit === bank ? 'bank' : e.accountCredit, e.vatCode ?? '', e.corrects ?? '', e.origin]);
  return { api, sale, k1Rows };
}

test('the sale question answered on the hand form, agreed basis: her own invoice of an open Q2 dates the sale in Q2 over 1100, the payment of August settles it', async () => {
  const { api, sale, k1Rows } = await ownInvoiceOfJune('2026-03-31');
  try {
    const r = await sale();
    assert.equal(r.status, 200, String(r.json.error));
    assert.deepEqual(k1Rows(), [['2026-06-20', '1100', '3400', 'V81', '', 'manual'], ['2026-08-04', 'bank', '1100', '', '', 'manual']]);
  } finally { await api.stop(); }
});

test('the sale question answered on the hand form, agreed basis: her own invoice of a filed Q2 stays on the payment\'s day, declared in Q2\'s correction', async () => {
  const { api, sale, k1Rows } = await ownInvoiceOfJune('2026-06-30');
  try {
    const r = await sale();
    assert.equal(r.status, 200, String(r.json.error));
    assert.deepEqual(k1Rows(), [['2026-08-04', 'bank', '3400', 'V81', '2026-Q2', 'manual']]);
  } finally { await api.stop(); }
});
