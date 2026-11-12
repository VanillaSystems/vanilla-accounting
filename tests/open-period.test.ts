/**
 * «Was muss ich jetzt noch machen?» (#342, first-run persona test, first-ai-42 and -43): the AI
 * sidebar answers from where the oldest period not filed stands, the state the review's «Noch offen»
 * list, the payments waiting for a receipt and the workflows' tasks already hold, never from the
 * setup's checklist once the setup has ended; and after «Los geht's» the sidebar is the ordinary one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import type { Question } from '../src/questions/model.js';
import type { Task } from '../src/workflows/model.js';
import type { Books } from '../src/books/store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_SHOWN, elsewhereCount, elsewhereOf, nothingOpen, openLines, openPeriodState, waitingKinds } from '../src/app/areas/automation/open-period.js';
import { countIssues, periodIssues, receiptWaits, unbookedOpen } from '../src/app/areas/automation/period-issues.js';
import { openWork, periodNote, periodState, purposeNow } from '../src/server/open-work.js';
import { leavesSetup, newThread } from '../src/app/assistant/thread.js';
import { changesIn } from '../src/assistant/changes.js';
import { isActionChange } from '../src/types/assistant.js';
import { tempWorkspace } from './support/workspace.js';

const tx = (ref: string, date: string, amount: number, extra: Partial<BankTransaction> = {}): BankTransaction => ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...extra });
const receipt = (id: string, date: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', date, amount: 50 });
const waits = { waitsForReceipt: { since: '2026-10-01T08:00:00Z' } } as Partial<BankTransaction>;

/** Books never filed, begun with the summer's statement: the open period is Q3 2026, over since 30.09. */
const books: Index = {
  config: {},
  transactions: [
    tx('LOHN', '2026-07-25', 5200), tx('AHV', '2026-07-30', 1890.35),
    tx('FARBMIX', '2026-08-06', 2410.8, waits), tx('SWISSCOM', '2026-08-15', 89, waits),
    tx('KELLER', '2026-07-02', 4860, { direction: 'CRDT' }),
    tx('OKT', '2026-10-03', 12),
  ],
  journalEntries: [{ id: 'e-keller', transactionRef: 'KELLER', date: '2026-07-02', accountDebit: '1020', accountCredit: '3400', amount: 4860, vatCode: 'V81', origin: 'classify' }],
  receipts: [receipt('lonely', '2026-09-03')],
  mappings: [],
  bankStatements: [],
};
const question: Question = { id: 'q1', on: { kind: 'payment', id: 'KELLER' }, text: '?', choices: [], by: 'app', origin: 'booking', topic: 'saleVat', askedAt: '2026-10-01T00:00:00Z', status: 'open' };
const review = { run: 'r-1', workflow: 'filing', step: 'review', item: { kind: 'period', id: '2026-Q3' }, title: { de: 'Abrechnung {period} prüfen', en: 'Review the return {period}' }, since: '2026-11-01T08:00:00Z', outcomes: ['approved'], reads: { period: '2026-Q3' } } as unknown as Task;
const ctx = { today: '2026-11-12', vatRegistered: true, length: 'quarter' as const, dueDays: 60 };

test('the state of the oldest period not filed is the review\'s list, the payments held for a receipt, the tasks and the due day: one source', () => {
  const s = openPeriodState(books, [question], [review], [], ctx);
  assert.equal(s.period.token, '2026-Q3', 'books that never filed start with the period of their first payment');
  assert.deepEqual(s.filing, { kind: 'due', due: '2026-11-29', overdue: false });
  assert.deepEqual(s.unbooked.map((t) => t.ref), ['LOHN', 'AHV', 'FARBMIX', 'SWISSCOM'], 'nothing of October');
  assert.deepEqual(s.waiting.map((w) => w.tx.ref), ['FARBMIX', 'SWISSCOM']);
  assert.deepEqual([s.questions.map((x) => x.q.id), s.unlinked.map((r) => r.id), s.tasks.map((x) => x.run)], [['q1'], ['lonely'], ['r-1']]);
  // No second truth: the counts are those of the review's «Noch offen» list for the same days.
  const issues = periodIssues(books, [question], s.period.from, s.period.to, []);
  assert.equal(s.unbooked.length + s.questions.length + s.evidence.length + s.unlinked.length, issues.length);
  assert.deepEqual(openLines(s).map((l) => [l.kind, l.kind === 'task' ? l.task.run : l.n, l.kind === 'unbooked' ? l.waiting : undefined]), [
    ['unbooked', 4, 2], ['questions', 1, undefined], ['unlinked', 1, undefined], ['task', 'r-1', undefined],
  ]);
  assert.deepEqual(waitingKinds(s), { waits: 2, asks: 0, unread: 0 }, 'until two weeks before the 29.11. the missing receipts are the app\'s work');
  assert.deepEqual(waitingKinds(openPeriodState(books, [], [], [], { ...ctx, today: '2026-11-20' })), { waits: 0, asks: 2, unread: 0 }, 'from then on they are the person\'s');
  assert.equal(nothingOpen(s), false);
  const quiet = openPeriodState({ ...books, transactions: [books.transactions[4]], receipts: [] }, [], [], [], ctx);
  assert.equal(nothingOpen(quiet), true);
  assert.deepEqual(openLines(quiet), []);
});

test('the assistant\'s message names that state with its places and asks for the card, in every conversation that is not the setup', () => {
  const ws = tempWorkspace('open-period-');
  const note = periodNote(ws, books as Books, [review], 'de', '2026-11-12');
  assert.match(note, /^Where the oldest period not filed stands[^\n]*: 2026-Q3 \(01\.07\.2026 to 30\.09\.2026\); it is over; its return is due on 29\.11\.2026\./);
  assert.match(note, /Payments without a booking \(4\), under «Kontoauszüge»:\n- 25\.07\.2026 [^\n]*CHF 5200\.00 \(LOHN\)/);
  assert.match(note, /Of them, 2 the app holds until their receipt is linked: it books them itself then and nobody is asked yet/);
  assert.doesNotMatch(note, /their return is near|could not be read/, 'only the kinds that occur are named');
  assert.match(periodNote(ws, books as Books, [review], 'de', '2026-11-20'), /Of them, 2 wait for their receipt and their return is near: each is the person's task under «Automatisierung › Aufgaben» now/);
  assert.match(note, /Receipts without a payment \(1\), under «Belege»:\n- «lonely\.pdf» of 03\.09\.2026/);
  assert.match(note, /Tasks of the workflows \(1\), under «Automatisierung › Aufgaben»[^\n]*:\n- «Abrechnung 2026-Q3 prüfen» on the period 2026-Q3/);
  assert.match(note, /never the setup's topics/);
  assert.match(note, /\{"kind":"openPeriod"\}/);
  assert.ok(openWork(ws, books as Books, [review], 'de', '2026-11-12').startsWith(note), 'what waits under Aufgaben follows the period\'s state in the same message');
  assert.match(periodNote(ws, { ...books, transactions: [books.transactions[4]], receipts: [] } as Books, [], 'de', '2026-08-01'), /it runs until 30\.09\.2026\.[^\n]*\nNothing of 2026-Q3 is open/);
});

test('a receipt that is a provider\'s order page is no receipt without a payment, in the note as on the card (review of #354)', () => {
  const ws = tempWorkspace('open-period-pages-');
  mkdirSync(join(ws.paths.root, 'knowledge', 'suppliers'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-01\n  revenue: "3200"\n');
  const page: Receipt = { ...receipt('page', '2026-08-10'), extractedText: '#2001\n\nPaid\n\nTotal CHF 54.05', kind: 'sales-record', description: 'Verkauf' };
  const withPage = { ...books, receipts: [...books.receipts, page] } as Books;
  assert.deepEqual(openPeriodState(withPage, [], [], [], ctx).unlinked.map((r) => r.id), ['lonely', 'page'], 'without the order pages the page counts as a receipt that needs its payment');
  const card = periodState(ws, withPage, [], '2026-11-12');
  assert.deepEqual(card.unlinked.map((r) => r.id), ['lonely'], 'the state the note is written from knows the order pages');
  const note = periodNote(ws, withPage, [], 'de', '2026-11-12');
  assert.match(note, new RegExp(`Receipts without a payment \\(${card.unlinked.length}\\)`));
  assert.doesNotMatch(note, /Verkauf/);
});

test('only the tasks about the period are its state, and a long list is cut with what was left out (review of #354)', () => {
  const later = Array.from({ length: 200 }, (_, i) => ({ ...review, run: `late-${i}`, item: { kind: 'transaction', id: 'OKT' }, title: { de: 'Frag: Barbezug', en: 'Ask' } }) as unknown as Task);
  const source = { ...review, run: 'src', item: { kind: 'source', id: 'mail' } } as unknown as Task;
  const other = { ...review, run: 'q4', item: { kind: 'period', id: '2026-Q4' } } as unknown as Task;
  const mine = Array.from({ length: 8 }, (_, i) => ({ ...review, run: `in-${i}`, item: { kind: 'receipt', id: 'lonely' }, title: { de: `Beleg prüfen ${i}`, en: 'Check' } }) as unknown as Task);
  const onPayment = { ...review, run: 'pay', item: { kind: 'transaction', id: 'LOHN' }, title: { de: 'Zahlung ohne Buchung', en: 'Unbooked' } } as unknown as Task;
  const s = openPeriodState(books, [], [...later, source, other, review, onPayment, ...mine], [], ctx);
  assert.deepEqual(s.tasks.map((x) => x.run), ['r-1', 'pay', ...mine.map((x) => x.run)], 'nothing of October, of another period or of a source');
  const lines = openLines(s).filter((l) => l.kind === 'task' || l.kind === 'moreTasks');
  assert.deepEqual(lines.map((l) => (l.kind === 'task' ? l.task.run : `+${(l as { n: number }).n}`)), ['r-1', 'in-0', 'in-1', 'in-2', 'in-3', `+${9 - TASKS_SHOWN}`], 'a task on a payment of the first line is that payment; five lines, and the rest counted');
  const ws = tempWorkspace('open-period-tasks-');
  const note = openWork(ws, books as Books, [...later, review, ...Array.from({ length: 30 }, (_, i) => ({ ...mine[0], run: `m-${i}` }))], 'de', '2026-11-12');
  const [period, rest] = note.split('\n\nWhat else waits');
  assert.match(period, /Tasks of the workflows \(31\)[^\n]*:\n(- [^\n]*\n){20} {2}… and 11 more/);
  assert.doesNotMatch(period, /late-|Barbezug/);
  assert.match(rest, /Tasks of the workflows \(200\):\n(- «Frag: Barbezug»[^\n]*\n){20} {2}… and 180 more/, 'the others are in the list of what else waits, cut and counted too');
});

test('the message lists each thing once: the period\'s state, then what else waits outside it (review of #354)', () => {
  const ws = tempWorkspace('open-period-once-');
  const more: Index = { ...books, transactions: [...books.transactions, tx('NOV', '2026-11-03', 20)] };
  const note = openWork(ws, more as Books, [], 'de', '2026-11-12');
  const [period, rest] = note.split('\n\nWhat else waits');
  assert.match(period, /Payments without a booking \(4\)/);
  assert.match(rest, /^ for the person under «Automatisierung › Aufgaben» now, outside 2026-Q3/);
  assert.match(rest, /Payments without a booking \(2\):\n- 03\.10\.2026 [^\n]*\(OKT\)\n- 03\.11\.2026 [^\n]*\(NOV\)/);
  for (const ref of ['LOHN', 'AHV', 'FARBMIX', 'SWISSCOM']) assert.equal(note.split(`(${ref})`).length - 1, 1, `${ref} is named once`);
  assert.doesNotMatch(rest, /lonely|Open questions/, 'nothing of the period is repeated, and what there is none of is left out');
  const quiet = openWork(ws, { ...books, transactions: [books.transactions[4]], receipts: [] } as Books, [], 'de', '2026-08-01');
  assert.match(quiet, /Nothing of 2026-Q3 is open[^\n]*\n[^\n]*\n\nWhat else waits[^\n]*\nNothing else waits:/);
});

test('a held payment is told by what it waits for: its receipt, or the person\'s word on a receipt that cannot be read (review of #354)', () => {
  const unreadable: Receipt = { ...receipt('scan', '2026-08-06'), kind: 'invoice', amount: 2410.8, needsVisionReview: true } as Receipt;
  const held: Index = {
    ...books,
    transactions: books.transactions.map((x) => (x.ref === 'FARBMIX' ? { ...x, waitsForReceipt: { since: '2026-10-01T08:00:00Z', unread: true } } as BankTransaction : x)),
    receipts: [...books.receipts, unreadable], mappings: [{ receiptId: 'scan', transactionRef: 'FARBMIX' }],
  };
  const early = { ...ctx, today: '2026-10-20' };
  const s = openPeriodState(held, [], [], [], early);
  assert.deepEqual(waitingKinds(s), { waits: 1, asks: 0, unread: 1 });
  const line = openLines(s)[0];
  // The count of held payments is the return's page's (receiptWaits: until the receipt comes or can be read); the unreadable one is named besides as the person's.
  assert.deepEqual(line.kind === 'unbooked' && [line.n, line.waiting, line.unread], [4, 2, 1], 'the card counts as the return\'s page does, and names the unreadable one besides');
  assert.equal(countIssues(periodIssues(held, [], s.period.from, s.period.to, [], new Map(), early.today)).waitingReceipt, 2);
  const note = periodNote(tempWorkspace('open-period-kinds-'), held as Books, [], 'de', '2026-10-20');
  assert.match(note, /Of them, 1 the app holds until their receipt is linked: it books them itself then and nobody is asked yet/);
  assert.match(note, /Of them, 1 have their receipt linked, but its VAT could not be read: each waits for the person's word at once[^\n]*no receipt is missing/);
  assert.doesNotMatch(note, /their return is near/);
});

test('a setup the person ended carries no setup note: its conversation is answered like any other', () => {
  assert.equal(purposeNow('onboarding', {}), 'onboarding', 'while the setup runs, its conversation is the setup\'s');
  assert.equal(purposeNow('onboarding', { ready: '2026-11-12T09:00:00Z' }), undefined, 'after «Los geht\'s» it is an ordinary one: the books\' state, no checklist');
  assert.equal(purposeNow('onboarding', { ready: '2026-11-12T09:00:00Z' }, true), 'onboarding', 'reopened by the person from Firma or Verlauf, it is the setup again: checklist and open question');
  assert.equal(purposeNow('collection-setup', { ready: '2026-11-12T09:00:00Z' }), 'collection-setup');
  assert.equal(purposeNow(undefined, {}), undefined);
});

test('after «Los geht\'s» the sidebar leaves the setup conversation, unless the person opened the setup herself', () => {
  const setup = newThread('onboarding');
  assert.equal(leavesSetup(setup, { over: false, wanted: false }), false, 'the setup still runs');
  assert.equal(leavesSetup(setup, { over: true, wanted: false }), true, 'ended: ⌘J and a reload open the ordinary sidebar');
  assert.equal(leavesSetup(setup, { over: true, wanted: true }), false, 'Firma › «Einrichtung …» keeps it');
  assert.equal(leavesSetup(newThread(), { over: true, wanted: false }), false);
  assert.equal(leavesSetup(newThread('collection-setup'), { over: true, wanted: false }), false);
});

test('the card is a change of the block that changes nothing', () => {
  const [c] = changesIn('```vanilla-changes\n[{"kind":"openPeriod"}]\n```');
  assert.deepEqual(c, { kind: 'openPeriod' });
  assert.equal(isActionChange(c), true);
});

test('the card, the note and the return\'s page count the same: countIssues and receiptWaits on the same books (#341, #342)', () => {
  const ws = tempWorkspace('open-period-same-');
  for (const today of ['2026-10-20', '2026-11-12', '2026-11-20']) {
    const s = periodState(ws, books as Books, [review], today);
    const c = countIssues(periodIssues(books, [], s.period.from, s.period.to, [], new Map(), today));
    assert.deepEqual(s.counts, c, `${today}: the state's counts are the return's page's`);
    const held = receiptWaits(books, [], today);
    assert.equal(s.waiting.length, s.unbooked.filter((t) => held.has(t.ref)).length, 'the held payments are receiptWaits');
    const line = openLines(s)[0];
    assert.deepEqual(line.kind === 'unbooked' && [line.n, line.waiting], [c.unbooked, c.waitingReceipt]);
    const note = periodNote(ws, books as Books, [review], 'de', today, s);
    assert.match(note, new RegExp(`Payments without a booking \\(${c.unbooked}\\)`));
    const k = waitingKinds(s);
    assert.equal(k.waits + k.asks + k.unread, c.waitingReceipt, 'the note\'s kinds add up to the page\'s «warten auf ihren Beleg»');
    assert.match(note, new RegExp(`Receipts without a payment \\(${c.unlinked}\\)`));
  }
});

test('nothing open in the period is never «nothing open» while payments of later open days are unbooked or tasks wait (#342)', () => {
  const ws = tempWorkspace('open-period-later-');
  // Q3 is booked through; October has a payment nobody booked.
  const later: Index = { ...books, transactions: [books.transactions[4], books.transactions[5]], receipts: [] };
  const s = periodState(ws, later as Books, [], '2026-11-12');
  assert.equal(nothingOpen(s), true, 'nothing of Q3');
  const e = elsewhereOf(later, [], [], [], s, 'quarter');
  assert.deepEqual(e.unbooked.map((t) => t.ref), ['OKT']);
  assert.equal(e.unbooked.length, unbookedOpen(later, []).unbooked, 'the payments UnbookedFact counts');
  assert.equal(elsewhereCount(e), 1);
  const note = openWork(ws, later as Books, [], 'de', '2026-11-12');
  assert.match(note, /Nothing of 2026-Q3 is open[^\n]*Other things wait for the person \(1[^\n]*1 payments of later open days without a booking among them\): never say that nothing is open\./);
  assert.doesNotMatch(note, /Nothing else waits/);
  assert.match(note, /Payments without a booking \(1\):\n- 03\.10\.2026 [^\n]*\(OKT\)/);
  // A stopped run waits too.
  const quiet: Index = { ...later, transactions: [books.transactions[4]] };
  const q = periodState(ws, quiet as Books, [], '2026-11-12');
  assert.equal(elsewhereCount(elsewhereOf(quiet, [], [], [], q, 'quarter')), 0);
  assert.equal(elsewhereCount(elsewhereOf(quiet, [], [], [], q, 'quarter', 1)), 1);
  assert.match(openWork(ws, quiet as Books, [], 'de', '2026-11-12', 1), /Runs of the workflows that stopped \(1\)/);
  assert.match(openWork(ws, quiet as Books, [], 'de', '2026-11-12'), /Nothing of 2026-Q3 is open[^\n]*no task\.\n/);
});
