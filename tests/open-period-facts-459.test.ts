/**
 * #459 (webshop-ai-r3-10): the facts the sidebar's AI is handed about statements and a provider's reports carry
 * their days and states. Books whose statements begin on 01.07. never hand over the bank's balance of that day as
 * the balance of 1.1., and a report read and booked is named as such with its days, never as one not read yet.
 * The tests read the facts handed over, never a model's wording. Invented shop.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import './support/jurisdiction.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { Books } from '../src/books/store.js';
import { openPeriodState } from '../src/app/areas/automation/open-period.js';
import { elsewhereFor, periodNote } from '../src/server/open-work.js';
import { missingOpenings } from '../src/accounting/opening-balance.js';
import { tempWorkspace } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const tx = (ref: string, date: string, amount: number, direction: 'DBIT' | 'CRDT'): BankTransaction => ({ ref, bank: 'LUKB', date, amount, currency: 'CHF', direction, description: ref });
const entry = (id: string, date: string, debit: string, credit: string, amount: number, receipts?: string[]): JournalEntry => ({ id, transactionRef: id, date, accountDebit: debit, accountCredit: credit, amount, origin: 'classify', ...(receipts ? { receipts } : {}) });
const report = (id: string, kind: 'sales' | 'fees'): Receipt => ({
  id, filename: `${id}.csv`, originalFilename: `${id}.csv`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 900, indexedAt: '2026-10-02T08:00:00Z', location: 'archived', kind: 'sales-record',
  report: { provider: 'shop', kind, from: '2026-07-01', to: '2026-09-30', rows: 3 },
} as Receipt);

/** A shop whose statements begin on 01.07.2026: the bank held 21'460.25 then; the first half year is in no statement here. Both reports read and booked; 1093 opened at nothing. */
const books = {
  config: { closedThrough: '2026-06-30' },
  transactions: [tx('P1', '2026-07-01', 1200, 'CRDT'), tx('R1', '2026-07-02', 2000, 'DBIT')],
  statementBalances: [{ account: '1020', bank: 'LUKB', currency: 'CHF', date: '2026-09-30', amount: 20660.25, source: 'camt', sourceFile: 'q3.xml' }],
  journalEntries: [
    entry('P1', '2026-07-01', '1020', '1093', 1200), entry('R1', '2026-07-02', '6000', '1020', 2000),
    entry('SR-shop-1', '2026-07-05', '1093', '3200', 500, ['sales']), entry('SR-shop-2', '2026-08-05', '1093', '3200', 520, ['sales']),
    entry('SF-shop-1', '2026-07-05', '6580', '1093', 9, ['fees']),
  ],
  receipts: [report('sales', 'sales'), report('fees', 'fees')],
  mappings: [], bankStatements: [],
} as unknown as Index;
const accounts = [{ bank: 'LUKB', currency: 'CHF', account: '1020', label: 'Luzerner Kantonalbank CHF' }] as never;
const ctx = { today: '2026-11-13', vatRegistered: true, length: 'quarter' as const, dueDays: 60 };
const provider = { held: [], bills: [], payouts: {}, clearing: [{ provider: 'shop', name: 'Shop', account: '1093' }] };

test('#459 a missing opening is the balance before the first payment, on its day; statements that begin in July never say 1.1.', () => {
  assert.deepEqual(missingOpenings(books, accounts, '2026').map((o) => [o.account, o.amount, o.from]), [['1020', 21460.25, '2026-07-01']]);
  const ws = tempWorkspace('facts-459-');
  roots.push(ws.paths.root);
  const s = openPeriodState(books, [], [], accounts, ctx, new Map(), new Map(), provider);
  const note = periodNote(ws, books as Books, [], 'de', '2026-11-13', s, elsewhereFor(ws, books as Books, [], s, 0, '2026-11-13'));
  assert.match(note, /- Luzerner Kantonalbank CHF \(1020\): CHF 21'460\.25 before its first payment in these books, on 01\.07\.2026, as its statements imply\. The statements in these books begin then: what the account held on 1\.1\.2026 they do not say/);
  assert.doesNotMatch(note, /21'460\.25 on 1\.1\.2026/, 'the balance of 01.07. is never handed over as the one of 1.1.');
});

test('#459 a clearing account below zero names its provider\'s reports with their days and bookings, and its missing opening; never «a sales report not dropped yet»', () => {
  const ws = tempWorkspace('facts-459-');
  roots.push(ws.paths.root);
  const s = openPeriodState(books, [], [], accounts, ctx, new Map(), new Map(), provider);
  assert.deepEqual(s.clearing, [{ name: 'Shop', account: '1093', balance: -189, opened: false, reports: [
    { kind: 'fees', from: '2026-07-01', to: '2026-09-30', booked: 1, held: 0 }, { kind: 'sales', from: '2026-07-01', to: '2026-09-30', booked: 2, held: 0 },
  ] }]);
  const note = periodNote(ws, books as Books, [], 'de', '2026-11-13', s, elsewhereFor(ws, books as Books, [], s, 0, '2026-11-13'));
  assert.match(note, /- 1093 Shop: CHF -189\.00; its reports in the books, each read: «Gebührenbericht» 01\.07\.2026 to 30\.09\.2026, 1 bookings made; «Verkaufsbericht» 01\.07\.2026 to 30\.09\.2026, 2 bookings made; no opening balance of 1\.1\.2026 is entered for it/);
  assert.doesNotMatch(note, /not dropped yet/);
  // Without a report in the books, that is said as a fact.
  const none = openPeriodState({ ...books, receipts: [] }, [], [], accounts, ctx, new Map(), new Map(), provider);
  assert.match(periodNote(ws, { ...books, receipts: [] } as Books, [], 'de', '2026-11-13', none, elsewhereFor(ws, books as Books, [], none, 0, '2026-11-13')), /- 1093 Shop: CHF -189\.00; no report of it is in the books yet;/);
});
