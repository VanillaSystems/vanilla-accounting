/**
 * A card's settlement split by its statement's lines (#409): a line with its own bill linked takes
 * that bill's VAT (a rate only when the bill shows Swiss VAT, Bezugsteuer for a foreign service), the
 * lines without one the zero code, as before; with no bill linked to a line the settlement is booked
 * as before, the statement its one receipt.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { journalOf } from '../src/app/areas/journal/model.js';
import type { Index } from '../src/types/index.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, CardLine, Mapping, Receipt } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';

const fx = loadFxResolver();
const bankAccounts: LedgerBankAccount[] = [{ bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };

const LINES: CardLine[] = [
  { day: '2026-08-07', merchant: 'LINKLY ADS DUBLIN IE', amount: 146.62, currency: 'CHF', original: { amount: 180, currency: 'USD' } },
  { day: '2026-08-07', merchant: 'Bearbeitungsgebühr Fremdwährung 1.75%', amount: 2.57, currency: 'CHF' },
  { day: '2026-08-19', merchant: 'HOTEL PILATUSBLICK LUZERN', amount: 164, currency: 'CHF' },
];
const tx: BankTransaction = { ref: 'P-30', bank: 'ZKB', date: '2026-09-10', amount: 313.19, currency: 'CHF', direction: 'DBIT', description: 'Kartenabrechnung August 2026 LSV', counterparty: 'Alpencard AG' };
const r = (id: string, x: Partial<Receipt>): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `${id}: ein Beleg mit genug Text`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-09-12', location: 'archived', ...x });

function books(mappings: Mapping[], hotelVat = true): Books {
  return {
    transactions: [tx],
    receipts: [
      r('card', { date: '2026-08-31', amount: 313.19, currency: 'CHF', hasSwissVat: false, cardLines: LINES }),
      r('hotel', { date: '2026-08-19', amount: 164, currency: 'CHF', ...(hotelVat ? { hasSwissVat: true, vatSummary: [{ ratePercent: 3.8, vat: 5.78, gross: 158 }, { ratePercent: 0, vat: 0, gross: 6 }] } : { hasSwissVat: false }) }),
      r('linkly', { date: '2026-08-07', amount: 180, currency: 'USD', hasSwissVat: false }),
    ],
    mappings,
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}
const card: Mapping = { transactionRef: tx.ref, receiptId: 'card' };
const lined = (receiptId: string, line: number): Mapping => ({ transactionRef: tx.ref, receiptId, by: 'rule', rule: 'card-line', line });

/** The model answers each key the prompt asks with `answers[key]`; the keys it was asked come back too. */
async function run(b: Books, answers: Record<string, ClassifyEntry[]>) {
  const asked: string[] = [];
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const keys = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    asked.push(...keys);
    return JSON.stringify(Object.fromEntries(keys.map((k) => [k, { entries: answers[k] }])));
  };
  const outcome = await classifyTransactions(b, b.transactions, { ask, fx, context });
  return { asked: asked.sort(), outcome, lines: b.journalEntries.map((e) => [e.accountDebit, e.amount, e.vatCode ?? '']) };
}
const line = (accountDebit: string, amount: number, e: Partial<ClassifyEntry>): ClassifyEntry => ({ accountDebit, accountCredit: '', amount, description: 'Karte', ...e });

test('a line with its bill takes the bill\'s VAT; a foreign service without Swiss VAT Bezugsteuer; the card fee no code', async () => {
  const { asked, outcome, lines } = await run(books([card, lined('linkly', 0), lined('hotel', 2)]), {
    'P-30#1': [line('6570', 146.62, { vat: 'acquisition' })],
    'P-30#3': [line('6640', 158, { vat: 'charged', vatRate: 3.8 }), line('6640', 6, { vat: 'none' })],
    'P-30': [line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(asked, ['P-30', 'P-30#1', 'P-30#3'], 'each line with a bill on its own, the rest together');
  assert.deepEqual(lines.sort(), [['6570', 146.62, 'B81-1'], ['6640', 158, 'I38'], ['6640', 6, 'I0'], ['6940', 2.57, '']].sort());
});

test('a line\'s bill without Swiss VAT: the line takes no rate, whatever the model says', async () => {
  const { lines } = await run(books([card, lined('hotel', 2)], false), {
    'P-30#3': [line('6640', 164, { vat: 'charged', vatRate: 3.8 })],
    'P-30': [line('6570', 146.62, { vat: 'acquisition' }), line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(lines.find((l) => l[0] === '6640'), ['6640', 164, 'I0']);
});

test('a line without its bill does not take the VAT of another line\'s bill', async () => {
  const { lines } = await run(books([card, lined('hotel', 2)]), {
    'P-30#3': [line('6640', 164, { vat: 'charged', vatRate: 3.8 })],
    'P-30': [line('6570', 146.62, { vat: 'charged', vatRate: 3.8 }), line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(lines.find((l) => l[0] === '6570'), ['6570', 146.62, 'I0']);
});

test('no bill linked to a line: the settlement goes to the model whole, its statement the one receipt, as before', async () => {
  const { asked, lines } = await run(books([card]), {
    'P-30': [line('6570', 146.62, { vat: 'acquisition' }), line('6940', 2.57, { vat: 'none' }), line('6640', 164, { vat: 'none' })],
  });
  assert.deepEqual(asked, ['P-30']);
  assert.equal(lines.length, 3);
});

test('a booking of the whole settlement is not told its bill of one line shows VAT; the booking of that line is', () => {
  const entry = (id: string, amount: number) => ({ id, transactionRef: tx.ref, date: tx.date, accountDebit: '6640', accountCredit: '1020', amount, vatCode: 'I0', origin: 'manual' as const });
  const whole = { ...books([card, lined('hotel', 2)]), journalEntries: [entry('w', 313.19)] } as unknown as Index;
  assert.equal(journalOf(whole).views[0].evidence, undefined);
  const split = { ...books([card, lined('hotel', 2)]), journalEntries: [entry('a', 146.62), entry('b', 2.57), entry('c', 164)] } as unknown as Index;
  assert.deepEqual(journalOf(split).views.map((v) => v.evidence?.kind), [undefined, undefined, 'receiptGroups']);
});

test('by hand: the form for the whole settlement proposes no rate from a bill of one line', () => {
  const draft = bookingDraft(books([card, lined('hotel', 2)]), tx.ref, bankAccounts)!;
  assert.ok(draft.lines.every((l) => !l.vat || !/38|3\.8/.test(l.vat)), `proposed ${draft.lines.map((l) => l.vat).join(', ')}`);
});
