/**
 * #476 (consulting-ai-r4-19): «Was muss ich jetzt noch machen?» was answered «Es wartet noch ein Vorschlag auf dich, und
 * sonst nichts im Q3 2026» while the return's list «Noch offen» named two points: the Akonto payment booked without the
 * employees' share and his own invoice not paid yet. The card and the AI's facts list what that list lists, in its
 * order (periodIssues, ISSUE_ORDER), and after it what only the card adds (a setup's proposal, a missing opening).
 * The tests read the facts handed over, never a model's wording.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import './support/jurisdiction.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { Books } from '../src/books/store.js';
import { nothingOpen, openLines, openPeriodState, type PendingOffer } from '../src/app/areas/automation/open-period.js';
import { ISSUE_ORDER, periodIssues } from '../src/app/areas/automation/period-issues.js';
import { elsewhereFor, periodNote } from '../src/server/open-work.js';
import { tempWorkspace } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const UID = 'CHE-123.456.789';
const tx = (ref: string, date: string, amount: number, counterparty: string, direction: 'DBIT' | 'CRDT' = 'DBIT'): BankTransaction => ({ ref, bank: 'ZKB', date, amount, currency: 'CHF', direction, counterparty, description: ref });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number): JournalEntry => ({ id: `${ref}-${debit}-${credit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, origin: 'classify' });
const own: Receipt = { id: 'own', filename: 'RE-2026-036.pdf', originalFilename: 'RE-2026-036.pdf', extractedText: `Kälin Advisory GmbH\nRechnung RE-2026-036\n${UID} MWST\nTotal CHF 7783.20`, extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-11-13T08:00:00Z', location: 'archived', currency: 'CHF', date: '2026-09-01', amount: 7783.2, description: 'Kälin Advisory GmbH, Rechnung RE-2026-036', vatId: UID } as Receipt;

/** The consultancy's Q3 after the drop: wages gross, the pension fund paid its share, the Akonto payment booked whole as the employer's. */
const MONTHS = [['W7', '2026-07-27'], ['W8', '2026-08-25'], ['W9', '2026-09-25']] as const;
const books = {
  config: { closedThrough: '2026-06-30' },
  transactions: [...MONTHS.map(([r, d]) => tx(r, d, 8602, 'Matthias Kälin')), tx('BVG', '2026-07-10', 1740, 'Vorsorgestiftung Zentralschweiz'), tx('AK', '2026-09-25', 4078.92, 'Ausgleichskasse Zug'), tx('A7', '2026-07-20', 84.35, 'Alpentel AG')],
  journalEntries: [
    ...MONTHS.flatMap(([r, d]) => [entry(r, d, '5000', '1020', 8602), entry(r, d, '5000', '2270', 898)]),
    entry('BVG', '2026-07-10', '2270', '1020', 870), entry('BVG', '2026-07-10', '5720', '1020', 870),
    entry('AK', '2026-09-25', '5700', '1020', 3708.42), entry('AK', '2026-09-25', '5710', '1020', 370.5),
    entry('A7', '2026-07-20', '6510', '1020', 84.35),
  ],
  receipts: [own],
  mappings: [...MONTHS.map(([r]) => r), 'BVG', 'AK', 'A7'].map((r) => ({ transactionRef: r, receiptId: 'none' })),
  bankStatements: [],
} as unknown as Index;
const accounts = [{ bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Zuger Kantonalbank CHF' }] as never;
const ctx = { today: '2026-11-13', vatRegistered: true, length: 'quarter' as const, dueDays: 60, firm: { uid: UID, name: 'Kälin Advisory GmbH' } };
const provider = { held: [], bills: [], payouts: {}, withheldPayees: ['AK'] };
const offer: PendingOffer = { ref: 'A7', date: '2026-07-20', name: 'Alpentel AG', percent: 50, account: '6510' };
/** The open list's kinds as the card names its lines. */
const LINE_OF = { question: 'questions', held: 'held', evidence: 'evidence', withheld: 'withheld', unbooked: 'unbooked', own: 'yours', unlinked: 'unlinked', bill: 'bills' } as const;

test('#476 the card lists what the open list lists, in its order: the Akonto payment, his own invoice, then the setup\'s proposal', () => {
  const issues = periodIssues(books, [], '2026-07-01', '2026-09-30', accounts, new Map(), '2026-11-13', new Map(), provider);
  assert.deepEqual(issues.map((i) => i.kind), ['withheld', 'unlinked'], 'the open list');
  const s = openPeriodState(books, [], [], accounts, ctx, new Map(), new Map(), provider, [offer]);
  assert.equal(nothingOpen(s), false);
  const lines = openLines(s);
  assert.deepEqual(lines.map((l) => l.kind), ['withheld', 'unlinked', 'offers']);
  const listed = lines.filter((l) => Object.values(LINE_OF).includes(l.kind as never));
  assert.deepEqual(listed.map((l) => l.kind), [...new Set(issues.map((i) => LINE_OF[i.kind]))], 'the same kinds in the same order');
  assert.equal(listed.reduce((n, l) => n + ('n' in l ? l.n : 0), 0), issues.length, 'each point of the list once');
  assert.deepEqual(ISSUE_ORDER.filter((k) => issues.some((i) => i.kind === k)), issues.map((i) => i.kind), 'the list is in ISSUE_ORDER');
});

test('#476 the AI is handed the same points in the same order: the Akonto payment with what 2270 still holds, his invoice, the proposal', () => {
  const ws = tempWorkspace('what-now-476-');
  roots.push(ws.paths.root);
  const s = openPeriodState(books, [], [], accounts, ctx, new Map(), new Map(), provider, [offer]);
  const note = periodNote(ws, books as Books, [], 'de', '2026-11-13', s, elsewhereFor(ws, books as Books, [], s, 0, '2026-11-13'));
  assert.match(note, /Contribution payments booked without the employees' share \(1\)[^\n]*\n- 25\.09\.2026 [^\n]*CHF 4'078\.92 \(AK\): account 2270 still holds CHF 1'824\.00/);
  assert.match(note, /Receipts without a payment \(1\)[^\n]*\n- «Kälin Advisory GmbH, Rechnung RE-2026-036» of 01\.09\.2026, CHF 7'783\.20: the firm's own invoice/);
  const at = (s: string) => note.indexOf(s);
  assert.ok(at('Contribution payments') < at('Receipts without a payment') && at('Receipts without a payment') < at('Proposals from the setup'), 'the open list\'s order, then the proposal');
  assert.doesNotMatch(note, /Nothing of Q3 2026 is open/);
});
