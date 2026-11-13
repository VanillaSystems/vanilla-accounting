/**
 * Over-claims of input tax (#469): a line booked at a rate above the one its receipt shows, and a
 * rate on more than the receipt taxes. The evidence check tells both as a fact on the entry, with
 * the receipt's own figures, and «Nach Beleg buchen» books the receipt's rate on its taxed amount,
 * the rest at the zero code; the app's own runs (a rule, the model) never book such a line where the
 * receipt's VAT is known (capAtReceipts). An under-claim and a line without a receipt stay as
 * before. Synthetic suppliers and amounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { capAtReceipts } from '../src/booking/purchase-vat.js';
import { parseRule, type RuleFacts } from '../src/booking/rules.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { bookByReceipt } from '../src/server/edits.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';

const bill = (id: string, amount: number | undefined, vatSummary: Receipt['vatSummary'], over: Partial<Receipt> = {}) =>
  ({ id, filename: `${id}.pdf`, ...(amount !== undefined && { amount }), currency: 'CHF', hasSwissVat: true, vatSummary, ...over } as Receipt);
/** 783 net at 8.1 % (tax 63.42) and 240 the bill names no tax for: the reader read the one group. */
const partly = bill('part', 1086.42, [{ ratePercent: 8.1, net: 783, vat: 63.42 }]);
/** A bill wholly at 2.6 %. */
const reduced = bill('red', 102.6, [{ ratePercent: 2.6, net: 100, vat: 2.6, gross: 102.6 }]);
/** A bill of 100 at 8.1 % paid with 120 (a tip on the card). */
const tipped = bill('tip', 100, [{ ratePercent: 8.1, gross: 100, vat: 7.49 }]);

const line = (id: string, amount: number, vatCode: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: 'T', date: '2026-10-20', accountDebit: '6500', accountCredit: '1020', amount, vatCode, origin: 'classify', by: { kind: 'model', model: 'sonnet' }, ...over });
const check = (lines: JournalEntry[], receipts: Receipt[]) => lines.map((e) => evidenceCheck(e, receipts, '2026-09-30', undefined, lines));

// ─── The evidence check ─────────────────────────────────────────────────────────────────────────

test('a rate above the receipt\'s: I81 on a bill wholly at 2.6 % is told, and the click books the bill\'s 2.6 %', () => {
  assert.deepEqual(check([line('a', 102.6, 'I81')], [reduced])[0], { kind: 'receiptGroups', rate: 2.6, amount: 102.6, currency: 'CHF', lines: [{ amount: 102.6, code: 'I26' }], entries: ['a'], receipts: ['red'] });
  assert.equal(check([line('a', 102.6, 'I26')], [reduced])[0], undefined, 'at the bill\'s rate it fits');
});

test('a rate on more than the receipt taxes: I81 on all of 1086.42 where the bill\'s tax 63.42 covers 846.42 is told, the click books 846.42 at 8.1 % and the rest at 0', () => {
  const c = check([line('w', 1086.42, 'I81')], [partly])[0];
  assert.deepEqual(c, { kind: 'receiptGroups', rate: 8.1, amount: 846.42, booked: 1086.42, currency: 'CHF', lines: [{ amount: 846.42, code: 'I81' }, { amount: 240, code: 'I0' }], entries: ['w'], receipts: ['part'] });
  // Split on two lines, the 8.1 % one still too large: the finding sits on it, and the click books the bill's figures on both.
  const two = check([line('a', 1000, 'I81'), line('b', 86.42, 'I0')], [partly]);
  assert.deepEqual(two[0] && { ...two[0], lines: (two[0] as { lines?: unknown }).lines }, { kind: 'receiptGroups', rate: 8.1, amount: 846.42, booked: 1000, currency: 'CHF', lines: [{ amount: 846.42, code: 'I81' }, { amount: 240, code: 'I0' }], entries: ['a', 'b'], receipts: ['part'] });
  assert.equal(two[1], undefined);
  // Booked as the bill shows: no finding.
  assert.deepEqual(check([line('a', 846.42, 'I81'), line('b', 240, 'I0')], [partly]), [undefined, undefined]);
});

test('a rate on more than the receipt taxes, without a rest of the total: a bill of 100 at 8.1 % paid with 120 at I81', () => {
  assert.deepEqual(check([line('w', 120, 'I81')], [tipped])[0], { kind: 'receiptGroups', rate: 8.1, amount: 100, booked: 120, currency: 'CHF', lines: [{ amount: 100, code: 'I81' }, { amount: 20, code: 'I0' }], entries: ['w'], receipts: ['tip'] });
});

test('a zero line alone on a bill that names its tax only, without a total: the rate is offered only on what the tax covers', () => {
  const taxOnly = bill('t', undefined, [{ ratePercent: 8.1, vat: 7.49 }]);
  assert.deepEqual(check([line('z', 120, 'I0')], [taxOnly])[0], { kind: 'receiptGroups', rate: 8.1, amount: 99.96, currency: 'CHF', lines: [{ amount: 99.96, code: 'I81' }, { amount: 20.04, code: 'I0' }], entries: ['z'], receipts: ['t'] });
  assert.deepEqual(check([line('z', 99.96, 'I0')], [taxOnly])[0], { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['t'] }, 'covered whole: the rate on the whole line, as before');
});

test('an under-claim stays as the rule says: the zero code on a bill at 8.1 % is told the bill\'s rate, and a rate below the bill\'s is no finding', () => {
  const whole = bill('w', 108.1, [{ ratePercent: 8.1, gross: 108.1, vat: 8.1 }]);
  assert.deepEqual(check([line('a', 108.1, 'I0')], [whole])[0], { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['w'] });
  assert.equal(check([line('a', 108.1, 'I26')], [whole])[0], undefined, 'less input tax than the bill shows claims nothing it does not prove');
});

test('a line without a receipt is unchanged: a rate is told it has no receipt, the zero code nothing', () => {
  assert.deepEqual(check([line('a', 120, 'I81')], [])[0], { kind: 'vatWithoutReceipt', code: 'I0' });
  assert.equal(check([line('a', 120, 'I0')], [])[0], undefined);
});

test('«Nach Beleg buchen» on an over-claim books the receipt\'s rate on its taxed amount and the rest at the zero code, never more input tax', () => {
  const tx: BankTransaction = { ref: 'T', bank: 'ZKB', date: '2026-10-20', amount: 1086.42, currency: 'CHF', direction: 'DBIT', description: 'Post CH AG' };
  const books = {
    transactions: [tx], receipts: [partly], mappings: [{ transactionRef: 'T', receiptId: 'part' }], bankStatements: [],
    journalEntries: [line('w', 1086.42, 'I81')], config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  bookByReceipt(books, 'w');
  assert.deepEqual(books.journalEntries.map((e) => [e.amount, e.vatCode]).sort(), [[240, 'I0'], [846.42, 'I81']]);
  assert.deepEqual(books.journalEntries.map((e) => evidenceCheck(e, [partly], '2026-09-30', undefined, books.journalEntries)), [undefined, undefined], 'the booking now fits its bill');
});

// ─── #493 review: a hotel bill of a room at 3.8 % and a Kurtaxe without VAT ─────────────────────

/** The bill as the reader read it in the consultancy's round 7: the room's group, and «0 %» without an amount for the Kurtaxe. */
const hotelRead = bill('hotel', 164, [{ ratePercent: 3.8, vat: 5.78, gross: 158 }, { ratePercent: 0, vat: 0 }]);
const room = (vatCode: string, amount = 158) => line('room', amount, vatCode, { accountDebit: '6640' });
const kurtaxe = (vatCode: string) => line('kurtaxe', 6, vatCode, { accountDebit: '6640' });

test('#493 review: the hotel bill as read in round 7, room I38 and Kurtaxe I0: no finding, so no click books the Kurtaxe at 3.8 %', () => {
  assert.deepEqual(check([room('I38'), kurtaxe('I0')], [hotelRead]), [undefined, undefined]);
  assert.deepEqual(check([room('I38', 164)], [hotelRead])[0], { kind: 'receiptGroups', rate: 3.8, amount: 158, booked: 164, currency: 'CHF', lines: [{ amount: 158, code: 'I38' }, { amount: 6, code: 'I0' }], entries: ['room'], receipts: ['hotel'] }, 'the whole bill at 3.8 %');
  assert.deepEqual(check([room('I38'), kurtaxe('I38')], [hotelRead])[0], { kind: 'receiptGroups', rate: 3.8, amount: 158, booked: 164, currency: 'CHF', lines: [{ amount: 158, code: 'I38' }, { amount: 6, code: 'I0' }], entries: ['room', 'kurtaxe'], receipts: ['hotel'] }, 'the Kurtaxe at 3.8 %');
});

test('#493 review: a gross read above what the tax proves (the total, a net of 164) never offers 3.8 % on the Kurtaxe; 164 at I38 is told', () => {
  for (const [what, group] of [['gross 164', { ratePercent: 3.8, vat: 5.78, gross: 164 }], ['net 164', { ratePercent: 3.8, vat: 5.78, net: 164 }]] as const) {
    const misread = bill('hotel', 164, [group]);
    assert.deepEqual(check([room('I38'), kurtaxe('I0')], [misread]), [undefined, undefined], what);
    const whole = check([room('I38', 164)], [misread])[0];
    assert.deepEqual(whole && { ...whole }, { kind: 'receiptGroups', rate: 3.8, amount: 157.89, booked: 164, currency: 'CHF', lines: [{ amount: 157.89, code: 'I38' }, { amount: 6.11, code: 'I0' }], entries: ['room'], receipts: ['hotel'] }, `${what}: 5.78 proves 157.89`);
  }
  // The tax not read: the group proves no amount, the zero line beside the room is not told.
  assert.deepEqual(check([room('I38'), kurtaxe('I0')], [bill('hotel', 164, [{ ratePercent: 3.8, vat: 0, gross: 164 }])]), [undefined, undefined], 'vat 0');
});

test('#493 re-review: a tax printed 1 or 2 Rappen low on a whole bill is no over-claim: no finding, no cap', () => {
  let n = 0;
  const id = () => `r${++n}`;
  for (const [what, r, code] of [
    ['108.10 at 8.1 %, tax 8.09', bill('a', 108.1, [{ ratePercent: 8.1, gross: 108.1, vat: 8.09 }]), 'I81'],
    ['102.60 at 2.6 %, tax 2.59', bill('a', 102.6, [{ ratePercent: 2.6, gross: 102.6, vat: 2.59 }]), 'I26'],
    ['47.35 at 2.6 %, tax 1.18', bill('a', 47.35, [{ ratePercent: 2.6, gross: 47.35, vat: 1.18 }]), 'I26'],
    ['net 100, tax 8.09', bill('a', 108.09, [{ ratePercent: 8.1, net: 100, vat: 8.09 }]), 'I81'],
  ] as const) {
    const whole = [line('w', r.amount!, code)];
    assert.deepEqual(check(whole, [r]), [undefined], what);
    assert.equal(capAtReceipts(whole, [r], id), whole, what);
  }
});

test('#493 re-review: a group read above its tax counts with the tax\'s rounding, and the cap and the check measure it alike', () => {
  const noTotal = bill('hotel', undefined, [{ ratePercent: 3.8, vat: 5.78, gross: 164 }]);
  assert.deepEqual(check([room('I38'), kurtaxe('I0')], [noTotal]), [undefined, undefined], 'without a total: 158 I38 + 6 I0 fit');
  const misread = bill('hotel', 164, [{ ratePercent: 3.8, vat: 5.78, gross: 164 }]);
  let n = 0;
  const capped = capAtReceipts([room('I38', 164)], [misread], () => `c${++n}`);
  assert.deepEqual(capped.map((e) => [e.amount, e.vatCode]), [[157.89, 'I38'], [6.11, 'I0']]);
  assert.deepEqual(check(capped, [misread]), [undefined, undefined], 'what the cap books, the check finds fitting');
});

test('#493 re-review: a credit line at the bill\'s rate offsets the claim; one at a rate the bill does not show opens no room', () => {
  assert.deepEqual(check([line('a', 120, 'I81'), line('b', -20, '-I81')], [tipped]), [undefined, undefined], '120 less 20 on a bill of 100');
  assert.equal(check([line('a', 120, 'I81'), line('b', -10, '-I81')], [tipped])[0]?.kind, 'receiptGroups', '120 less 10 still claims beyond');
  const parts = capAtReceipts([line('a', 100, 'I26'), line('b', -20, '-I26')], [tipped], () => 'm1').map((e) => [e.id, e.amount, e.vatCode]);
  assert.deepEqual(parts, [['a', 100, 'I81'], ['b', -20, '-I26']], 'the bill shows 8.1 % on 100, no 2.6 %');
});

// ─── The app's own runs ─────────────────────────────────────────────────────────────────────────

test('#493 review: capAtReceipts counts the lines at a rate together, takes a credit line into account, and leaves a group without its tax alone', () => {
  let n = 0;
  const id = () => `x${++n}`;
  const parts = (es: JournalEntry[]) => es.map((e) => [e.id, e.accountDebit, e.amount, e.vatCode]);
  assert.deepEqual(parts(capAtReceipts([room('I38'), kurtaxe('I38')], [hotelRead], id)), [['room', '6640', 158, 'I38'], ['kurtaxe', '6640', 6, 'I0']], 'room and Kurtaxe both at 3.8 %');
  const split = bill('s', 150, [{ ratePercent: 8.1, gross: 100, vat: 7.49 }, { ratePercent: 0, gross: 50, vat: 0 }]);
  assert.deepEqual(parts(capAtReceipts([line('a', 80, 'I81'), line('b', 70, 'I81', { accountDebit: '6510' })], [split], id)), [['a', '6500', 80, 'I81'], ['b', '6510', 20, 'I81'], ['x1', '6510', 50, 'I0']], 'spread over two accounts');
  const slip = [line('a', 108.1, 'I81')];
  assert.equal(capAtReceipts(slip, [bill('t', 108.1, [{ ratePercent: 8.1, vat: 0 }])], id), slip, 'a till slip «inkl. 8.1 % MWST» without its tax: nothing to compare');
  assert.equal(capAtReceipts(slip, [bill('t', 108.1, [{ ratePercent: 8.1, net: 100, vat: 0 }])], id), slip, 'a net without its tax');
  assert.equal(capAtReceipts(slip, [bill('t', 108.1, [{ ratePercent: 8.1, gross: 100, vat: 8.1 }])], id), slip, 'a net read for a gross: the tax proves 108.10');
  const credit = [line('a', 120, 'I81'), line('b', -20, '-I81')];
  assert.equal(capAtReceipts(credit, [tipped], id), credit, '120 less a credit of 20 on a bill of 100');
});

test('#493 review: the model books room and Kurtaxe at 3.8 % on the round-7 bill: the Kurtaxe goes to the zero code', async () => {
  const entries = await book({ ...pay, amount: 164 }, [hotelRead], context, model([
    { accountDebit: '6640', accountCredit: '', amount: 158, vatCode: 'I38', description: 'Übernachtung' },
    { accountDebit: '6640', accountCredit: '', amount: 6, vatCode: 'I38', description: 'Kurtaxe' },
  ]));
  assert.deepEqual(entries.map((e) => [e.description, e.amount, e.vatCode]), [['Übernachtung', 158, 'I38'], ['Kurtaxe', 6, 'I0']]);
});

test('capAtReceipts: the rate on no more than the receipt taxes at it, the rest to a rate the receipt shows unused, then to the zero code', () => {
  let n = 0;
  const id = () => `n${++n}`;
  const parts = (es: JournalEntry[]) => es.map((e) => [e.id, e.amount, e.vatCode]);
  assert.deepEqual(parts(capAtReceipts([line('w', 1086.42, 'I81')], [partly], id)), [['w', 846.42, 'I81'], ['n1', 240, 'I0']]);
  assert.deepEqual(parts(capAtReceipts([line('w', 102.6, 'I81')], [reduced], id)), [['w', 102.6, 'I26']], 'the bill\'s own rate');
  const mixed = bill('m', 160, [{ ratePercent: 8.1, gross: 100, vat: 7.49 }, { ratePercent: 2.6, gross: 60, vat: 1.52 }]);
  assert.deepEqual(parts(capAtReceipts([line('w', 160, 'M81')], [mixed], id)), [['w', 100, 'M81'], ['n2', 60, 'M26']]);
  assert.deepEqual(parts(capAtReceipts([line('w', 120, 'I81')], [tipped], id)), [['w', 100, 'I81'], ['n3', 20, 'I0']]);
  const under = [line('a', 1086.42, 'I0')];
  assert.equal(capAtReceipts(under, [partly], id), under, 'an under-claim stays');
  const fits = [line('a', 846.42, 'I81'), line('b', 240, 'I0')];
  assert.equal(capAtReceipts(fits, [partly], id), fits);
  const none = [line('a', 120, 'I81')];
  assert.equal(capAtReceipts(none, [], id), none, 'no receipt: the evidence rule decides, not the cap');
  assert.equal(capAtReceipts(none, [{ ...tipped, hasSwissVat: undefined, vatSummary: undefined }], id), none, 'a receipt not read: its VAT is not known');
  assert.equal(capAtReceipts(none, [{ ...tipped, currency: 'EUR' }], id), none, 'a receipt in another currency than the line');
  const refund = [line('a', -120, '-I81')];
  assert.equal(capAtReceipts(refund, [tipped], id), refund, 'a minus code claims nothing');
});

const fx = loadFxResolver();
const context: ClassifyContext = {
  companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '',
  bankAccounts: [{ bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }],
};
const pay: BankTransaction = { ref: 'P1', bank: 'ZKB', date: '2026-10-20', amount: 1086.42, currency: 'CHF', direction: 'DBIT', description: 'Versand Muster AG' };
const model = (entries: ClassifyEntry[]): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Versand.' }])));
};
async function book(tx: BankTransaction, receipts: Receipt[], ctx: ClassifyContext, ask?: ClassifyDeps['ask']): Promise<JournalEntry[]> {
  const books = {
    transactions: [tx], receipts, mappings: receipts.map((r) => ({ transactionRef: tx.ref, receiptId: r.id })),
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  const { classified, failed } = await classifyTransactions(books, [tx], { ask: ask ?? model([]), fx, context: ctx });
  assert.deepEqual([classified, failed.map((f) => f.reason)], [[tx.ref], []]);
  return books.journalEntries;
}
const booked = (es: JournalEntry[]) => es.map((e) => [e.amount, e.vatCode ?? '']).sort();

test('the model\'s 8.1 % on the whole payment is booked on what the bill taxes, the rest at the zero code', async () => {
  const entries = await book(pay, [partly], context, model([{ accountDebit: '6500', accountCredit: '', amount: 1086.42, vatCode: 'I81', description: 'Versand' }]));
  assert.deepEqual(booked(entries), [[240, 'I0'], [846.42, 'I81']]);
  const rest = entries.find((e) => e.vatCode === 'I0')!;
  assert.deepEqual(rest.by, { kind: 'code', check: 'purchaseVat' });
  assert.match(rest.reason ?? '', /8\.1 % MWST auf weniger/);
});

test('the model\'s 8.1 % on a bill at 2.6 % is booked at the bill\'s rate', async () => {
  const entries = await book({ ...pay, amount: 102.6 }, [reduced], context, model([{ accountDebit: '6500', accountCredit: '', amount: 102.6, vatCode: 'I81', description: 'Versand' }]));
  assert.deepEqual(booked(entries), [[102.6, 'I26']]);
});

test('a rule\'s 8.1 % claims no more input tax than the bill shows', async () => {
  const facts: RuleFacts = { account: () => true, vat: () => 'taken', counterparty: () => true };
  const parsed = parseRule({ id: 'versand', when: { text: 'Versand Muster' }, then: { account: '6500', vat: 'I81' } }, facts);
  assert.ok(parsed.ok);
  const entries = await book(pay, [partly], { ...context, rules: [{ rule: parsed.rule }] });
  assert.deepEqual(booked(entries), [[240, 'I0'], [846.42, 'I81']]);
  assert.equal(entries.find((e) => e.vatCode === 'I81')!.rule, 'versand');
});

test('a payment without a receipt, and an under-claim, are booked as before', async () => {
  const noReceipt = await book(pay, [], context, model([{ accountDebit: '6500', accountCredit: '', amount: 1086.42, vatCode: 'I81', description: 'Versand' }]));
  assert.deepEqual(booked(noReceipt), [[1086.42, 'I0']], 'no receipt, no input tax (the evidence rule, as before)');
  const under = await book(pay, [partly], context, model([{ accountDebit: '6500', accountCredit: '', amount: 1086.42, vatCode: 'I0', description: 'Versand' }]));
  assert.deepEqual(booked(under), [[1086.42, 'I0']]);
});
