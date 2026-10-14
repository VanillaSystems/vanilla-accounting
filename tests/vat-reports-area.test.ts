/**
 * MWST and Bilanz & ER (src/app/areas/vat/model.ts, src/app/areas/reports/model.ts): which return a
 * period shows and in what state, where a correction is declared, which Ziffern the list shows, and
 * how the reports arrange the app's figures, search across them and read one account's ledger.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import type { Index, JournalEntry } from '../src/types/index.js';
import { computeIncomeStatement } from '../src/accounting/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { filedDiff, formAmount, shownZiffern, vatKeyOf, vatReturn } from '../src/app/areas/vat/model.js';
import { NO_ACCOUNT, accountsOf, filterBlocks, ledgerOf, reportView, searchReport } from '../src/app/areas/reports/model.js';

const p = (token: string) => parsePeriod(token, '2026-10-11')!;
const je = (id: string, date: string, dr: string, cr: string, amount: number, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id, ...x });

const names = { '1020': 'Bank', '2200': 'Geschuldete MWST', '3200': 'Warenertrag', '4000': 'Materialaufwand', '6500': 'Büromaterial' };
const books: Index = {
  config: { closedThrough: '2026-06-30', openingBalances: { '2026': { '1020': 1000, '2800': 1000 } } },
  receipts: [], transactions: [], mappings: [], bankStatements: [],
  journalEntries: [
    je('sale', '2026-08-03', '1020', '3200', 1081, { vatCode: 'V81' }),
    je('paper', '2026-08-10', '6500', '1020', 108.1, { vatCode: 'I81' }),
    je('june', '2026-06-10', '6500', '1020', 54.05, { vatCode: 'I81' }),
    je('fix', '2026-09-30', '', '4000', 8.1, { vatCode: 'M81-2', corrects: '2026-Q2' }),
  ],
};

test('a period that is no ESTV period shows the open quarter; a quarter shows itself', () => {
  assert.equal(vatKeyOf(p('2026-09'), p('2026-Q3')), '2026-Q3');
  assert.equal(vatKeyOf(p('2026-Q2'), p('2026-Q3')), '2026-Q2');
  assert.equal(vatKeyOf(p('2026'), p('2026-Q3')), '2026');
});

test('a filed quarter is filed; an open one is due 60 days after its end; a year is an overview', () => {
  assert.deepEqual(vatReturn(books, '2026-Q2', '2026-10-11').state, { kind: 'filed' });
  assert.deepEqual(vatReturn(books, '2026-Q3', '2026-10-11').state, { kind: 'open', due: '2026-11-29', overdue: false });
  assert.deepEqual(vatReturn(books, '2026-Q3', '2026-12-01').state, { kind: 'open', due: '2026-11-29', overdue: true });
  assert.equal(vatReturn(books, '2026', '2026-10-11').state.kind, 'overview');
});

test('a correction dated in Q3 is declared in the quarter it corrects, not in its own', () => {
  const q2 = vatReturn(books, '2026-Q2'), q3 = vatReturn(books, '2026-Q3');
  assert.deepEqual(q2.corrections.map((e) => e.id), ['fix']);
  assert.deepEqual((q2.lines['400'] ?? []).map((l) => l.entry.id), ['fix']);
  assert.equal(q3.lines['400'], undefined);
  assert.deepEqual(q3.lines['405'].map((l) => l.entry.id), ['paper']);
});

test('the list shows 200, Ziffern with a figure, the sums and the one result that applies', () => {
  const q3 = vatReturn(books, '2026-Q3');
  const shown = shownZiffern(q3, undefined, false);
  assert.ok(shown.includes('200') && shown.includes('303') && shown.includes('405') && shown.includes('500'));
  assert.ok(!shown.includes('510'), 'no credit, no 510');
  assert.ok(!shown.includes('221'), 'an empty Ziffer is hidden');
  assert.ok(shownZiffern(q3, undefined, true).includes('221'), 'all shows it');
  assert.ok(shownZiffern(q3, { period: '2026-Q3', ziffern: { '221': 5 } }, false).includes('221'), 'a filed figure keeps it');
});

test('a rate row compares with the filed form as its turnover: with tax for supplies, net for Bezugsteuer', () => {
  const q3 = vatReturn({ ...books, journalEntries: [...books.journalEntries!, je('cloud', '2026-08-04', '6570', '1020', 100, { vatCode: 'B81-1' })] }, '2026-Q3');
  assert.equal(formAmount(q3, '303'), 1081);
  assert.equal(formAmount(q3, '383'), 100);
  assert.equal(filedDiff(q3, { period: '2026-Q3', ziffern: { '383': 100 } }, '383'), undefined);
  assert.equal(filedDiff(q3, { period: '2026-Q3', ziffern: { '303': 1081 } }, '303'), undefined);
  assert.equal(filedDiff(q3, { period: '2026-Q3', ziffern: { '303': 1000 } }, '303'), 1000);
});

test('the Erfolgsrechnung shows the app\'s figures, accounts with an amount only unless all', () => {
  const view = reportView('income', books, p('2026-Q3'), names, false);
  const app = computeIncomeStatement(books.journalEntries!, '2026-07-01', '2026-09-30', names);
  assert.equal(view.headline.value, app.netResult);
  assert.deepEqual(accountsOf(view), ['3200', '4000', '6500']);
  assert.ok(accountsOf(reportView('income', books, p('2026-Q4'), names, true)).includes('3200'), 'all accounts in an empty quarter');
  assert.deepEqual(accountsOf(reportView('income', books, p('2026-Q4'), names, false)), []);
});

test('the Bilanz counts the entries booked on one side when assets and liabilities differ', () => {
  const view = reportView('balance', books, p('2026-Q3'), names, false);
  assert.equal(view.asOf, '2026-09-30');
  assert.equal(view.gap?.oneSided, 1);
});

test('the Saldobilanz starts from the balance when the period begins and lists one-sided entries apart', () => {
  const view = reportView('trial', books, p('2026-Q3'), names, false);
  const groups = view.blocks.flatMap((b) => (b.kind === 'group' ? [b] : []));
  const bank = groups.flatMap((g) => g.rows).find((r) => r.account === '1020')!;
  assert.equal(bank.open, 1000 - 54.05);
  assert.equal(groups.at(-1)?.title, NO_ACCOUNT);
  assert.deepEqual(groups.at(-1)?.rows.map((r) => r.account), [NO_ACCOUNT]);
});

test('a search finds an account in the report that holds it and narrows the list to it', () => {
  assert.equal(searchReport('income', 'bank', names, 'nur MWST'), 'balance');
  assert.equal(searchReport('income', 'büro', names, 'nur MWST'), 'income');
  assert.equal(searchReport('trial', 'bank', names, 'nur MWST'), 'trial');
  const found = filterBlocks(reportView('income', books, p('2026-Q3'), names, true), '6500', names, 'nur MWST');
  assert.deepEqual(accountsOf(found), ['6500']);
});

test('an account\'s ledger: opening, newest first, each entry with its counter account', () => {
  const l = ledgerOf(books, '1020', p('2026-Q3'));
  assert.equal(l.opening, 1000 - 54.05);
  assert.deepEqual(l.rows.map((r) => [r.entryId, r.other]), [['paper', '6500'], ['sale', '3200']]);
  assert.equal(l.closing, Math.round((1000 - 54.05 + 1081 - 108.1) * 100) / 100);
  assert.deepEqual([l.debit, l.credit], [1081, 108.1]);
});
