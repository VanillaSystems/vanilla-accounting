/**
 * The replay benchmark's own logic (tools/replay/README.md) on the demo workspace: the cut keeps the
 * filed books whole and sets the period aside, the comparison sees what matters and nothing else, and
 * the oracle's actions count as the touches they are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry } from '../src/types/index.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_REPO, DEMO_ROOT } from './support/workspace.js';
import { compare, lineOf, parseLine, Pool, showLine } from '../tools/replay/compare.js';
import { effectJudge, returnCodeKey } from '../tools/replay/judge.js';
import { categoriesOf } from '../tools/replay/report.js';
import { decideCut, keyOf, prepare } from '../tools/replay/cut.js';
import { passOf, planFirst, planSecond, touchOf, type CaseView, type Context, type KeySide } from '../tools/replay/oracle.js';

const books = loadBooks(workspaceAt(DEMO_ROOT));
const source = { transactions: books.transactions, entries: books.journalEntries, mappings: books.mappings, receipts: books.receipts, statements: books.bankStatements ?? [] };
const Q2 = { from: '2026-04-01', to: '2026-06-30' };

/** A Q2 payment of the demo with receipts, one with a single entry. */
const linkedRefs = new Set(books.mappings.map((m) => m.transactionRef));
const entriesOf = (ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref);
const payment = books.transactions.find((t) => t.date >= Q2.from && t.date <= Q2.to && linkedRefs.has(t.ref) && entriesOf(t.ref).length === 1)!;
const receiptsOf = (ref: string) => [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))];
const key: KeySide = { tx: payment, entries: entriesOf(payment.ref), receipts: receiptsOf(payment.ref) };
const owner = '2100';
const ctx: Context = { hasReceipt: (id) => books.receipts.some((r) => r.id === id), owner, saleChoice: () => 'saleDomestic' };
const view = (over: Partial<CaseView> = {}): CaseView => ({ ref: payment.ref, tx: payment, entries: key.entries, receipts: key.receipts, ...over });
const changed = (e: JournalEntry, over: Partial<JournalEntry>): JournalEntry => ({ ...e, id: `${e.id}-app`, ...over });

test('a payment equals itself; its lines split, summed or turned round still do', () => {
  assert.ok(key.receipts.length > 0 && key.entries.length === 1, 'a demo payment with one entry and a receipt');
  const [e] = key.entries;
  assert.equal(compare(view(), key).ok, true);
  const half = Math.round(e.amount * 50) / 100;
  assert.equal(compare(view({ entries: [changed(e, { amount: half }), changed(e, { amount: Math.round((e.amount - half) * 100) / 100 })] }), key).ok, true, 'two lines of the same accounts and code are their sum');
  assert.equal(compare(view({ entries: [changed(e, { accountDebit: e.accountCredit, accountCredit: e.accountDebit, amount: -e.amount })] }), key).ok, true, 'a negative amount is the line the other way round');
  assert.equal(compare(view({ entries: [changed(e, { description: 'anders', exchangeRate: 2 })] }), key).ok, true, 'texts and rates do not count');
});

test('an account, a code, an amount, a day or a receipt that differs is a difference', () => {
  const [e] = key.entries;
  for (const over of [{ accountDebit: '9999' }, { vatCode: e.vatCode ? '' : 'X1' }, { amount: e.amount + 0.01 }, { date: '2026-12-31' }] as Array<Partial<JournalEntry>>) {
    const v = compare(view({ entries: [changed(e, over)] }), key);
    assert.deepEqual([v.ok, v.lines, v.links], [false, false, true], JSON.stringify(over));
  }
  const unlinked = compare(view({ receipts: [] }), key);
  assert.deepEqual([unlinked.ok, unlinked.lines, unlinked.links], [false, true, false]);
  assert.deepEqual(unlinked.diff?.linksKey, key.receipts);
});

test('where the app left a payment: right, wrong (silent), asked or open', () => {
  const [e] = key.entries;
  assert.equal(passOf(view(), key).pass, 'right');
  assert.equal(passOf(view({ entries: [changed(e, { accountDebit: '9999' })] }), key).pass, 'wrong');
  assert.equal(passOf(view({ receipts: [] }), key).pass, 'wrong', 'a missing link is a silent error too');
  assert.equal(passOf(view({ entries: [], question: { id: 'q1', topic: 'saleVat', choices: ['saleDomestic'] } }), key).pass, 'asked');
  assert.equal(passOf(view({ entries: [], task: true }), key).pass, 'asked');
  assert.equal(passOf(view({ entries: [] }), key).pass, 'open');
});

test('the oracle touches nothing the app got right', () => {
  assert.deepEqual(planFirst(view(), key, ctx), []);
  assert.deepEqual(planSecond(view(), key, ctx), []);
});

test('a wrong booking is corrected in place of the app\'s lines, and counts as a correction', () => {
  const [e] = key.entries;
  const app = view({ entries: [changed(e, { accountDebit: '9999' })] });
  const actions = planSecond(app, key, ctx);
  assert.deepEqual(actions, [{ kind: 'book', entries: key.entries, replace: [`${e.id}-app`] }]);
  assert.equal(touchOf(actions[0], app, app, ctx), 'correction');
});

test('an unbooked payment: links first, «needs no receipt» where the key has none, then booked by hand', () => {
  const open = view({ entries: [], receipts: [], tx: { ...payment, waitsForReceipt: { since: '2026-05-01' } } });
  const first = planFirst(open, key, ctx);
  assert.deepEqual(first, [{ kind: 'link', add: key.receipts, remove: [] }]);
  assert.equal(touchOf(first[0], open, open, ctx), 'link');
  const noReceipt = planFirst(open, { ...key, receipts: [] }, ctx);
  assert.deepEqual(noReceipt, [{ kind: 'noReceipt' }]);
  assert.equal(touchOf(noReceipt[0], open, open, ctx), 'noReceipt');
  const second = planSecond(view({ entries: [] }), key, ctx);
  assert.equal(second[0].kind, 'book');
  assert.equal(touchOf(second[0], open, view({ entries: [] }), ctx), 'hand');
});

test('a receipt the replay\'s books lack is not linked; a link the key lacks is taken away', () => {
  const other = books.receipts.find((r) => !key.receipts.includes(r.id))!.id;
  const actions = planFirst(view({ receipts: [other] }), { ...key, receipts: [...key.receipts, 'feedfacefeedface'] }, ctx);
  assert.deepEqual(actions, [{ kind: 'link', add: key.receipts, remove: [other] }]);
});

test('a question of the app is answered by the key\'s booking and counts as an answer, so does a booking after it', () => {
  const asked = view({ entries: [], question: { id: 'q1', topic: 'saleVat', choices: ['saleDomestic', 'saleAbroad', 'notSale'] } });
  const first = planFirst(asked, key, ctx);
  assert.deepEqual(first.at(-1), { kind: 'answer', question: 'q1', choice: 'saleDomestic' });
  assert.equal(touchOf(first.at(-1)!, asked, asked, ctx), 'answer');
  const later = planSecond(view({ entries: [] }), key, ctx);
  assert.equal(touchOf(later[0], asked, view({ entries: [] }), ctx), 'answer');
});

test('a share on the owner\'s account the app did not book is a private split', () => {
  const [e] = key.entries;
  const half = Math.round(e.amount * 50) / 100;
  const split: KeySide = { ...key, entries: [changed(e, { amount: half }), changed(e, { id: 'p', accountDebit: owner, vatCode: undefined, amount: Math.round((e.amount - half) * 100) / 100 })] };
  const app = view({ entries: key.entries });
  const [book] = planSecond(app, split, ctx);
  assert.equal(touchOf(book, app, app, ctx), 'private');
});

test('the cut keeps what lies up to its eve and sets the period aside', () => {
  const d = decideCut(source, Q2.from, Q2.to);
  assert.equal(d.cut, '2026-03-31');
  assert.ok(books.journalEntries.filter(d.keepEntry).every((e) => e.date <= d.cut));
  assert.ok(books.journalEntries.filter((e) => !d.keepEntry(e)).every((e) => e.date > d.cut || d.outTx.has(e.transactionRef)));
  assert.ok(d.inputReceipts.every((r) => d.outReceipts.has(r.id)));
  const k = keyOf(source, Q2.from, Q2.to);
  assert.equal(k.cases.length, books.transactions.filter((t) => t.date >= Q2.from && t.date <= Q2.to).length);
  assert.ok(k.cases.every((c) => c.entries.every((e) => e.transactionRef === c.ref)));
});

test('prepare makes a copy whose filed books load (their seals hold) with the period\'s inputs beside it, and leaves the source alone', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'replay-')), 'run');
  const before = readFileSync(join(DEMO_ROOT, 'transactional-data/2026/books/entries.jsonl'), 'utf8');
  try {
    const { key: k } = prepare({ source: DEMO_REPO, period: '2026-Q2', arm: 'cold', out });
    const copy = loadBooks(workspaceAt(join(out, 'repo')));
    assert.ok(copy.journalEntries.length > 0 && copy.journalEntries.every((e) => e.date <= '2026-03-31'));
    assert.ok(copy.transactions.every((t) => t.date <= '2026-03-31'));
    assert.ok(k.cases.length > 0);
    assert.ok(k.inputs.every((i) => existsSync(join(out, i.path))));
    assert.ok(k.inputs.some((i) => i.kind === 'statement') && k.inputs.some((i) => i.kind === 'receipt'));
    assert.ok(!existsSync(join(out, 'repo/vanilla-accounting/data')), 'no local state of the source');
    assert.equal(readFileSync(join(DEMO_ROOT, 'transactional-data/2026/books/entries.jsonl'), 'utf8'), before);
    assert.throws(() => prepare({ source: DEMO_REPO, period: '2026-Q1', arm: 'cold', out: `${out}-q1` }), /filed/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('a zero code equals no code, and the tax on a line of its own equals it in the gross line, where the return and the accounts come out alike', () => {
  const effect = effectJudge('2026-Q2');
  const codeKey = returnCodeKey('2026-Q2', '2026-04-01');
  const line = (debit: string, credit: string, vatCode: string, amount: number) => ({ date: '2026-05-04', accountDebit: debit, accountCredit: credit, vatCode, amount });
  assert.equal(compare({ entries: [line('6940', '1020', '', 5)], receipts: [] }, { entries: [line('6940', '1020', 'I0', 5)], receipts: [] }, { codeKey, effect }).ok, true);
  // The input tax of 108.10 at 8.1 % is 8.10: on the gross line's code, or on a line of its own.
  const own = compare({ entries: [line('6500', '1020', '', 108.1), line('', '6500', 'I81-2', 8.1)], receipts: [] }, { entries: [line('6500', '1020', 'I81', 108.1)], receipts: [] }, { codeKey, effect });
  assert.equal(own.lines, true);
  const less = compare({ entries: [line('6500', '1020', '', 108.1), line('', '6500', 'I81-2', 7.5)], receipts: [] }, { entries: [line('6500', '1020', 'I81', 108.1)], receipts: [] }, { codeKey, effect });
  assert.deepEqual([less.lines, less.wrong], [false, ['vat']], 'another tax is a VAT difference');
  const elsewhere = compare({ entries: [line('6500', '1020', '', 108.1)], receipts: [] }, { entries: [line('6500', '1020', '', 108.1), line('6501', '1020', '', 3)], receipts: [] }, { codeKey, effect });
  assert.deepEqual([elsewhere.lines, elsewhere.wrong], [false, ['split']], 'a line the key has on the payment and the replay lacks');
  const pooled = compare({ entries: [line('6500', '1020', '', 108.1)], receipts: [] }, { entries: [line('6500', '1020', '', 108.1), line('6501', '1020', '', 3)], receipts: [] }, { codeKey, effect, appElsewhere: new Pool([lineOf(line('6501', '1020', '', 3))]) });
  assert.equal(pooled.lines, true, 'the same line under a ref of no payment counts as there');
  const account = compare({ entries: [line('4010', '1020', '', 20)], receipts: [] }, { entries: [line('6513', '1020', '', 20)], receipts: [] }, { codeKey, effect });
  assert.deepEqual(account.wrong, ['account']);
});

test('a booking right whose links differ is a link-only difference; a saved diff line reads back as written', () => {
  const [e] = key.entries;
  const v = compare(view({ receipts: [] }), key);
  const cats = categoriesOf([{ ref: 'a', pass: 'wrong', first: v }, { ref: 'b', pass: 'right', first: compare(view(), key) }]);
  assert.deepEqual([cats.linkOnly, cats.bookingRight, cats.bookingWrong], [1, 1, 0]);
  for (const l of [lineOf(e), lineOf({ ...e, accountDebit: '', vatCode: undefined })]) assert.deepEqual(parseLine(showLine(l)), l);
});
