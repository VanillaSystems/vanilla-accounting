/**
 * MWST and Bilanz & ER (src/app/areas/vat/model.ts, src/app/areas/reports/model.ts): which return a
 * period shows and in what state, where a correction is declared, which Ziffern the list shows, and
 * how the reports arrange the app's figures, search across them and read one account's ledger.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Index, JournalEntry } from '../src/types/index.js';
import { computeIncomeStatement, statementPostings } from '../src/accounting/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { filedDiff, formAmount, shownZiffern, vatKeyOf, vatReturn } from '../src/app/areas/vat/model.js';
import { headline } from '../src/app/areas/vat/model.js';
import { NO_ACCOUNT, accountsOf, filterBlocks, ledgerOf, reportView, searchReport } from '../src/app/areas/reports/model.js';
import { vatInFigures } from '../src/accounting/vat-in-figures.js';
import { tableOf } from '../src/export/tables.js';

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

test('a filed quarter leads with the filed figure, today\'s figure beside it when a correction changed it; an open quarter with today\'s (r6f-26)', () => {
  const filed = { period: '2026-Q2' as const, ziffern: { '500': 0, '510': 4.05 } };
  const q2 = vatReturn(books, '2026-Q2', '2026-10-11');
  assert.deepEqual(headline(q2, filed, books), { kind: 'credit', amount: 4.05, filed: true, corrected: { kind: 'credit', amount: 12.15, diff: -8.1 } }, 'the filed 4.05 stays the headline; the 8.10 correction shows beside it');
  assert.deepEqual(headline(q2, { period: '2026-Q2', ziffern: { '500': 0, '510': 12.15 } }, books), { kind: 'credit', amount: 12.15, filed: true }, 'nothing beside it when the books match the filed return');
  const q3 = vatReturn(books, '2026-Q3', '2026-10-11');
  assert.deepEqual(headline(q3, undefined, books), { kind: 'toPay', amount: 81 - 8.1, filed: false });
});

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
  assert.deepEqual(vatReturn(books, '2026-Q4', '2026-10-11').state, { kind: 'running', ends: '2026-12-31', from: '2027-01-01' }, 'a quarter still running is no return yet (r6f-33)');
  assert.deepEqual(vatReturn(books, '2026-Q4', '2026-12-31').state, { kind: 'running', ends: '2026-12-31', from: '2027-01-01' }, 'on its last day too');
  assert.equal(vatReturn(books, '2026-Q4', '2027-01-01').state.kind, 'open', 'from the day after');
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
  const app = computeIncomeStatement(statementPostings(books.journalEntries!, Object.keys(names)), '2026-07-01', '2026-09-30', names);
  assert.equal(view.headline.value, app.netResult);
  assert.deepEqual(accountsOf(view), ['3200', '4000', '6500']);
  assert.ok(accountsOf(reportView('income', books, p('2026-Q4'), names, true)).includes('3200'), 'all accounts in an empty quarter');
  assert.deepEqual(accountsOf(reportView('income', books, p('2026-Q4'), names, false)), []);
});

test('the Bilanz names why assets and liabilities differ: an account missing from the chart; a tax correction booked on one side is balanced by its tax posting', () => {
  const view = reportView('balance', books, p('2026-Q3'), names, false);
  assert.equal(view.asOf, '2026-09-30');
  assert.deepEqual(view.gap?.causes, [{ code: 'notInChart', account: '2800', amount: 1000 }]);
  const oneSided: Index = { ...books, journalEntries: [je('half', '2026-09-30', '', '4000', 8.1)] };
  assert.deepEqual(reportView('balance', oneSided, p('2026-Q3'), names, false).gap?.causes[0], { code: 'oneLeg', entryIds: ['half'], amount: -8.1 }, 'without a code nothing balances it');
});

test('an opening booked against 9100 (treuhaender-30): the Bilanz names the account, not entries without a counter account', () => {
  const fresh: Index = { ...books, config: {}, journalEntries: [je('open', '2026-07-01', '1020', '9100', 18420.15)] };
  const view = reportView('balance', fresh, p('2026'), { ...names, 9100: 'Eröffnungsbilanz' }, false);
  assert.equal(view.gap?.value, 18420.15);
  assert.deepEqual(view.gap?.causes, [{ code: 'outsideStatements', account: '9100', amount: -18420.15 }]);
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
  const l = ledgerOf(books, '1020', p('2026-Q3'), names);
  assert.equal(l.opening, 1000 - 54.05);
  assert.deepEqual(l.rows.map((r) => [r.entryId, r.other]), [['paper', '6500'], ['sale', '3200']]);
  const revenue = ledgerOf(books, '3200', p('2026-Q3'), names);
  assert.deepEqual(revenue.rows.map((r) => [r.entryId, r.other, r.debit, r.credit, r.derived, r.entry?.id]), [['vat:sale', '2200', 81, null, true, 'sale'], ['sale', '1020', null, 1081, false, 'sale']], 'the sale\'s tax leaves revenue for the VAT account, linked to the sale');
  assert.equal(revenue.closing, 1000);
  assert.equal(l.closing, Math.round((1000 - 54.05 + 1081 - 108.1) * 100) / 100);
  assert.deepEqual([l.debit, l.credit], [1081, 108.1]);
});

test('Bilanz & ER are net of VAT: revenue and expense without the tax, the tax on the VAT account, a line that says so; the exports carry it as their note (decision 16.10.2026)', () => {
  // August: a sale of 1081 gross (81 owed), paper for 108.10 gross (8.10 input tax).
  assert.deepEqual(vatInFigures(books.journalEntries!, '2026-08-01', '2026-08-31'), { owed: 81, input: 8.1, acquisition: 0, net: 72.9 });
  assert.equal(vatInFigures(books.journalEntries!, '2026-01-01', '2026-01-31'), undefined, 'no coded entry');
  const income = reportView('income', books, p('2026-08'), names, false);
  assert.deepEqual(income.vat, { shown: 'net', account: '2200' });
  assert.equal(income.headline.value, 1000 - 100, 'sale and paper net of their tax');
  assert.equal(reportView('income', books, p('2026-01'), names, false).vat, undefined, 'no coded entry: no line');
  const balance = reportView('balance', books, p('2026-08'), names, false);
  assert.deepEqual(balance.vat, { shown: 'net', account: '2200' });
  const owed = balance.blocks.flatMap((b) => (b.kind === 'group' ? b.rows : [])).find((r) => r.account === '2200');
  assert.equal(owed?.value, 68.85, 'the year\'s tax up to its day sits on 2200: 81 owed, 8.10 and 4.05 deducted');
  assert.equal(reportView('trial', books, p('2026-08'), names, false).vat, undefined);
  const words = { t: (key: string, vars?: Record<string, string | number>) => `${key}${vars ? ' ' + JSON.stringify(vars) : ''}`, accountingName: (g: string) => g };
  const tb = tableOf('income', { books, period: p('2026-08'), names, words: words as never, filed: {}, filingLength: 'quarter' });
  assert.ok(!tb.rows.some((r) => String(r[0]).startsWith('reports.vatRow')), 'no «VAT held in these figures» row');
  assert.equal(tb.note, 'reports.vatMetaNet {"account":"2200"}');
  const trial = tableOf('trial', { books, period: p('2026-08'), names, words: words as never, filed: {}, filingLength: 'quarter' });
  assert.equal(trial.note, undefined);
});

test('the open quarter leads with the figure the return will carry (tax on each rate\'s total), and says when the Ziffern from the entries differ by a Rappen (r9c-13)', () => {
  const two: Index = {
    ...books,
    journalEntries: [je('a', '2026-08-03', '1020', '3200', 10.05, { vatCode: 'V81' }), je('b', '2026-08-04', '1020', '3200', 10.05, { vatCode: 'V81' })],
  };
  const q3 = vatReturn(two, '2026-Q3', '2026-10-11');
  assert.equal(q3.report.toPay, 1.51, 'the page of a filing period shows the return (r9n-28): tax on the rate total, not 0.75 + 0.75');
  assert.deepEqual(headline(q3, undefined, two), { kind: 'toPay', amount: 1.51, filed: false }, 'the return: 8.1 % of 20.10 = 1.51, as the approval card and the XML say; the page shows the same Ziffern, so no rounding note');
  assert.deepEqual(headline(vatReturn(books, '2026-Q3', '2026-10-11'), undefined, books), { kind: 'toPay', amount: 81 - 8.1, filed: false }, 'no note when the figures agree');
});

test('a period that ended before anything in the books is dated says what the books hold, not «fällig seit», and its return can still be prepared (#345)', async () => {
  // The tester's books: Q1 and Q2 filed elsewhere, the first statement read in is the summer's; nothing is closed here.
  const fresh: Index = { ...books, config: {}, journalEntries: [], transactions: [{ id: 't1', date: '2026-07-03' } as unknown as Index['transactions'][number]] };
  const q1 = vatReturn(fresh, '2026-Q1', '2026-11-12').state;
  assert.deepEqual(q1, { kind: 'open', due: '2026-05-30', overdue: true, before: { first: '2026-07-03' } });
  // «Abrechnung erstellen» is drawn for `open` (vat.tsx): a firm with its first payment in April owes a nil return for Q1 and can make it.
  assert.equal(q1.kind, 'open', 'the return can be prepared');
  assert.deepEqual(vatReturn(fresh, '2026-Q3', '2026-11-12').state, { kind: 'open', due: '2026-11-29', overdue: false }, 'the quarter of the first payment is as before');
  assert.deepEqual(vatReturn({ ...fresh, transactions: [] }, '2026-Q3', '2026-11-12').state, { kind: 'open', due: '2026-11-29', overdue: false, before: {} }, 'books with nothing dated');
  const byHand: Index = { ...fresh, transactions: [], journalEntries: [je('sale', '2026-05-03', '1020', '3200', 1081, { vatCode: 'V81' })] };
  assert.equal('before' in vatReturn(byHand, '2026-Q2', '2026-11-12').state, false, 'a booking by hand dates the books too');
  assert.ok('before' in vatReturn(byHand, '2026-Q1', '2026-11-12').state);
  const de = (await import('../src/app/i18n/locales/de.js')).default.messages as unknown as Record<string, string>;
  assert.equal(de['vat.stateBefore'], 'Keine Zahlungen oder Buchungen in dieser Periode · die Bücher beginnen am {date}');
  assert.equal(de['vat.stateBeforeEmpty'], 'Keine Zahlungen oder Buchungen in dieser Periode');
  // The page: the sentence without the warning colour, and the period's buttons kept.
  const page = readFileSync('src/app/areas/vat/vat.tsx', 'utf8');
  assert.match(page, /v\.state\.kind === 'open' \? <WorkflowButtons kind="period"/, 'the buttons are drawn for every open period, a `before` one too');
  assert.match(page, /v\.state\.kind === 'open' && v\.state\.before \? \(\s*<span data-testid="period-before">/, 'the sentence stands in place of «fällig seit», plain');
});

test('one answer to «before the books begin»: the return, Automatisierung and the link to an earlier return agree (#345)', async () => {
  const { beforeBooks, booksOpenPeriod, derivePeriod } = await import('../src/accounting/periods.js');
  const { filingStage } = await import('../src/app/automation/home.js');
  const { resultSentence, sentenceState } = await import('../src/app/areas/vat/model.js');
  const today = '2027-01-20';
  const ctx = { today, vatRegistered: true, dueDays: 60 };
  const tx = (date: string) => ({ id: date, ref: date, date } as unknown as Index['transactions'][number]);
  const cases: Array<[string, Index]> = [
    ['first payment in July', { ...books, config: {}, journalEntries: [], transactions: [tx('2026-07-03')] }],
    ['a booking by hand in May', { ...books, config: {}, transactions: [], journalEntries: [je('sale', '2026-05-03', '1020', '3200', 1081, { vatCode: 'V81' })] }],
    ['a payment of December before the year of the opening balances', { ...books, config: { openingBalances: { '2026': { '1020': 1 } } }, journalEntries: [], transactions: [tx('2025-12-30'), tx('2026-08-01')] }],
    ['filed through March, first payment in July', { ...books, config: { closedThrough: '2026-03-31' }, journalEntries: [], transactions: [tx('2026-07-03')] }],
    ['nothing dated', { ...books, config: {}, journalEntries: [], transactions: [] }],
  ];
  for (const [name, b] of cases) {
    const open = booksOpenPeriod(b, today, 'quarter');
    for (const key of ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']) {
      const to = derivePeriod(key)!.to;
      const before = beforeBooks(b, to);
      const state = vatReturn(b, key, today).state;
      const stage = filingStage(b, { to }, ctx);
      if (state.kind === 'filed') { assert.equal(stage.kind, 'filed', `${name} ${key}`); continue; }
      assert.equal(state.kind === 'open' && !!state.before, before, `${name} ${key}: the return's page`);
      assert.equal(stage.kind === 'before', before, `${name} ${key}: Automatisierung`);
      if (!before) {
        assert.ok(state.kind === 'open' && state.overdue && stage.kind === 'due' && stage.overdue, `${name} ${key}: after the first day a period that ended is overdue on both`);
        assert.ok(open.from <= derivePeriod(key)!.from, `${name} ${key}: the books' open period (the link to an earlier return) does not lie after it`);
      } else {
        assert.ok(open.from > to, `${name} ${key}: the books' open period lies after it, so no link calls it overdue`);
        assert.equal(resultSentence('500', 0, false, sentenceState(state), false), 'vat.x500None', `${name} ${key}: a zero says nothing owed, not «trotzdem einzureichen»`);
      }
    }
  }
  assert.equal(beforeBooks(cases[0][1], '2026-06-30'), true);
  assert.equal(beforeBooks(cases[0][1], '2026-09-30'), false);
  assert.equal(resultSentence('500', 0, false, 'open', false), 'vat.x500NoneFile', 'a period of the books: its nil return is still to be filed');
});
