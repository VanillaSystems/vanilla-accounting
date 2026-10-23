/**
 * «Privat oder bar bezahlt» for a business part of a receipt (issue #87): the owner paid a receipt
 * privately and only a part of it was for the business (a coffee of EUR 17.99 on a bill of EUR
 * 70.57). The owner's payment is made for that part, the receipt linked, the booking books that
 * part on the owner's account with the VAT the receipt's facts give it, and the private rest is
 * never booked. The AI sidebar proposes the same as a change with its undo; a booking by hand that
 * books the receipt already refuses the payment, unless the person replaces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import { applyAnswer, applyChange, privatePayment } from '../src/server/edits.js';
import { RequestError } from '../src/server/books.js';
import { changesIn } from '../src/assistant/changes.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
/** The bank first: a payment of the owner in EUR is still booked on the owner's account, never on the manifest's first account. */
const bankAccounts: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', role: 'bank' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Kontokorrent Inhaber', role: 'owner' },
];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };
const DAY = '2026-08-12';

const cafe = (facts: Partial<Receipt> = {}): Receipt => ({
  id: 'cafe', filename: 'cafe.pdf', originalFilename: 'cafe.pdf', extractedText: 'Café Central Wien Rechnung Melange Kaffee Kuchen Mittagessen Summe EUR 70.57',
  extractionMethod: 'pdftotext', fileSize: 100, indexedAt: '2026-08-12T10:00:00Z', location: 'archived',
  date: DAY, amount: 70.57, currency: 'EUR', description: 'Café Central', hasSwissVat: false, ...facts,
} as Receipt);

function booksWith(receipt: Receipt, entries: JournalEntry[] = []): Books {
  return { transactions: [], receipts: [receipt], mappings: [], bankStatements: [], journalEntries: entries, config: { closedThrough: '2026-06-30' } } as unknown as Books;
}

/** The model books the payment's amount on 6500 and reads the receipt's VAT as `vat`; it records the prompt it was given. */
function model(vat: Pick<ClassifyEntry, 'vat' | 'vatRate'>, prompts: string[] = []): ClassifyDeps['ask'] {
  return async (prompt) => {
    prompts.push(prompt);
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    const amount = Number(/Amount: ([\d.]+)/.exec(prompt)![1]);
    const entries: ClassifyEntry[] = [{ accountDebit: '6500', accountCredit: '', amount, ...vat, description: 'Café Central, Kaffee' }];
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Kaffee mit Kunden.' }])));
  };
}

const refusal = (fn: () => unknown): { status: number; code?: string; params?: unknown } => {
  try { fn(); } catch (e) { if (e instanceof RequestError) return { status: e.status, code: e.refusal?.code, params: (e.refusal as { params?: unknown })?.params }; throw e; }
  assert.fail('not refused');
};

test('the owner\'s case: EUR 17.99 of a EUR 70.57 receipt without Swiss VAT is the owner\'s payment, linked; the booking is 6500 I0 against the owner\'s account at the ESTV rate of the receipt date, and nothing of the rest', async () => {
  const b = booksWith(cafe());
  const made = privatePayment(b, 'cafe', { amount: 17.99, part: 'Kaffee' }, fx);
  const rate = fx.daily('EUR', DAY)!;
  assert.equal(made.exchangeRate, rate, 'the outlay names the rate its booking takes');
  assert.equal(b.transactions.length, 1);
  const tx = b.transactions[0];
  assert.deepEqual([tx.bank, tx.date, tx.amount, tx.currency, tx.direction, tx.businessPart], ['manual', DAY, 17.99, 'EUR', 'DBIT', { what: 'Kaffee' }]);
  assert.match(tx.description, /Kaffee/);
  assert.deepEqual(b.mappings, [{ transactionRef: tx.ref, receiptId: 'cafe' }]);

  const prompts: string[] = [];
  const { classified } = await classifyTransactions(b, b.transactions, { ask: model({ vat: 'charged', vatRate: 8.1 }, prompts), fx, context });
  assert.deepEqual(classified, [tx.ref]);
  assert.match(prompts[0], /only 17\.99 EUR of the receipt's 70\.57 EUR/, 'the model is told it books the business part only');
  const entries = b.journalEntries.filter((e) => e.transactionRef === tx.ref);
  assert.deepEqual(entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.exchangeCurrency, e.exchangeRate]), [['6500', '2451', 17.99, 'I0', 'EUR', rate]],
    'one booking of the part, I0 though the model read 8.1 %: the receipt shows no Swiss VAT');
  assert.equal(b.journalEntries.length, 1, 'the private rest is never booked');
});

test('the whole amount stays the default: no amount, the payment is the receipt\'s total and names no part', () => {
  const b = booksWith(cafe());
  privatePayment(b, 'cafe', {}, fx);
  assert.deepEqual([b.transactions[0].amount, b.transactions[0].businessPart, b.transactions[0].description], [70.57, undefined, 'Café Central']);
});

test('the receipt\'s total as the amount is the whole receipt, not a part', () => {
  const b = booksWith(cafe());
  privatePayment(b, 'cafe', { amount: 70.57 }, fx);
  assert.equal(b.transactions[0].businessPart, undefined);
});

test('a part above the receipt\'s total, of zero or below is refused, nothing written', () => {
  for (const amount of [70.58, 0, -5, Number.NaN]) {
    const b = booksWith(cafe());
    assert.deepEqual(refusal(() => privatePayment(b, 'cafe', { amount }, fx)), { status: 400, code: 'partAmount', params: { total: 70.57, currency: 'EUR' } }, String(amount));
    assert.deepEqual([b.transactions.length, b.mappings.length], [0, 0]);
  }
});

test('a receipt with one Swiss rate: the part takes that rate, also when the model read none', async () => {
  const b = booksWith(cafe({ currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 70.57, vat: 5.29 }] }));
  const { ref } = privatePayment(b, 'cafe', { amount: 17.99, part: 'Kaffee' }, fx);
  await classifyTransactions(b, b.transactions, { ask: model({ vat: 'none' }), fx, context });
  const [e] = b.journalEntries.filter((x) => x.transactionRef === ref);
  assert.deepEqual([e.amount, e.vatCode, e.accountCredit], [17.99, 'I81', '2451']);
});

test('a receipt with one Swiss rate beside untaxed items: code does not give the part that rate, the model\'s facts stand', async () => {
  const b = booksWith(cafe({ currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 40, vat: 3 }] }));
  const { ref } = privatePayment(b, 'cafe', { amount: 17.99, part: 'Briefmarken' }, fx);
  await classifyTransactions(b, b.transactions, { ask: model({ vat: 'none' }), fx, context });
  assert.equal(b.journalEntries.find((x) => x.transactionRef === ref)!.vatCode, 'I0');
});

test('a receipt with several Swiss rates: the part needs the rate line it falls under; with it, that rate is booked', async () => {
  const mixed = { currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 2.6, gross: 30.57, vat: 0.77 }, { ratePercent: 8.1, gross: 40, vat: 3 }] };
  const asked = booksWith(cafe(mixed));
  assert.deepEqual(refusal(() => privatePayment(asked, 'cafe', { amount: 17.99, part: 'Kaffee' }, fx)), { status: 400, code: 'partRate', params: { rates: [2.6, 8.1] } });
  assert.deepEqual(refusal(() => privatePayment(asked, 'cafe', { amount: 17.99, rate: 3.8 }, fx)), { status: 400, code: 'partRate', params: { rates: [2.6, 8.1] } });
  const b = booksWith(cafe(mixed));
  const { ref } = privatePayment(b, 'cafe', { amount: 17.99, part: 'Kaffee', rate: 2.6 }, fx);
  assert.deepEqual(b.transactions[0].businessPart, { what: 'Kaffee', rate: 2.6 });
  await classifyTransactions(b, b.transactions, { ask: model({ vat: 'charged', vatRate: 8.1 }), fx, context });
  assert.equal(b.journalEntries.find((x) => x.transactionRef === ref)!.vatCode, 'I26');
});

/** The owner's own booking by hand of the coffee, made before (by the AI sidebar, without the receipt): in CHF at the day's rate. */
const byHand = (amount: number, date = DAY, description = 'Kaffee Café Central'): JournalEntry =>
  ({ id: 'hand1', transactionRef: 'M2026-063', date, accountDebit: '6500', accountCredit: '2451', amount, description, origin: 'manual', by: { kind: 'assistant', at: '2026-10-23T09:00:00Z', conversation: 'c0' } });

test('a booking by hand of the same part (in CHF at the day\'s rate) refuses the private payment, naming it; with replace it goes in the same write', () => {
  const chf = Math.round(17.99 * fx.daily('EUR', DAY)! * 100) / 100;
  const b = booksWith(cafe(), [byHand(chf)]);
  assert.deepEqual(refusal(() => privatePayment(b, 'cafe', { amount: 17.99, part: 'Kaffee' }, fx)), { status: 409, code: 'bookedByHand', params: { entry: 'M2026-063', date: DAY, amount: chf, currency: 'CHF', replaceable: true } });
  assert.deepEqual([b.transactions.length, b.journalEntries.length], [0, 1], 'nothing written');

  const made = privatePayment(b, 'cafe', { amount: 17.99, part: 'Kaffee', replace: 'M2026-063' }, fx);
  assert.deepEqual(made.replaced?.map((e) => e.id), ['hand1']);
  assert.equal(made.ref, 'M2026-064', 'a number of its own, after the booking it replaced: no ref is reused in one write');
  assert.deepEqual([b.transactions.length, b.journalEntries.length], [1, 0], 'the booking by hand gave way to the payment');
});

test('the guard knows the receipt\'s whole amount too, and a booking of the same amount in the receipt\'s currency on another day with the same words', () => {
  const whole = booksWith(cafe(), [{ ...byHand(70.57, '2026-08-14', 'Café Central'), exchangeCurrency: 'EUR', exchangeRate: 0.95 }]);
  assert.equal(refusal(() => privatePayment(whole, 'cafe', { amount: 17.99 }, fx)).code, 'bookedByHand');
});

test('a booking by hand of the same day and amount that does not name the receipt holds the payment but is never replaced: it may be another purchase', () => {
  const chf = Math.round(17.99 * fx.daily('EUR', DAY)! * 100) / 100;
  const b = booksWith(cafe(), [byHand(chf, DAY, 'Bürobedarf Papeterie')]);
  const held = refusal(() => privatePayment(b, 'cafe', { amount: 17.99 }, fx));
  assert.deepEqual([held.code, (held.params as { replaceable: boolean }).replaceable], ['bookedByHand', false]);
  assert.equal(refusal(() => privatePayment(b, 'cafe', { amount: 17.99, replace: 'M2026-063' }, fx)).code, 'bookedByHand');
  assert.deepEqual([b.transactions.length, b.journalEntries.length], [0, 1], 'nothing deleted');
});

test('replace deletes only the booking found to book this receipt: another booking by hand named as replace is refused, nothing written', () => {
  const b = booksWith(cafe(), [byHand(55)]);
  assert.equal(refusal(() => privatePayment(b, 'cafe', { amount: 17.99, replace: 'M2026-063' }, fx)).status, 400);
  assert.deepEqual([b.transactions.length, b.journalEntries.length], [0, 1]);
});

test('a booking by hand of another amount, or of the same amount on another day with other words, does not hold the payment', () => {
  privatePayment(booksWith(cafe(), [byHand(55)]), 'cafe', { amount: 17.99 }, fx);
  privatePayment(booksWith(cafe(), [byHand(17.99, '2026-08-20', 'Bürobedarf')]), 'cafe', { amount: 17.99 }, fx);
});

test('the AI sidebar\'s change: privatePayment pays the part and links it; its undo deletes the payment and puts back the booking it replaced; the undo of the undo pays again', () => {
  const [asked] = changesIn('```vanilla-changes\n[{"kind":"privatePayment","receipt":"cafe","amount":17.99,"part":"Kaffee","replace":"M2026-063"}]\n```');
  assert.deepEqual(asked, { kind: 'privatePayment', receipt: 'cafe', amount: 17.99, part: 'Kaffee', replace: 'M2026-063' });
  const chf = Math.round(17.99 * fx.daily('EUR', DAY)! * 100) / 100;
  const b = booksWith(cafe(), [byHand(chf)]);
  const [made] = applyAnswer(b, [asked as Extract<typeof asked, { kind: 'privatePayment' }>], { bankAccounts, chart: new Set(), earlier: [], conversation: 'c1' });
  const ref = b.transactions[0].ref;
  assert.deepEqual([b.transactions[0].amount, b.mappings, b.journalEntries.length], [17.99, [{ transactionRef: ref, receiptId: 'cafe' }], 0]);
  assert.equal(made.undo?.kind, 'deletePayment');

  const redo = applyChange(b, made.undo!);
  assert.deepEqual([b.transactions.length, b.mappings.length, b.journalEntries.map((e) => e.id)], [0, 0, ['hand1']], 'payment and link gone, the booking by hand back');
  assert.deepEqual(redo, { kind: 'privatePayment', receipt: 'cafe', amount: 17.99, part: 'Kaffee', replace: 'M2026-063' });
  applyChange(b, redo!);
  assert.deepEqual([b.transactions[0].amount, b.journalEntries.length], [17.99, 0]);
});

test('#90: the AI cannot link a receipt paid privately to the bank payment that pays the owner back', () => {
  const b = booksWith(cafe());
  b.transactions.push({ ref: 'B1', bank: 'Raiffeisen', date: '2026-08-31', amount: 70.57, currency: 'CHF', direction: 'DBIT', description: 'Spesen Inhaber August' });
  privatePayment(b, 'cafe', { amount: 17.99 }, fx);
  assert.throws(() => applyAnswer(b, [{ kind: 'link', receipt: 'cafe', payment: 'B1' }], { bankAccounts, chart: new Set(), earlier: [], conversation: 'c1' }),
    (e: unknown) => e instanceof RequestError && e.refusal?.code === 'paidPrivately');
  assert.equal(b.mappings.length, 1);
});

test('an answer cannot delete a payment itself: deletePayment is the undo\'s alone', () => {
  assert.throws(() => changesIn('```vanilla-changes\n[{"kind":"deletePayment","ref":"M2026-001","receipt":"cafe"}]\n```'), /unbekannte Änderung/);
  assert.throws(() => changesIn('```vanilla-changes\n[{"kind":"privatePayment","receipt":"cafe","amount":"viel"}]\n```'), /amount/);
});
