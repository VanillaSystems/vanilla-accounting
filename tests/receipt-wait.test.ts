/**
 * A payment that needs a receipt waits for it (issue #29, owner 21.10.: «wait»): the inbox run does
 * not book it while none is linked, and marks it as waiting; a receipt linked later books it.
 * Payments that need none (money in, the bank's own fee row, own transfers, an authority whose
 * notice is filed apart, a payment a person marked) are booked at once. When the return comes near
 * it becomes the person's, and «Ohne Vorsteuer buchen» books it with the zero code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStep } from '../src/intake/classify.js';
import type { IntakeNote } from '../src/intake/pipeline.js';
import { parseReceiptApply, receiptFree, receiptKnowledge, receiptWait, settlementAccount, type WaitContext } from '../src/booking/receipt-wait.js';
import { receiptDue, waitingForReceipt } from '../src/accounting/receipt-due.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const OUT = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-10-05', amount: 89, currency: 'CHF', direction: 'DBIT', description: 'Telefonie Muster AG Rechnung 10/2026', ...over });

const CTX: WaitContext = { free: new Set(['estv']), assumesUnread: new Set(['coop']), wordings: [/Bancomat/i], ownIbans: new Set(['CH6580808000000000001']), settles: settlementAccount({ moneyAccounts: new Set(['1020', '1000']), ownerAccount: '2850' }), inputTax: true };

test('the decision: a purchase without a receipt waits; a receipt, a mark, money in, a fee row, an own transfer, an ask rule, a receipt-free business, a withdrawal's wording or a firm without input tax book at once', () => {
  assert.deepEqual(receiptWait(OUT('a'), { linked: 'none' }, CTX), { wait: true });
  const why = (tx: BankTransaction, facts = {}, ctx = CTX) => { const w = receiptWait(tx, { linked: 'none', ...facts }, ctx); return w.wait ? 'wait' : w.why; };
  assert.equal(why(OUT('a'), { linked: 'read' }), 'receipt');
  assert.equal(why(OUT('a', { noReceiptNeeded: true })), 'marked');
  assert.equal(why(OUT('a', { amount: 0 })), 'zero');
  assert.equal(why(OUT('a', { direction: 'CRDT' })), 'incoming');
  assert.equal(why(OUT('a', { type: 'wise-fee' })), 'separateFee');
  assert.equal(why(OUT('a', { counterpartyIban: 'ch65 8080 8000 0000 0000 1' })), 'ownTransfer');
  assert.equal(why(OUT('a'), { ruleAccount: '1000' }), 'settlement', 'a rule that books onto cash is a transfer');
  assert.equal(why(OUT('a'), { ruleAccount: '2850' }), 'settlement', 'the owner\'s outlays paid back');
  assert.equal(why(OUT('a'), { ruleAccount: '2270' }), 'settlement', 'an employee\'s outlays or a card\'s bill: a debt of the chart');
  assert.equal(why(OUT('a'), { ruleAccount: '6510' }), 'wait', 'a rule that books an expense waits like the model');
  assert.equal(why(OUT('a'), { ruleAccount: '1510' }), 'wait', 'a machine bought: its input tax needs the receipt');
  assert.equal(why(OUT('a'), { ruleAccount: '6510', ruleAsks: true }), 'ruleAsks', 'a rule that asks first asks at once');
  assert.equal(why(OUT('a'), { business: 'estv' }), 'business');
  assert.equal(why(OUT('a'), { business: 'telefonie' }), 'wait');
  assert.equal(why(OUT('a', { description: 'BANCOMAT Bezug Zürich HB' })), 'wording', 'a cash withdrawal moves money onto the cash box');
  assert.equal(why(OUT('a', { description: 'Zahlung', counterparty: 'Bancomat Bahnhof' })), 'wording', 'the bank may put it in the counterparty field');
  assert.equal(why(OUT('a'), {}, { ...CTX, inputTax: false }), 'noInputTax');
});

test('apply: { receipt: none } on evidence.guide.yaml#rules: the shipped authorities with their own notice carry it, customs does not; a wrong form is refused', () => {
  const free = receiptFree(loadKnowledge(APP_ROOT, DEMO_ROOT));
  for (const id of ['estv', 'ausgleichskasse', 'steuerverwaltung']) assert.ok(free.has(id), id);
  assert.equal(free.has('bazg'), false, 'the import VAT needs its assessment as proof');
  assert.deepEqual(parseReceiptApply({ receipt: 'none' }), { ok: true });
  assert.match((parseReceiptApply({ receipt: 'later' }) as { problem: string }).problem, /receipt must be none/);
  assert.match((parseReceiptApply({ receipt: 'none', inputTax: 'none' }) as { problem: string }).problem, /apply\.inputTax is unknown/);
});

test('apply: { receipt: none, text } on a guide\'s evidence.guide.yaml#rules: the shipped cash-withdrawal wording in any language, never a word inside another', () => {
  const { wordings } = receiptKnowledge(loadKnowledge(APP_ROOT, DEMO_ROOT));
  const free = (s: string) => wordings.some((w) => w.test(s));
  for (const s of ['BANCOMAT Bezug ZKB Zürich HB', 'Bargeldbezug Postomat Bern', 'ATM withdrawal Lisbon', 'Retrait Bancomat Genève', 'Prelievo contanti Lugano', 'Geldautomat Konstanz']) assert.ok(free(s), s);
  for (const s of ['Telefonie Muster AG Rechnung 10/2026', 'Treatment Klinik AG', 'Batmobil Garage', 'Caisse de retraite BVG']) assert.equal(free(s), false, s);
  assert.deepEqual(parseReceiptApply({ receipt: 'none', text: 'Bancomat' }, 'guide'), { ok: true, text: 'Bancomat' });
  assert.match((parseReceiptApply({ receipt: 'none' }, 'guide') as { problem: string }).problem, /apply\.text/, 'a guide holds for every payment: it names the wording');
  assert.match((parseReceiptApply({ receipt: 'none', text: '(' }, 'guide') as { problem: string }).problem, /apply\.text/);
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Bancomat' }) as { problem: string }).problem, /apply\.text/, 'in a business file the business is the condition');
});

test('the person is asked two weeks before the return is due; until then the waiting is the app\'s', () => {
  assert.deepEqual(receiptDue('2026-08-14'), { due: '2026-11-29', askFrom: '2026-11-15' });
  const books = {
    transactions: [OUT('W', { date: '2026-08-14', waitsForReceipt: { since: '2026-08-15T06:00:00Z' } }), OUT('L', { date: '2026-08-20', waitsForReceipt: { since: '2026-08-21T06:00:00Z' } }), OUT('N', { date: '2026-08-21' })],
    mappings: [{ transactionRef: 'L', receiptId: 'r1' }], receipts: [{ id: 'r1' } as Receipt], config: {},
  };
  const at = (today: string) => waitingForReceipt(books, () => false, today).map((w) => [w.tx.ref, w.kind]);
  assert.deepEqual(at('2026-11-14'), [['W', 'waits']], 'a payment with its receipt linked waits no more: the next run books it');
  assert.deepEqual(at('2026-11-15'), [['W', 'asks']]);
  assert.deepEqual(waitingForReceipt(books, (ref) => ref === 'W', '2026-11-20'), [], 'booked meanwhile');
  assert.deepEqual(waitingForReceipt({ ...books, transactions: books.transactions.map((t) => ({ ...t, noReceiptNeeded: true })) }, () => false, '2026-11-20'), [], '«Ohne Vorsteuer buchen» answered it');
  assert.deepEqual(waitingForReceipt({ ...books, config: { closedThrough: '2026-09-30' } }, () => false, '2026-12-01'), [], 'a filed quarter holds nothing open');
});

/** The demo company (its rules, its knowledge, the effective method) with an employees' clearing account and a cash box; `rules`: its knowledge/rules/booking.guide.yaml. */
function company(rules?: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-wait-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const accounts = join(dir, 'master-data/accounts.json');
  writeFileSync(accounts, JSON.stringify([...JSON.parse(readFileSync(accounts, 'utf8')), { number: '2270', name: 'Kontokorrent Mitarbeitende' }, { number: '1000', name: 'Kasse' }]));
  if (rules) {
    mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
    writeFileSync(join(dir, 'knowledge', 'rules', 'booking.guide.yaml'), rules);
  }
  return workspaceAt(dir);
}

const RECEIPT: Receipt = {
  id: 'tel-10', filename: '20261005-telefonie-10.pdf', location: 'archived', kind: 'invoice', date: '2026-10-05', amount: 89, currency: 'CHF',
  extractedText: 'Telefonie Muster AG, Rechnung Oktober 2026, Total CHF 89.00 inkl. 8.1% MWST 6.67', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 89, vat: 6.67 }],
} as Receipt;

function booksOf(txs: BankTransaction[]): Books {
  return { transactions: txs, receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
}

const REFS = ['TEL-10', 'ESTV-1', 'IN-1', 'FEE-1', 'OWNER-1', 'STAFF-1', 'ATM-1'];
/** The model's answer: a payment out on 6570 with I81, the one in as a sale, the bank on the other side. */
const model = async (prompt: string) => {
  const refs = REFS.filter((ref) => prompt.includes(ref));
  const line = (ref: string) => (ref === 'IN-1' ? { accountDebit: '', accountCredit: '3200', amount: 89, vatCode: 'V81', description: 'Verkauf' }
    : ref === 'OWNER-1' ? { accountDebit: '2451', accountCredit: '', amount: 89, vatCode: '', description: 'Spesen Inhaberin' }
      : ref === 'STAFF-1' ? { accountDebit: '2270', accountCredit: '', amount: 89, vatCode: '', description: 'Spesen Mitarbeiter' }
        : ref === 'ATM-1' ? { accountDebit: '1000', accountCredit: '', amount: 89, vatCode: '', description: 'Barbezug' }
        : { accountDebit: '6570', accountCredit: '', amount: 89, vatCode: 'I81', description: 'Telefon' });
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [line(ref)], reason: 'Telefonrechnung' }])));
};

async function run(ws: Workspace, books: Books, ask: typeof model | 'no model' = model) {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  return (await classifyStep()({ ws, books: port, ask: ask === 'no model' ? undefined : ask, progress: () => {}, log: () => {} })).notes;
}

const entries = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
const tx = (books: Books, ref: string) => books.transactions.find((t) => t.ref === ref)!;

test('a payment without its receipt is not booked and waits; the receipt linked later books it with the receipt\'s VAT, and the mark goes', async () => {
  const ws = company();
  const books = booksOf([OUT('TEL-10')]);
  const notes = await run(ws, books);
  assert.deepEqual(entries(books, 'TEL-10'), [], 'no provisional booking');
  assert.ok(tx(books, 'TEL-10').waitsForReceipt, 'marked as waiting for its receipt');
  assert.deepEqual(notes.filter((n): n is Extract<IntakeNote, { code: 'waitingReceipt' }> => n.code === 'waitingReceipt').map((n) => n.count), [1]);
  assert.equal(notes.some((n) => n.code === 'failed' || n.code === 'noModel'), false, 'waiting is no failure');

  books.receipts.push(RECEIPT);
  books.mappings.push({ transactionRef: 'TEL-10', receiptId: RECEIPT.id });
  await run(ws, books);
  assert.deepEqual(entries(books, 'TEL-10'), [['6570', '1021', 89, 'I81']]);
  assert.equal(tx(books, 'TEL-10').waitsForReceipt, undefined);
});

test('without a model a waiting payment still waits for its receipt, not for a booking by hand', async () => {
  const ws = company();
  const books = booksOf([OUT('TEL-10')]);
  const notes = await run(ws, books, 'no model');
  assert.ok(tx(books, 'TEL-10').waitsForReceipt);
  assert.equal(notes.some((n) => n.code === 'noModel'), false);
});

test('payments that need no receipt are booked at once: an authority with its own notice, money in, the bank\'s fee row', async () => {
  const ws = company();
  const estv = OUT('ESTV-1', { description: 'Eidg. Steuerverwaltung MWST 2026-Q2', amount: 89 });
  const income = OUT('IN-1', { direction: 'CRDT', description: 'Zahlung Kunde Muster' });
  const fee = OUT('FEE-1', { type: 'wise-fee', description: 'Gebühr', amount: 89 });
  const books = booksOf([estv, income, fee]);
  await run(ws, books);
  for (const ref of ['ESTV-1', 'IN-1', 'FEE-1']) {
    assert.ok(entries(books, ref).length > 0, `${ref} booked`);
    assert.equal(tx(books, ref).waitsForReceipt, undefined, `${ref} does not wait`);
  }
});

test('«Ohne Vorsteuer buchen»: a payment marked as needing no receipt is booked at once, without input tax whatever the model wrote', async () => {
  const ws = company();
  const books = booksOf([OUT('TEL-10', { waitsForReceipt: { since: '2026-10-06T06:00:00Z' } })]);
  tx(books, 'TEL-10').noReceiptNeeded = true;
  await run(ws, books);
  assert.deepEqual(entries(books, 'TEL-10'), [['6570', '1021', 89, 'I0']]);
  assert.equal(tx(books, 'TEL-10').waitsForReceipt, undefined);
});

test('«Buchen» of one payment holds a payment that waits for its receipt, without asking the model', async () => {
  const ws = company();
  const books = booksOf([OUT('TEL-10')]);
  let asked = 0;
  const book = (ref: string) => ACTIONS['accounting.expenses.classification'].run!({ transaction: tx(books, ref), books }, {}, { ws, ask: async (p) => { asked++; return model(p); }, now: () => '2026-10-23T08:00:00Z' });
  assert.deepEqual(await book('TEL-10'), { outcome: 'held', output: { why: 'waitsForReceipt' } }, 'the model books an expense: it waits');
  tx(books, 'TEL-10').waitsForReceipt = { since: '2026-10-23T08:00:00Z' };
  asked = 0;
  assert.deepEqual(await book('TEL-10'), { outcome: 'held', output: { why: 'waitsForReceipt' } });
  assert.equal(asked, 0, 'once marked, no model call');
  books.transactions.push(OUT('OWNER-1', { description: 'Spesen Juli Anna Muster' }));
  const owner = await book('OWNER-1');
  assert.equal(owner.outcome, 'decided', 'the owner\'s outlays paid back are booked at once');
});

test('the reimbursement of an outlay is booked at once: onto the owner\'s account or an employee\'s, it settles and has no receipt of its own (issue #90); a supplier payment still waits', async () => {
  const ws = company();
  const books = booksOf([OUT('OWNER-1', { description: 'Spesen Juli Anna Muster' }), OUT('STAFF-1', { description: 'Spesen Juli Beat Beispiel' }), OUT('TEL-10')]);
  await run(ws, books);
  assert.deepEqual(entries(books, 'OWNER-1'), [['2451', '1021', 89, '']]);
  assert.deepEqual(entries(books, 'STAFF-1'), [['2270', '1021', 89, '']]);
  assert.deepEqual(entries(books, 'TEL-10'), [], 'the model would book an expense: it waits for the receipt');
  assert.deepEqual(books.transactions.filter((t) => t.waitsForReceipt).map((t) => t.ref), ['TEL-10']);
  let asked = 0;
  await run(ws, books, async (p) => { asked++; return model(p); });
  assert.equal(asked, 0, 'a waiting payment goes to the model once, not on every run');
});

const ATM = (ref: string, amount = 89) => OUT(ref, { description: 'BANCOMAT Bezug Zürich HB', amount });
const CASH_ASK = `process: booking
steps:
  classify:
    rules:
      - id: barbezug-gross
        when: { text: "Bargeldbezug|Bancomat", direction: out, amount: { over: 500 } }
        then: { ask: "Wofür war der Barbezug?", account: "1000", vat: none }
        source: wish 2026-10-15
`;

test('a cash withdrawal with no rule is booked at once onto the cash box, without a VAT code and without waiting; a supplier payment beside it still waits (issue #99)', async () => {
  const ws = company();
  const books = booksOf([ATM('ATM-1'), OUT('TEL-10')]);
  await run(ws, books);
  assert.deepEqual(entries(books, 'ATM-1'), [['1000', '1021', 89, '']]);
  assert.deepEqual(books.transactions.filter((t) => t.waitsForReceipt).map((t) => t.ref), ['TEL-10']);
});

test('without a model a cash withdrawal does not wait for a receipt: it is the person\'s to book now; a withdrawal marked waiting before is freed and booked', async () => {
  const ws = company();
  const books = booksOf([ATM('ATM-1'), OUT('TEL-10')]);
  const notes = await run(ws, books, 'no model');
  assert.equal(tx(books, 'ATM-1').waitsForReceipt, undefined);
  assert.ok(notes.some((n) => n.code === 'noModel'), 'it waits for a booking by hand, at once');
  tx(books, 'ATM-1').waitsForReceipt = { since: '2026-10-06T06:00:00Z' };
  await run(ws, books);
  assert.equal(tx(books, 'ATM-1').waitsForReceipt, undefined);
  assert.deepEqual(entries(books, 'ATM-1'), [['1000', '1021', 89, '']]);
});

test('«frag mich bei Barbezügen über 500»: the company\'s ask rule still asks about a big withdrawal; a small one is booked', async () => {
  const ws = company(CASH_ASK);
  const books = booksOf([ATM('ATM-BIG', 600), ATM('ATM-1')]);
  const held: string[] = [];
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  await classifyStep()({ ws, books: port, ask: model, progress: () => {}, log: () => {}, hold: (refs) => held.push(...refs) });
  assert.deepEqual(held, ['ATM-BIG'], 'asked');
  assert.deepEqual(entries(books, 'ATM-BIG'), []);
  assert.equal(tx(books, 'ATM-BIG').waitsForReceipt, undefined);
  assert.deepEqual(entries(books, 'ATM-1'), [['1000', '1021', 89, '']]);
});
