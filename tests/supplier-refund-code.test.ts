/**
 * A supplier's refund without a credit note inverts the code of the purchase it refunds (owner's
 * decision 2026-11-13, #357; AGENTS.md § VAT code rules, guide rule sid-refund): I81 back is -I81,
 * I0 back is -I0, a part refunded at the purchase's rate, a purchase of a filed quarter refunded on
 * the refund's own date. The company rule's booking, the hand form's proposal and the model's
 * lines do the same; a purchase not found unambiguously leaves the zero code with its minus, and
 * the reason says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import { workspaceAt, type LedgerBankAccount } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'refund-runs-'));

const RULES = `process: booking
steps:
  classify:
    rules:
      - id: velohaus
        when: { text: "Velohaus Meier" }
        then: { account: "6570", vat: I81 }
        source: wish 2026-11-13
`;

const context = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-ws-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'rules', 'booking.guide.yaml'), RULES);
  return loadClassifyContext(workspaceAt(dir));
})();

const tx = (ref: string, date: string, direction: 'DBIT' | 'CRDT', amount: number, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction, description, counterparty: 'Velohaus Meier' });
const purchase = (id: string, ref: string, date: string, amount: number, vatCode: string): JournalEntry =>
  ({ id, transactionRef: ref, date, accountDebit: '6570', accountCredit: '1021', amount, vatCode, description: 'Velohaus Meier' }) as JournalEntry;

/** Books with the purchases `bought` (payment and entry) and the refund R1, which has no document. */
function books(bought: Array<[BankTransaction, JournalEntry]>, refund: BankTransaction, receipts: Array<{ id: string; ref: string; text: string }> = []): Books {
  return {
    transactions: [...bought.map(([t]) => t), refund],
    receipts: receipts.map((r) => ({ id: r.id, filename: `${r.id}.pdf`, extractedText: r.text, hasSwissVat: true }) as Receipt),
    mappings: receipts.map((r) => ({ transactionRef: r.ref, receiptId: r.id })),
    bankStatements: [],
    journalEntries: bought.map(([, e]) => e),
    config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}

const neverAsked: ClassifyDeps['ask'] = async () => { throw new Error('the rule decides: no model call'); };

async function byRule(b: Books): Promise<JournalEntry> {
  const refund = b.transactions.filter((t) => t.direction === 'CRDT').at(-1)!;
  const { classified } = await classifyTransactions(b, [refund], { ask: neverAsked, fx: loadFxResolver(), context });
  assert.deepEqual(classified, [refund.ref]);
  const [e] = b.journalEntries.filter((j) => j.transactionRef === refund.ref);
  return e;
}

const bike = (amount = 432.4, date = '2026-08-04', code = 'I81', ref = 'P1', id = 'e1'): [BankTransaction, JournalEntry] =>
  [tx(ref, date, 'DBIT', amount, `Velohaus Meier Rechnung VM-${ref}88`), purchase(id, ref, date, amount, code)];

test('the rule: a refund of an I81 purchase, without a credit note, books -I81 and names the purchase', async () => {
  const b = books([bike()], tx('R1', '2026-08-20', 'CRDT', 432.4, 'Velohaus Meier Rückerstattung'));
  const e = await byRule(b);
  assert.deepEqual([e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.date], ['1021', '6570', 432.4, '-I81', '2026-08-20']);
  assert.match(e.reason ?? '', /04\.08\.2026/);
  assert.match(e.reason ?? '', /e1/, 'the reason names the original entry');
  assert.doesNotMatch(e.reason ?? '', /kein Beleg zeigt/);
});

test('the rule: a part refunded takes the purchase\'s rate on its share', async () => {
  const e = await byRule(books([bike()], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Teilgutschrift')));
  assert.deepEqual([e.amount, e.vatCode], [100, '-I81']);
});

test('the rule: a refund of a purchase booked without input tax stays -I0', async () => {
  const e = await byRule(books([bike(432.4, '2026-08-04', 'I0')], tx('R1', '2026-08-20', 'CRDT', 432.4, 'Velohaus Meier Rückerstattung')));
  assert.equal(e.vatCode, '-I0');
  assert.match(e.reason ?? '', /e1/);
});

test('the rule: a refund of a purchase in a filed quarter is booked on its own date with -I81; the filed entry stays as it is', async () => {
  const filed = bike(432.4, '2026-05-12');
  const b = books([filed], tx('R1', '2026-08-20', 'CRDT', 432.4, 'Velohaus Meier Rückerstattung'));
  const before = structuredClone(filed[1]);
  const e = await byRule(b);
  assert.deepEqual([e.date, e.vatCode, e.corrects], ['2026-08-20', '-I81', undefined], 'declared in the open quarter, no correction of the filed one');
  assert.deepEqual(b.journalEntries.find((j) => j.id === 'e1'), before);
});

test('the rule: a purchase not found unambiguously leaves the zero code and the reason says so', async () => {
  const two = [bike(432.4, '2026-08-04', 'I81', 'P1', 'e1'), bike(250, '2026-08-06', 'I81', 'P2', 'e2')];
  const e = await byRule(books(two, tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Teilgutschrift')));
  assert.equal(e.vatCode, '-I0');
  assert.match(e.reason ?? '', /kein Einkauf eindeutig gefunden/);
  const none = await byRule(books([], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Gutschrift')));
  assert.equal(none.vatCode, '-I0');
  assert.match(none.reason ?? '', /kein Einkauf eindeutig gefunden/);
});

test('the rule: the refund\'s text naming the purchase\'s invoice picks it among several', async () => {
  const two = [bike(432.4, '2026-08-04', 'I81', 'P1', 'e1'), bike(250, '2026-08-06', 'I0', 'P2', 'e2')];
  const b = books(two, tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Gutschrift zu VS-55120'), [{ id: 'inv', ref: 'P1', text: 'Velohaus Meier Rechnung VS-55120 MWST 8.1 %' }]);
  const e = await byRule(b);
  assert.equal(e.vatCode, '-I81');
});

const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', role: 'bank' }] as unknown as LedgerBankAccount[];

test('the hand form: a refund without a credit note proposes the purchase\'s code with the minus, and says where it comes from', () => {
  const b = books([bike()], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Teilgutschrift'));
  const d = bookingDraft(b, 'R1', BANK, undefined, { defaults: { sales: '3400' } })!;
  const [l] = d.lines;
  assert.deepEqual([l.accountDebit, l.accountCredit, l.vat], ['1021', '6570', '-I81']);
  assert.deepEqual(l.source?.vat, { from: 'purchase', date: '2026-08-04', code: 'I81' });
});

test('the hand form: a purchase not found unambiguously proposes the zero code, and says it found none', () => {
  const two = [bike(432.4, '2026-08-04', 'I81', 'P1', 'e1'), bike(250, '2026-08-06', 'I81', 'P2', 'e2')];
  const d = bookingDraft(books(two, tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Teilgutschrift')), 'R1', BANK, undefined, { defaults: { sales: '3400' } })!;
  assert.equal(d.lines[0].vat, '-I0');
  assert.deepEqual(d.lines[0].source?.vat, { from: 'refund' });
});

// ─── Review of #443 ──────────────────────────────────────────────────────────

/** A payment of the merchant with its booked lines, as [debit, credit, amount, code]; money in is a person's booking. */
const paid = (ref: string, date: string, direction: 'DBIT' | 'CRDT', lines: Array<[string, string, number, string?]>, description = `Velohaus Meier ${ref}`): [BankTransaction, JournalEntry[]] =>
  [tx(ref, date, direction, lines.reduce((s, l) => s + l[2], 0), description),
    lines.map(([d, c, amount, vatCode], i) => ({ id: `${ref}-${i}`, transactionRef: ref, date, accountDebit: d, accountCredit: c, amount, ...(vatCode && { vatCode }), description: 'Velohaus Meier', ...(direction === 'CRDT' && { origin: 'manual' as const }) }) as JournalEntry)];
const booksOf = (payments: Array<[BankTransaction, JournalEntry[]]>, refund: BankTransaction): Books =>
  ({ transactions: [...payments.map(([t]) => t), refund], receipts: [], mappings: [], bankStatements: [], journalEntries: payments.flatMap(([, es]) => es), config: { closedThrough: '2026-06-30' } }) as unknown as Books;

/** Books `next` into `b` after what is booked there, by the rule, and returns its code. */
async function next(b: Books, ref: string, amount: number): Promise<JournalEntry> {
  const t = tx(ref, '2026-08-25', 'CRDT', amount, 'Velohaus Meier Rückerstattung');
  b.transactions.push(t);
  const { classified } = await classifyTransactions(b, [t], { ask: neverAsked, fx: loadFxResolver(), context });
  assert.deepEqual(classified, [ref]);
  return b.journalEntries.find((j) => j.transactionRef === ref)!;
}

test('MUST: a purchase refunded in full once is not refunded again: the second full refund is not found', async () => {
  const b = booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']])], tx('R1', '2026-08-20', 'CRDT', 432.4, 'Velohaus Meier Rückerstattung'));
  assert.equal((await byRule(b)).vatCode, '-I81');
  const e = await next(b, 'R2', 432.4);
  assert.equal(e.vatCode, '-I0', 'the input tax of 432.40 went back once');
  assert.match(e.reason ?? '', /kein Einkauf eindeutig gefunden/);
});

test('MUST: three parts of 200 of a purchase of 432.40: the first two take -I81, the third is more than is left', async () => {
  const b = booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']])], tx('R1', '2026-08-20', 'CRDT', 200, 'Velohaus Meier Teilgutschrift'));
  const codes = [(await byRule(b)).vatCode, (await next(b, 'R2', 200)).vatCode, (await next(b, 'R3', 200)).vatCode];
  assert.deepEqual(codes, ['-I81', '-I81', '-I0']);
});

test('MUST: a refund after a person\'s refund of the same purchase is not found', async () => {
  const b = booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']]), paid('R0', '2026-08-10', 'CRDT', [['1021', '6570', 432.4, '-I81']])], tx('R1', '2026-08-20', 'CRDT', 432.4, 'Velohaus Meier Rückerstattung'));
  assert.equal((await byRule(b)).vatCode, '-I0');
});

test('SHOULD 1: a purchase split with a line without a code (a clearing account) that could hold the refund: not found, in the rule and the hand form', async () => {
  const split = () => booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 80, 'I81'], ['1090', '1021', 70]])], tx('R1', '2026-08-20', 'CRDT', 70, 'Velohaus Meier Rückzahlung'));
  assert.equal((await byRule(split())).vatCode, '-I0');
  const d = bookingDraft(split(), 'R1', BANK, undefined, { defaults: { sales: '3400' } })!;
  assert.notEqual(d.lines[0].vat, '-I81');
  assert.notDeepEqual(d.lines[0].source?.vat, { from: 'purchase', date: '2026-08-04', code: 'I81' });
});

test('SHOULD 2: a part that other purchases add up to is not found; a purchase of two codes is not found', async () => {
  const three = booksOf([
    paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']]),
    paid('P2', '2026-08-05', 'DBIT', [['6570', '1021', 50, 'I0']]),
    paid('P3', '2026-08-06', 'DBIT', [['6570', '1021', 50, 'I0']]),
  ], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Rückerstattung'));
  assert.equal((await byRule(three)).vatCode, '-I0', 'the two 50s add up to the refund');
  const mixed = booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 60, 'I81'], ['6570', '1021', 40, 'I0']])], tx('R1', '2026-08-20', 'CRDT', 40, 'Velohaus Meier Rückerstattung'));
  const e = await byRule(mixed);
  assert.equal(e.vatCode, '-I0');
  assert.match(e.reason ?? '', /kein Einkauf eindeutig gefunden/, 'not the I0 line by its amount: it may be part of the I81 line');
});

/** A purchase of 432.40 at I81 refunded in full, then one of 90 at I0 and its refund. */
const secondRefund = () => booksOf([
  paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']]),
  paid('R0', '2026-08-10', 'CRDT', [['1021', '6570', 432.4, '-I81']]),
  paid('P2', '2026-08-12', 'DBIT', [['6570', '1021', 90, 'I0']]),
], tx('R1', '2026-08-20', 'CRDT', 90, 'Velohaus Meier Rückerstattung'));

test('SHOULD 3 (H): in the hand form a supplier\'s earlier refund is no precedent: the purchase refunded decides, -I0', () => {
  const d = bookingDraft(secondRefund(), 'R1', BANK, undefined, { defaults: { sales: '3400' } })!;
  assert.deepEqual([d.lines[0].accountCredit, d.lines[0].vat], ['6570', '-I0']);
  assert.deepEqual(d.lines[0].source?.vat, { from: 'purchase', date: '2026-08-12', code: 'I0' });
});

test('SHOULD 3 (J): the rule books the same refund -I0, as the hand form proposes it', async () => {
  const e = await byRule(secondRefund());
  assert.equal(e.vatCode, '-I0');
  assert.match(e.reason ?? '', /P2-0/);
});

// ─── Second review of #443 ───────────────────────────────────────────────────

test('MUST: what is left is counted per code: an I81 purchase refunded in full leaves no I81 for a refund that only I0 money could be', async () => {
  const b = booksOf([
    paid('A', '2026-08-04', 'DBIT', [['6570', '1021', 300, 'I81']]),
    paid('R0', '2026-08-06', 'CRDT', [['1021', '6570', 300, '-I81']]),
    paid('B', '2026-08-08', 'DBIT', [['6570', '1021', 500, 'I0']]),
  ], tx('R1', '2026-08-20', 'CRDT', 300, 'Velohaus Meier Rückerstattung'));
  const e = await byRule(b);
  assert.equal(e.vatCode, '-I0', 'the I81 of A went back once already');
  assert.doesNotMatch(e.reason ?? '', /A-0/);
});

test('MUST (mirror): an I0 purchase refunded in full leaves no I0; the refund is a part of the I81 purchase', async () => {
  const b = booksOf([
    paid('A', '2026-08-04', 'DBIT', [['6570', '1021', 300, 'I0']]),
    paid('R0', '2026-08-06', 'CRDT', [['1021', '6570', 300, '-I0']]),
    paid('B', '2026-08-08', 'DBIT', [['6570', '1021', 500, 'I81']]),
  ], tx('R1', '2026-08-20', 'CRDT', 300, 'Velohaus Meier Rückerstattung'));
  const e = await byRule(b);
  assert.equal(e.vatCode, '-I81');
  assert.match(e.reason ?? '', /B-0/);
});

test('a refund without a code counts against every code of the account (the safe side)', async () => {
  const b = booksOf([
    paid('A', '2026-08-04', 'DBIT', [['6570', '1021', 300, 'I81']]),
    paid('R0', '2026-08-06', 'CRDT', [['1021', '6570', 300]]),
  ], tx('R1', '2026-08-20', 'CRDT', 300, 'Velohaus Meier Rückerstattung'));
  assert.equal((await byRule(b)).vatCode, '-I0');
});

test('NIT: more than 20 smaller purchases to try in sums: not found, and the reason names the limit', async () => {
  const small = Array.from({ length: 21 }, (_, i) => paid(`S${i}`, '2026-08-02', 'DBIT', [['6570', '1021', 10 + i, 'I0']]));
  const b = booksOf([paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']]), ...small], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Rückerstattung'));
  const e = await byRule(b);
  assert.equal(e.vatCode, '-I0');
  assert.match(e.reason ?? '', /mehr als 20 kleinere Einkäufe/);
});

test('NIT: a card number other payments of the merchant show too picks no purchase', async () => {
  const b = booksOf([
    paid('P1', '2026-08-04', 'DBIT', [['6570', '1021', 432.4, 'I81']], 'Velohaus Meier Karte 55667788'),
    paid('P2', '2026-08-05', 'DBIT', [['6570', '1021', 30, 'I0']], 'Velohaus Meier Karte 55667788'),
    paid('P3', '2026-08-06', 'DBIT', [['6570', '1021', 250, 'I81']], 'Velohaus Meier Twint'),
  ], tx('R1', '2026-08-20', 'CRDT', 100, 'Velohaus Meier Karte 55667788'));
  assert.equal((await byRule(b)).vatCode, '-I0');
});
