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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { filingStage } from '../src/app/automation/home.js';
import { join } from 'node:path';
import { ITEMS_SHOWN, TASKS_SHOWN, elsewhereCount, elsewhereOf, nothingOpen, openLines, openPeriodState, waitingKinds } from '../src/app/areas/automation/open-period.js';
import { countIssues, periodIssues, receiptWaits, unbookedOpen } from '../src/app/areas/automation/period-issues.js';
import { openWork, periodNote, periodState, purposeNow } from '../src/server/open-work.js';
import { leavesSetup, newThread } from '../src/app/assistant/thread.js';
import { changesIn } from '../src/assistant/changes.js';
import { isActionChange } from '../src/types/assistant.js';
import { tempWorkspace } from './support/workspace.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';

const say = (key: string, vars: Record<string, string | number> = {}) => formatIn({ code: 'de', ...de }, key as never, vars);

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
    // Most important first (#428): an open VAT question withholds the approval.
    ['questions', 1, undefined], ['unbooked', 4, 2], ['unlinked', 1, undefined], ['task', 'r-1', undefined],
  ]);
  assert.deepEqual(waitingKinds(s), { waits: 2, asks: 0, unread: 0, outlays: 0 }, 'until two weeks before the 29.11. the missing receipts are the app\'s work');
  assert.deepEqual(waitingKinds(openPeriodState(books, [], [], [], { ...ctx, today: '2026-11-20' })), { waits: 0, asks: 2, unread: 0, outlays: 0 }, 'from then on they are the person\'s');
  assert.equal(nothingOpen(s), false);
  const quiet = openPeriodState({ ...books, transactions: [books.transactions[4]], receipts: [] }, [], [], [], ctx);
  assert.equal(nothingOpen(quiet), true);
  assert.deepEqual(openLines(quiet), []);
});

test('the assistant\'s message names that state with its places and asks for the card, in every conversation that is not the setup', () => {
  const ws = tempWorkspace('open-period-');
  const note = periodNote(ws, books as Books, [review], 'de', '2026-11-12');
  assert.match(note, /^Where the oldest period not filed stands[^\n]*: Q3 2026 \(01\.07\.2026 to 30\.09\.2026\); it is over; its return is due on 29\.11\.2026\./);
  assert.match(note, /Payments without a booking \(4\), under «Kontoauszüge»:\n- 25\.07\.2026 [^\n]*CHF 5.200\.00 \(LOHN\)/);
  assert.match(note, /Of them, 2 the app holds until their receipt is linked: it books them itself then and nobody is asked yet/);
  assert.doesNotMatch(note, /their return is near|could not be read/, 'only the kinds that occur are named');
  assert.match(periodNote(ws, books as Books, [review], 'de', '2026-11-20'), /Of them, 2 wait for their receipt and their return is near: each is the person's task under «Automatisierung › Aufgaben» now/);
  assert.match(note, /Receipts without a payment \(1\), under «Belege»:\n- «lonely\.pdf» of 03\.09\.2026/);
  assert.match(note, /Tasks of the workflows \(1\), under «Automatisierung › Aufgaben»[^\n]*:\n- «Abrechnung 2026-Q3 prüfen» on the period 2026-Q3/);
  assert.match(note, /never the setup's topics/);
  assert.match(note, /\{"kind":"openPeriod"\}/);
  assert.ok(openWork(ws, books as Books, [review], 'de', '2026-11-12').startsWith(note), 'what waits under Aufgaben follows the period\'s state in the same message');
  assert.match(periodNote(ws, { ...books, transactions: [books.transactions[4]], receipts: [] } as Books, [], 'de', '2026-08-01'), /it runs until 30\.09\.2026\.[^\n]*\nNothing of Q3 2026 is open/);
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
  assert.match(rest, /^ for the person under «Automatisierung › Aufgaben» now, outside Q3 2026/);
  assert.match(rest, /Payments without a booking \(2\):\n- 03\.10\.2026 [^\n]*\(OKT\)\n- 03\.11\.2026 [^\n]*\(NOV\)/);
  for (const ref of ['LOHN', 'AHV', 'FARBMIX', 'SWISSCOM']) assert.equal(note.split(`(${ref})`).length - 1, 1, `${ref} is named once`);
  assert.doesNotMatch(rest, /lonely|Open questions/, 'nothing of the period is repeated, and what there is none of is left out');
  const quiet = openWork(ws, { ...books, transactions: [books.transactions[4]], receipts: [] } as Books, [], 'de', '2026-08-01');
  assert.match(quiet, /Nothing of Q3 2026 is open[^\n]*\n[^\n]*\n\nWhat else waits[^\n]*\nNothing else waits:/);
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
  assert.deepEqual(waitingKinds(s), { waits: 1, asks: 0, unread: 1, outlays: 0 });
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
  assert.match(note, /Nothing of Q3 2026 is open[^\n]*Other things wait for the person \(1[^\n]*1 payments of later open days without a booking among them\): never say that nothing is open\./);
  assert.doesNotMatch(note, /Nothing else waits/);
  assert.match(note, /Payments without a booking \(1\):\n- 03\.10\.2026 [^\n]*\(OKT\)/);
  // A stopped run waits too.
  const quiet: Index = { ...later, transactions: [books.transactions[4]] };
  const q = periodState(ws, quiet as Books, [], '2026-11-12');
  assert.equal(elsewhereCount(elsewhereOf(quiet, [], [], [], q, 'quarter')), 0);
  assert.equal(elsewhereCount(elsewhereOf(quiet, [], [], [], q, 'quarter', 1)), 1);
  assert.match(openWork(ws, quiet as Books, [], 'de', '2026-11-12', 1), /Runs of the workflows that stopped \(1\)/);
  assert.match(openWork(ws, quiet as Books, [], 'de', '2026-11-12'), /Nothing of Q3 2026 is open[^\n]*no task\.\n/);
});

test('a period that ended before the books begin is «vor Beginn dieser Bücher» on the card and in the note, never due or overdue (#345, #342)', () => {
  // Opening balances of 2026 and the first payment in October: the books' open period is Q4, so the state names Q4; Q3 is before them.
  const later: Index = { ...books, config: {}, transactions: [tx('OKT', '2026-10-03', 12)], journalEntries: [], receipts: [] };
  const ws = tempWorkspace('open-period-before-');
  assert.equal(periodState(ws, later as Books, [], '2026-11-12').period.token, '2026-Q4', 'the open period starts with the first payment');
  // A state whose period ended before anything is dated: books with nothing dated, asked in a later quarter.
  const empty: Index = { ...books, config: {}, transactions: [], journalEntries: [], receipts: [] };
  const s = openPeriodState(empty, [], [], [], { ...ctx, today: '2026-11-12' });
  assert.equal(s.period.token, '2026-Q4');
  const past = { ...s, period: { ...s.period, token: '2026-Q3', from: '2026-07-01', to: '2026-09-30' } };
  assert.deepEqual(filingStage(empty, past.period, { ...ctx, today: '2027-01-20' }), { kind: 'before' });
  const before = { ...past, filing: { kind: 'before' as const } };
  const note = periodNote(ws, empty as Books, [], 'de', '2027-01-20', before);
  assert.match(note, /Q3 2026 \(01\.07\.2026 to 30\.09\.2026\); it ended before anything in these books is dated[^\n]*never call it due or overdue\./);
  assert.doesNotMatch(note, /was due on|is due on/);
  const card = readFileSync('src/app/assistant/OpenPeriodCard.tsx', 'utf8');
  assert.match(card, /if \(f\.kind === 'before'\) return t\('automation\.home\.s\.before'\);/, 'the card says «vor Beginn dieser Bücher»');
  assert.match(card, /s\.filing\.kind === 'due' \? link\(openList/, 'only a due return links to its list');
});

test('a firm not registered whose turnover passed the threshold has that task under Aufgaben: nothing else is «nothing open» (#342)', () => {
  const big: Index = { ...books, config: {}, transactions: [books.transactions[4]], receipts: [], journalEntries: [{ ...books.journalEntries![0], amount: 120000, vatCode: undefined }] };
  const s = openPeriodState(big, [], [], [], ctx);
  assert.equal(nothingOpen(s), true);
  assert.deepEqual(elsewhereOf(big, [], [], [], s, 'quarter', 0, false, '2026-11-12').threshold, ['2026'], 'not registered: the threshold task');
  assert.equal(elsewhereCount(elsewhereOf(big, [], [], [], s, 'quarter', 0, false, '2026-11-12')), 1);
  assert.deepEqual(elsewhereOf(big, [], [], [], s, 'quarter', 0, true, '2026-11-12').threshold, [], 'a registered firm has none');
  assert.deepEqual(elsewhereOf(big, [], [], [], s, 'quarter', 0, undefined, '2026-11-12').threshold, [], 'unknown, as Aufgaben reads it: none');
});

test('«was muss ich noch machen?»: the till slip without its date is named with what it lacks, every item is a link, and the period is said as a person says it (#398)', async () => {
  const { itemsOf } = await import('../src/app/assistant/open-period-items.js');
  const slip = { ...receipt('slip', '2026-01-01'), date: undefined, description: 'Baucenter', extractedText: 'Baucenter Kasse Total 187.35', amount: 187.35 } as unknown as Receipt;
  const withSlip: Index = { ...books, receipts: [...books.receipts, slip] };
  const s = openPeriodState(withSlip, [], [], [], ctx);
  assert.deepEqual(s.yours.map((x) => [x.receipt.id, x.lacks]), [['slip', ['date']]], 'Belege\'s «braucht dich» without a date is the period\'s, as Belege places it');
  const lines = openLines(s);
  assert.equal(lines[0].kind, 'yours', 'what only she can say comes first');
  const card = lines.map((l) => itemsOf(l, s, withSlip, say));
  assert.match(card[0].items[0].text, /^Baucenter · CHF 187.35 · Datum fehlt$/);
  assert.deepEqual(card[0].items[0].go.route, { area: 'receipts', id: 'slip' }, 'the slip links to its receipt');
  const unbooked = card[lines.findIndex((l) => l.kind === 'unbooked')];
  assert.deepEqual(unbooked.items.map((x) => x.key), ['LOHN', 'AHV', 'FARBMIX', 'SWISSCOM'], 'the four payments are named one by one');
  assert.match(unbooked.items[0].text, /^25\.07\.2026 · LOHN · CHF 5.200\.00$/, 'day, who and how much, in the app\'s money format');
  assert.ok(unbooked.items.every((x) => x.go.route.area === 'bank'), 'each payment links to itself');
  const unlinked = card[lines.findIndex((l) => l.kind === 'unlinked')];
  assert.deepEqual(unlinked.items.map((x) => x.key), ['lonely'], 'the slip is not named again among the receipts without a payment');
  const note = periodNote(tempWorkspace('open-period-398-'), withSlip as Books, [], 'de', '2026-11-12');
  assert.match(note, /: Q3 2026 \(01\.07\.2026 to 30\.09\.2026\)/);
  assert.equal(note.split('2026-Q3').length - 1, 1, 'the token only in the line that says never to use it');
  assert.match(note, /Receipts that wait for the person's own word \(1\), under «Belege»[^\n]*\n- «Baucenter», CHF 187.35: «Datum fehlt»/);
  assert.match(note, /at most one short sentence[^\n]*never a count, never a list of the items/);
});

test('a receipt that waits for her word is one issue of the period for the card, the note and the MWST page\'s list alike; a receipt a run still reads is not hers; reading and copy are lacks of their own (#398 review)', () => {
  const slip = { ...receipt('slip', '2026-01-01'), date: undefined, description: 'Baucenter', extractedText: 'Baucenter Kasse Total 187.35', amount: 187.35 } as unknown as Receipt;
  const photo = { ...receipt('photo', '2026-01-01'), date: undefined, amount: undefined, extractedText: '', description: undefined } as unknown as Receipt;
  const copyText = 'Farbmix AG Rechnung FM-77812 Total CHF 1243.55';
  const twin = (id: string, file: string) => ({ ...receipt(id, '2026-09-10'), filename: file, extractedText: copyText, amount: 1243.55, description: 'Farbmix AG, Rechnung FM-77812' }) as Receipt;
  const withAll: Index = { ...books, receipts: [...books.receipts, slip, photo, twin('fm', 'fm-77812.pdf'), twin('img', 'img-4801.jpg')] };
  const issues = periodIssues(withAll, [], '2026-07-01', '2026-09-30', [], new Map(), '2026-11-12');
  const own = issues.flatMap((i) => (i.kind === 'own' ? [[i.receipt.id, i.lacks]] : []));
  assert.deepEqual(own.sort(), [['img', ['copy']], ['photo', ['reading']], ['slip', ['date']]], 'the undated slip, the unread photo and the second download');
  const c = countIssues(issues);
  assert.equal(c.own, 3, 'the MWST page\'s count holds them');
  assert.ok(!issues.some((i) => i.kind === 'unlinked' && ['slip', 'photo', 'img'].includes(i.receipt.id)), 'each receipt once');
  const s = openPeriodState(withAll, [], [], [], ctx);
  assert.deepEqual(s.yours.map((x) => x.receipt.id).sort(), ['img', 'photo', 'slip'], 'the card shows what the list shows');
  assert.equal(s.counts.own, 3);
  const reading = new Map([['photo', { kind: 'running' as const, run: 'r1', step: 'read' }]]);
  assert.ok(!openPeriodState(withAll, [], [], [], ctx, new Map(), reading).yours.some((x) => x.receipt.id === 'photo'), 'a receipt a run reads now is not hers yet');
  assert.ok(!periodIssues(withAll, [], '2026-07-01', '2026-09-30', [], new Map(), '2026-11-12', reading).some((i) => i.kind === 'own' && i.receipt.id === 'photo'));
});

test('a till slip that lacks its date and has a payment that may fit says both on its one line, card and note alike (#398 with #397)', async () => {
  const { itemsOf } = await import('../src/app/assistant/open-period-items.js');
  const slip = { ...receipt('slip', '2026-01-01'), date: undefined, description: 'Baucenter Gossau', extractedText: 'BAUCENTER Gossau\nTotal CHF 187.35', amount: 187.35 } as unknown as Receipt;
  const bau = tx('BAU', '2026-09-09', 187.35, { ...waits, counterparty: 'Baucenter Gossau', description: 'Karte Baucenter Gossau' });
  const b: Index = { ...books, transactions: [...books.transactions, bau], receipts: [...books.receipts, slip] };
  const s = openPeriodState(b, [], [], [], ctx);
  const lines = openLines(s);
  const mine = itemsOf(lines.find((l) => l.kind === 'yours')!, s, b, say).items[0].text;
  assert.match(mine, /Datum fehlt · Passt vielleicht zur Zahlung 09\.09\.2026 [^·]*CHF 187\.35$/, `both said: «${mine}»`);
  assert.equal(mine.split('Passt vielleicht').length - 1, 1, 'the offer once');
  const note = periodNote(tempWorkspace('open-period-near-'), b as Books, [], 'de', '2026-11-12');
  assert.match(note, /«Baucenter Gossau»[^\n]*«Datum fehlt»; a payment may fit it, offered on the receipt with one click: 09\.09\.2026 [^\n]*\(BAU\)/);
});

test('a long list on the card names the first ITEMS_SHOWN and counts the rest, with the way to all of them (#398)', async () => {
  const { itemsOf } = await import('../src/app/assistant/open-period-items.js');
  const many: Index = { ...books, transactions: [...books.transactions, ...Array.from({ length: 8 }, (_, i) => tx(`X${i}`, `2026-09-1${i}`, 10 + i))] };
  const s = openPeriodState(many, [], [], [], ctx);
  const line = openLines(s).find((l) => l.kind === 'unbooked')!;
  const it = itemsOf(line, s, many, say);
  assert.equal(it.items.length, ITEMS_SHOWN);
  assert.equal(it.more, s.unbooked.length - ITEMS_SHOWN);
  assert.ok(it.all, 'the rest has its link');
});
