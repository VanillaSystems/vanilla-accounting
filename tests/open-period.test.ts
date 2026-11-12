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
import { nothingOpen, openLines, openPeriodState } from '../src/app/areas/automation/open-period.js';
import { periodIssues } from '../src/app/areas/automation/period-issues.js';
import { openWork, periodNote, purposeNow } from '../src/server/open-work.js';
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
  assert.deepEqual(openLines(s).map((l) => [l.kind, 'n' in l ? l.n : l.task.run, l.kind === 'unbooked' ? l.waiting : undefined]), [
    ['unbooked', 4, 2], ['questions', 1, undefined], ['unlinked', 1, undefined], ['task', 'r-1', undefined],
  ]);
  assert.equal(nothingOpen(s), false);
  const quiet = openPeriodState({ ...books, transactions: [books.transactions[4]], receipts: [] }, [], [], [], ctx);
  assert.equal(nothingOpen(quiet), true);
  assert.deepEqual(openLines(quiet), []);
});

test('the assistant\'s message names that state with its places and asks for the card, in every conversation that is not the setup', () => {
  const ws = tempWorkspace('open-period-');
  const note = periodNote(ws, books as Books, [review], 'de', '2026-11-12');
  assert.match(note, /^Where the oldest period not filed stands[^\n]*: 2026-Q3 \(01\.07\.2026 to 30\.09\.2026\); it is over; its return is due on 29\.11\.2026\./);
  assert.match(note, /- payments without a booking: 4 \(25\.07\.2026 [^\n]*CHF 5200\.00[^\n]*\); where: «Kontoauszüge»/);
  assert.match(note, /- of those, 2 the app holds until their receipt is linked/);
  assert.match(note, /- receipts without a payment: 1; where: «Belege»/);
  assert.match(note, /- tasks: «Abrechnung 2026-Q3 prüfen»; where: «Automatisierung › Aufgaben»/);
  assert.match(note, /never the setup's topics/);
  assert.match(note, /\{"kind":"openPeriod"\}/);
  assert.ok(openWork(ws, books as Books, [review], 'de', '2026-11-12').startsWith(note), 'what waits under Aufgaben follows the period\'s state in the same message');
  assert.match(periodNote(ws, { ...books, transactions: [books.transactions[4]], receipts: [] } as Books, [], 'de', '2026-08-01'), /it runs until 30\.09\.2026\.\nNothing of it is open/);
});

test('a setup the person ended carries no setup note: its conversation is answered like any other', () => {
  assert.equal(purposeNow('onboarding', {}), 'onboarding', 'while the setup runs, its conversation is the setup\'s');
  assert.equal(purposeNow('onboarding', { ready: '2026-11-12T09:00:00Z' }), undefined, 'after «Los geht\'s» it is an ordinary one: the books\' state, no checklist');
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
