/**
 * «Zahlung verknüpfen», the chip filter (#232, src/app/areas/receipts/link-filter.ts): a Konto chip
 * keeps the payments of that money account (two of them: either), chips of different fields all
 * hold, «Passt am besten» is ranked within the filter and the hidden best fit is counted, ⌥n toggles
 * the n-th account, and the Konto chips are remembered for the next receipt (Richtung and Betrag not).
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import { bookingsWithoutPayment, candidates, ledgerOf, type ToChf } from '../src/app/areas/receipts/model.js';
import { ACCOUNT, hiddenBest, linkFields, rememberAccounts, rememberedAccounts, rowOfTx, rowOfUnpaid, toggleAccount } from '../src/app/areas/receipts/link-filter.js';
import { chipTest, type Chip } from '../src/app/shell/chips.js';
import { wordsIn } from '../src/export/texts.js';

const flat: ToChf = (amount) => amount;
const accounts: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank Raiffeisen', role: 'bank' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Kontokorrent Inhaber', role: 'owner' },
];
const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-10-09T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number, x: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...x });

const books: Index = {
  config: {},
  receipts: [
    receipt('inv', { date: '2026-10-01', amount: 120, description: 'Druckerei, Flyer' }),
    receipt('other', { date: '2026-09-01', amount: 50 }),
  ],
  transactions: [
    tx('RB-120', '2026-10-02', 120, { description: 'Druckerei AG' }),
    tx('RB-80', '2026-10-05', 80),
    tx('RB-in', '2026-10-06', 300, { direction: 'CRDT' }),
    tx('WI-130', '2026-10-03', 130, { bank: 'Wise', currency: 'EUR' }),
    tx('MA-120', '2026-10-01', 120, { bank: 'manual' }),
    tx('RB-50', '2026-09-01', 50),
  ],
  mappings: [{ receiptId: 'other', transactionRef: 'RB-50' }],
  bankStatements: [],
};
const l = ledgerOf(books, '2026-10-01');
const v = l.byId.get('inv')!;
const fields = linkFields(accounts, l, { say: wordsIn('de').t as never, monthName: (d) => d });
const keep = (chips: Chip[]) => { const pass = chipTest(chips, fields); return (t: BankTransaction) => pass(rowOfTx(t)); };
const refs = (chips: Chip[]) => {
  const { best, more } = candidates(v, l, flat, '', keep(chips));
  return [...best, ...more].map((c) => c.tx.ref).sort();
};
const konto = (bank: string, currency = 'CHF'): Chip => ({ field: ACCOUNT, value: `${bank} ${currency}` });

test('a Konto chip keeps that money account\'s payments; two Konto chips keep either', () => {
  assert.deepEqual(refs([konto('Wise', 'EUR')]), ['WI-130']);
  assert.deepEqual(refs([konto('manual')]), ['MA-120'], 'the owner\'s account by its own row');
  assert.deepEqual(refs([konto('Wise', 'EUR'), konto('manual')]), ['MA-120', 'WI-130']);
});

test('chips of different fields all hold: Raiffeisen, Ausgang, over 100, Ab, without a receipt', () => {
  assert.deepEqual(refs([konto('Raiffeisen'), { field: 'way', value: 'out' }]), ['RB-120', 'RB-50', 'RB-80']);
  assert.deepEqual(refs([konto('Raiffeisen'), { field: 'way', value: 'out' }, { field: 'over', value: '100' }]), ['RB-120']);
  assert.deepEqual(refs([{ field: 'way', value: 'in' }]), ['RB-in']);
  assert.deepEqual(refs([konto('Raiffeisen'), { field: 'receipt', value: 'no' }]), ['RB-120', 'RB-80', 'RB-in'], 'RB-50 has a receipt');
  assert.deepEqual(refs([{ field: 'from', value: '2026-10-03' }, { field: 'to', value: '2026-10-05' }]), ['RB-80', 'WI-130']);
  assert.deepEqual(refs([{ field: 'amount', value: '120' }]), ['MA-120', 'RB-120']);
});

test('«Passt am besten» is ranked within the filter, and the best fit the filter hides is counted', () => {
  const all = candidates(v, l, flat).best.map((c) => c.tx.ref);
  assert.ok(all.includes('RB-120'), JSON.stringify(all));
  const chips = [konto('manual')];
  const filtered = candidates(v, l, flat, '', keep(chips)).best.map((c) => c.tx.ref);
  assert.deepEqual(filtered, ['MA-120'], 'the owner\'s outlay is the best fit among the owner\'s payments');
  const pass = chipTest(chips, fields);
  assert.equal(hiddenBest(v, l, flat, pass), all.filter((r) => r !== 'MA-120').length, 'every best fit outside the filter is counted');
  assert.equal(hiddenBest(v, l, flat, chipTest([], fields)), 0, 'without chips nothing is hidden');
});

test('a booking without a payment moved on no money account: an amount chip keeps it, a Konto or Richtung chip leaves it out', () => {
  const withBooking: Index = { ...books, journalEntries: [{ id: 'M1', transactionRef: 'M2026-001', date: '2026-10-04', amount: 120, accountDebit: '6000', accountCredit: '2451', description: 'Abgrenzung' } as never] };
  const lb = ledgerOf(withBooking, '2026-10-01');
  const vb = lb.byId.get('inv')!;
  const fb = linkFields(accounts, lb, { say: wordsIn('de').t as never, monthName: (d) => d });
  const unpaid = (chips: Chip[]) => { const pass = chipTest(chips, fb); return bookingsWithoutPayment(vb, lb, '', (u) => pass(rowOfUnpaid(u))).rows.map((u) => u.ref); };
  assert.deepEqual(bookingsWithoutPayment(vb, lb).rows.map((u) => u.ref), ['M2026-001'], 'the fixture has the booking');
  assert.deepEqual(unpaid([{ field: 'over', value: '100' }]), ['M2026-001']);
  assert.deepEqual(unpaid([konto('Raiffeisen')]), []);
  assert.deepEqual(unpaid([{ field: 'way', value: 'out' }]), []);
});

test('⌥n toggles the n-th money account; only the Konto chips are remembered for the next receipt', () => {
  const on = toggleAccount([], accounts, 2)!;
  assert.deepEqual(on, [konto('Wise', 'EUR')]);
  assert.deepEqual(toggleAccount(on, accounts, 2), [], 'the same key again turns it off');
  assert.equal(toggleAccount([], accounts, 7), undefined, 'no seventh account');
  rememberAccounts([konto('Wise', 'EUR'), { field: 'way', value: 'out' }, { field: 'over', value: '100' }]);
  assert.deepEqual(rememberedAccounts(), [konto('Wise', 'EUR')]);
  rememberAccounts([]);
  assert.deepEqual(rememberedAccounts(), []);
});
