/**
 * The year-end close and the next year's opening (src/accounting/year-close.ts,
 * src/books/year-close.ts) on a small synthetic year: a Swiss sale, a purchase, a EUR receipt,
 * the VAT payment. Its closing ledger and opening are worked out by hand in the test names.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initRepository } from '../src/workspace/git.js';
import { loadBooks, periodLock, saveBooks, sealsOf } from '../src/books/store.js';
import { openReconciliations, pending } from '../src/books/reconcile.js';
import { confirm } from '../src/server/reconcile.js';
import type { Reconciliation } from '../src/types/index.js';
import { writeSeal } from '../src/books/seal.js';
import { yearEnd as yearEndData } from '../src/engines/index.js';
import {
  applyRevaluation, closingLedger, dividendSplit, emptyState, foreignAccounts, openingOf, revaluationEntries, revaluations,
  vatPostings, yearClose, yearEndAccounts, yearEndTemplates, RECEIVABLES_ID, type Books, type YearClose, type YearCloseInput,
} from '../src/accounting/year-close.js';
import {
  bookEntry, bookRevaluation, closeYear, markTemplate, openYear, readState, rebookTemplate, removeYearEndBalance, reopenTemplate, setCashCount, setYearEndBalance, yearCloseOf, YearCloseRefused,
} from '../src/books/year-close.js';
import { updateInvoices } from '../src/invoices/store.js';
import type { Issued } from '../src/invoices/model.js';
import { bookBalanceNative } from '../src/accounting/reconcile-bank.js';
import type { LedgerBankAccount, Workspace } from '../src/workspace/workspace.js';
import { yearPaths } from '../src/workspace/workspace.js';
import { BANKS, CHART, NO_YEAR_END_RATE, Q4_FILED, RATES, books, e, readyToClose, workspace } from './support/year-close.js';

const ACCOUNTS = yearEndAccounts(CHART);

/** A CHF invoice issued in October and still open: `net` plus 8.1 % is what the customer owes on 31.12. */
const issuedInvoice = (number: string, net: number): Issued => ({
  id: `in_${number}`, createdAt: '2026-10-16T08:00:00Z', origin: 'manual', deleted: false, status: 'issued', kind: 'invoice', customerId: 'cu_1', number, date: '2026-10-16', issuedAt: '2026-10-16T08:00:00Z', dueDate: '2026-11-15',
  currency: 'CHF', language: 'de', reference: 'RF00', customer: { name: 'Kunde' }, lines: [{ text: 'Beratung', quantity: 1, price: net, vatRate: 8.1 }], payments: [], reminders: [], comments: [],
} as unknown as Issued);




const input = (b: Books, over: Partial<YearCloseInput> = {}): YearCloseInput => ({
  year: '2026',
  books: b,
  chart: CHART,
  bankAccounts: BANKS,
  bankBalances: [
    { account: '1020', date: '2026-12-31', amount: 10900, source: 'r.xml' },
    { account: '1021', date: '2026-12-31', amount: 1500, source: 'w.xml' },
  ],
  filed: [
    { period: '2026-Q1', ziffern: { 500: 72.9, 510: 0 } },
    { period: '2026-Q2', ziffern: { 500: 0, 510: 0 } },
    { period: '2026-Q3', ziffern: { 500: 0, 510: 0 } },
    { period: '2026-Q4', ziffern: { 500: 0, 510: 0 } },
  ],
  seals: { checks: (['2026-Q1', '2026-Q2', '2026-Q3'] as const).map((quarter) => ({ quarter, file: `${quarter}.json`, status: 'intact' as const })), unsealed: [] },
  doctor: [],
  rates: RATES,
  state: { ...emptyState('2026'), templates: Object.fromEntries(yearEndTemplates().map((t) => [t.id, 'na' as const])) },
  ...over,
});

test('VAT codes split the tax off as Banana books it: a sale credits 2201 with 81.00, a purchase debits it with 8.10', () => {
  const posted = vatPostings(books().journalEntries, '2201');
  assert.deepEqual(posted.map((p) => [p.accountDebit, p.accountCredit, p.amount]), [['3400', '2201', 81], ['2201', '6570', 8.1]]);
  const refund = vatPostings([e('r', '2026-03-03', '3400', '1020', 108.1, { vatCode: '-V81' }), e('c', '2026-03-03', '1020', '6570', 108.1, { vatCode: '-I81' })], '2201');
  assert.deepEqual(refund.map((p) => [p.accountDebit, p.accountCredit, p.amount]), [['2201', '3400', 8.1], ['6570', '2201', 8.1]], 'a minus code posts on the other side');
  const oneLeg = vatPostings([e('s', '2026-03-31', '', '6580', 12.5, { vatCode: 'M81-2' })], '2201');
  assert.deepEqual(oneLeg.map((p) => [p.accountDebit, p.accountCredit, p.amount]), [['2201', '', 12.5]], 'a single-leg tax correction balances its empty side');
  assert.deepEqual(vatPostings([e('b', '2026-03-31', '6600', '1020', 100, { vatCode: 'B81-1' })], '2201'), [], 'Bezugsteuer is owed and deducted on the same account');
});

test('closing ledger: result 1355.00 (revenue 1081 − 81 + 475, expense 108.10 − 8.10, loss on EUR 20.00), Aktiven = Passiven + result', () => {
  const b = books();
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  const l = closingLedger(b, '2026', CHART, ACCOUNTS);
  assert.equal(l.result, 1355);
  assert.equal(l.balances['2201'], undefined, 'the VAT account is settled: 81.00 owed, 8.10 deducted, 72.90 paid');
  assert.deepEqual([l.totalAssets, l.totalLiabilities, l.residual], [12295, 10940, 0]);
  assert.deepEqual(l.causes, []);
});

test('Kursdifferenz: EUR 1500 × 0.93 = CHF 1395 against a book value of 1415: a loss of 20.00, debit 6960 / credit 1021, dated 31.12., no VAT', () => {
  const b = books();
  const [row] = revaluations(b, '2026', foreignAccounts(BANKS), RATES);
  assert.ok(row.status === 'to-book');
  assert.deepEqual([row.native, row.targetChf, row.bookChf, row.difference], [1500, 1395, 1415, -20]);
  const [entry] = revaluationEntries('2026', [row], ACCOUNTS.fxDifference);
  assert.deepEqual([entry.date, entry.accountDebit, entry.accountCredit, entry.amount, entry.vatCode, entry.origin], ['2026-12-31', '6960', '1021', 20, undefined, 'year-close']);
});

test('Kursdifferenz: a gain debits the account and credits 6960', () => {
  const b = books();
  b.journalEntries.find((x) => x.id === 'eur')!.exchangeRate = 0.9;
  const [row] = revaluations(b, '2026', foreignAccounts(BANKS), RATES);
  assert.ok(row.status === 'to-book');
  assert.equal(row.difference, 5, 'EUR 1500 × 0.93 = 1395 against 940 + 450 = 1390');
  const [entry] = revaluationEntries('2026', [row], ACCOUNTS.fxDifference);
  assert.deepEqual([entry.accountDebit, entry.accountCredit, entry.amount], ['1021', '6960', 5]);
});

test('Kursdifferenz is idempotent: rebooking replaces its entry, the native balance never moves, a later change rebooks the new difference', () => {
  const b = books();
  const book = () => applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  book();
  book();
  const own = () => b.journalEntries.filter((x) => x.origin === 'year-close');
  assert.equal(own().length, 1);
  assert.equal(revaluations(b, '2026', foreignAccounts(BANKS), RATES)[0].status, 'booked');
  assert.equal(bookBalanceNative(b.journalEntries, '1021', 'EUR', '2026', '2026-12-31', 1000), 1500, 'the revaluation moves no euros');
  b.journalEntries.push(e('late', '2026-12-20', '1021', '3400', 100, { vatCode: 'V0-E', exchangeCurrency: 'EUR', exchangeRate: 0.92 }));
  assert.equal(revaluations(b, '2026', foreignAccounts(BANKS), RATES)[0].status, 'to-book');
  book();
  assert.equal(own().length, 1);
  assert.equal(own()[0].amount, 19, 'EUR 1600 × 0.93 = 1488 against 1415 + 92 = 1507');
});

test('Kursdifferenz without the 31.12. rate: no-rate, and the close is blocked by it', () => {
  const b = books();
  assert.equal(revaluations(b, '2026', foreignAccounts(BANKS), NO_YEAR_END_RATE)[0].status, 'no-rate');
  assert.deepEqual(yearClose(input(b, { rates: NO_YEAR_END_RATE })).blockers, [{ code: 'noRate', currency: 'EUR' }]);
});

test('the checklist: nothing blocks once Q4 is filed, Q1 to Q3 sealed, the banks match on 31.12., the Kursdifferenz booked and every guided entry decided', () => {
  const b = books();
  assert.deepEqual(yearClose(input(b)).blockers, [{ code: 'fxToBook', account: '1021', difference: -20 }]);
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  const close = yearClose(input(b));
  assert.deepEqual(close.blockers, []);
  assert.ok(close.checks.every((c) => c.status === 'ok'));
  assert.equal(close.vat.unexplained, 0);
});

test('open invoices on 31.12.: proposed as a receivables entry (1100 / the revenue account, no VAT code) that must be decided; none, no proposal', () => {
  const b = books();
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  assert.ok(!yearClose(input(b)).templates.some((t) => t.id === RECEIVABLES_ID));
  const receivables = { invoices: [{ number: '2026-004', customer: 'Kunde', date: '2026-12-01', currency: 'CHF', open: 540.5, chf: 540.5 }], total: 540.5, revenueAccount: '3400' };
  const close = yearClose(input(b, { receivables }));
  const proposed = close.templates.find((t) => t.id === RECEIVABLES_ID);
  assert.deepEqual(proposed, { id: 'receivables', accountDebit: '', accountCredit: '3400', amount: 540.5, state: undefined }, 'the test chart has no 1100: the debit is the person\'s pick (r9c-2)');
  assert.deepEqual(close.blockers, [{ code: 'undecided', templates: ['receivables'] }]);
  const decided = yearClose(input(b, { receivables, state: { ...emptyState('2026'), templates: { ...Object.fromEntries(yearEndTemplates().map((t) => [t.id, 'na' as const])), receivables: 'done' } } }));
  assert.deepEqual(decided.blockers, []);
});

test('year-end entries booked in Buchungen on 31.12. tick their steps (treuhaender-29): depreciation, TA, TP, provision; another date or account does not', () => {
  const b = books();
  b.journalEntries.push(
    e('M2026-006', '2026-12-31', '6800', '1530', 4000),
    e('M2026-007', '2026-12-31', '1300', '6300', 653.35),
    e('M2026-008', '2026-12-31', '5000', '2300', 2600),
    e('M2026-009', '2026-12-31', '6100', '2330', 3000),
    e('M2026-010', '2026-12-30', '8900', '2208', 900),
    e('M2026-011', '2026-12-31', '2208', '8900', 100),
  );
  const close = yearClose(input(b, { state: emptyState('2026') }));
  const done = close.templates.filter((t) => t.state === 'done').map((t) => [t.id, t.booked?.map((x) => x.transactionRef)]);
  assert.deepEqual(done, [['depreciation', ['M2026-006']], ['accruedExpense', ['M2026-008']], ['prepaidExpense', ['M2026-007']], ['provision', ['M2026-009']]]);
  assert.equal(close.templates.find((t) => t.id === 'taxProvision')?.state, undefined, 'the 30.12. and the reversed sides do not count');
  const marked = yearClose(input(b, { state: { ...emptyState('2026'), templates: { depreciation: 'na' } } }));
  assert.equal(marked.templates.find((t) => t.id === 'depreciation')?.state, 'na', 'what the person marked wins');
});

test('refusals: each precondition names what is missing', () => {
  const b = books();
  b.transactions.push({ ref: 'open', bank: 'Raiffeisen', date: '2026-11-11', amount: 5, currency: 'CHF', direction: 'DBIT', description: 'unbooked' });
  b.bankStatements[1].toDate = '2026-11-30';
  const close = yearClose(input(b, {
    filed: [],
    seals: { checks: [{ quarter: '2026-Q1', file: 'q1', status: 'broken', problem: 'changed' }], unsealed: [] },
    bankBalances: [{ account: '1020', date: '2026-12-31', amount: 10000, source: 'r.xml' }],
    doctor: ['accounts.json does not read'],
    state: emptyState('2026'),
  }));
  const codes = close.checks.flatMap((c) => c.problems.map((p) => p.code));
  assert.deepEqual(codes, ['q4NotFiled', 'sealBroken', 'unsealed', 'unsealed', 'balanceDiffers', 'noYearEndBalance', 'statementGap', 'unbooked', 'doctor']);
  assert.ok(close.blockers.some((p) => p.code === 'undecided'));
});

test('a cash account below zero and a swapped-looking sale are hints of the checklist (r8k-8): named, never blocking', () => {
  const b = books();
  b.journalEntries.push(e('swap', '2026-10-16', '3400', '1000', 520));
  const close = yearClose(input(b));
  const check = close.checks.find((c) => c.id === 'bookingsPlausible')!;
  assert.deepEqual([check.status, check.problems.map((p) => p.code)], ['warn', ['swappedSale', 'cashNegative']]);
  assert.equal(close.blockers.some((p) => p.code === 'swappedSale' || p.code === 'cashNegative'), false, 'a hint never blocks the close');
});

test('opening 2027 = closing 2026: balance-sheet accounts carried, P&L zero, the result in 2970, EUR 1500 at CHF 1395', () => {
  const b = books();
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  const closing = closingLedger(b, '2026', CHART, ACCOUNTS);
  const o = openingOf(closing, b, foreignAccounts(BANKS), RATES, ACCOUNTS);
  assert.equal(o.year, '2027');
  assert.deepEqual(o.balances, { 1020: 10900, 1021: 1395, 2800: 10000, 2970: 2295 });
  assert.deepEqual(o.native, { 1021: { amount: 1500, currency: 'EUR' } });
  assert.deepEqual([o.result, o.residual, o.causes], [1355, 0, []]);
  for (const [account, value] of Object.entries(o.balances)) {
    if (account !== '2970') assert.equal(value, closing.balances[account], `${account} opens at its closing balance`);
  }
  assert.ok(Object.keys(o.balances).every((a) => a[0] === '1' || a[0] === '2'), 'no P&L account opens');
});

test('opening without the Kursdifferenz: the foreign account is flagged as not revalued', () => {
  const b = books();
  const o = openingOf(closingLedger(b, '2026', CHART, ACCOUNTS), b, foreignAccounts(BANKS), RATES, ACCOUNTS);
  assert.deepEqual(o.causes, [{ code: 'notRevalued', account: '1021', currency: 'EUR', expected: 1395, actual: 1415 }]);
});

test('a one-leg entry is a named cause of a difference, never absorbed', () => {
  const b = books();
  b.journalEntries.push(e('half', '2026-06-01', '6570', '', 10));
  const l = closingLedger(b, '2026', CHART, ACCOUNTS);
  assert.equal(l.residual, 10, 'Aktiven and Passiven differ by the missing leg');
  assert.deepEqual(l.causes, [{ code: 'oneLeg', entryIds: ['half'], amount: 10 }]);
});

test('a single-leg tax correction in EUR balances in CHF: no difference', () => {
  const b = books();
  b.journalEntries.push(e('fee', '2026-03-31', '', '6570', 10, { vatCode: 'M81-2', exchangeCurrency: 'EUR', exchangeRate: 0.95 }));
  const l = closingLedger(b, '2026', CHART, ACCOUNTS);
  assert.deepEqual([l.residual, l.causes], [0, []]);
});

test('a booking split over several one-leg lines balances under its ref; an account in several currencies is not revalued', () => {
  const b = books();
  b.journalEntries.push(e('s1', '2026-06-01', '6570', '', 30, { transactionRef: 'split' }), e('s2', '2026-06-01', '', '1020', 30, { transactionRef: 'split' }));
  assert.deepEqual(closingLedger(b, '2026', CHART, ACCOUNTS).causes, []);
  const manual = (currency: string): LedgerBankAccount => ({ bank: 'manual', currency, account: '2451', label: 'Kontokorrent', role: 'owner' });
  assert.deepEqual(foreignAccounts([...BANKS, manual('CHF'), manual('EUR')]).map((f) => f.account), ['1021']);
});

test('profit allocation: a dividend of 10000 owes 3500 Verrechnungssteuer, 6500 to pay out', () => {
  assert.deepEqual(dividendSplit(10000, 0.35), { net: 6500, withholdingTax: 3500 });
  assert.deepEqual(dividendSplit(333.33, 0.35), { net: 216.66, withholdingTax: 116.67 });
});

// ─── On a workspace ───────────────────────────────────────────────────────────


test('bookRevaluation on a workspace: refuses without the 31.12. rate, books once however often it runs', () => {
  const ws = workspace();
  assert.throws(() => bookRevaluation(ws, '2026', NO_YEAR_END_RATE), YearCloseRefused);
  bookRevaluation(ws, '2026', RATES);
  bookRevaluation(ws, '2026', RATES);
  assert.equal(loadBooks(ws).journalEntries.filter((x) => x.origin === 'year-close').length, 1);
});

test('closeYear refuses while anything blocks; openYear refuses a year that is not closed', async () => {
  const ws = workspace();
  await assert.rejects(() => closeYear(ws, '2026', RATES), YearCloseRefused);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-09-30', 'nothing moved');
  await assert.rejects(() => openYear(ws, '2026', RATES), /not closed yet/);
});

test('bookEntry: an accrual gets the next M-ref, marks its template done, and is refused in a closed period', () => {
  const ws = workspace();
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '2300'].map((number) => ({ number, name: number }))));
  const entry = bookEntry(ws, { date: '2026-12-31', accountDebit: '6570', accountCredit: '2300', amount: 250, description: 'Abgrenzung Hosting Dezember' }, 'accruedExpense');
  assert.equal(entry.transactionRef, 'M2026-001');
  assert.equal(entry.origin, 'manual');
  assert.throws(() => bookEntry(ws, { date: '2026-09-30', accountDebit: '6570', accountCredit: '2300', amount: 1, description: 'zu spät' }), /geschlossen/);
});



test('the whole round: close 2026 (Q4 sealed, closedThrough 31.12.), open 2027 at the closing balances, reruns change nothing', async () => {
  const ws = readyToClose();
  await assert.rejects(() => closeYear(ws, '2026', RATES), YearCloseRefused, 'the Kursdifferenz and the guided entries are open');
  bookRevaluation(ws, '2026', RATES);
  for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na');
  const result = await closeYear(ws, '2026', RATES, '2027-03-01');
  assert.equal(result.closedThrough, '2026-12-31');
  assert.equal(result.committed, false, 'a temp folder is no git repository');
  assert.ok(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q4.json')));
  assert.deepEqual(sealsOf(loadBooks(ws)).checks.map((c) => `${c.quarter} ${c.status}`), ['2026-Q1 intact', '2026-Q2 intact', '2026-Q3 intact', '2026-Q4 intact']);
  assert.equal((await closeYear(ws, '2026', RATES, '2027-03-02')).closedThrough, '2026-12-31', 'closing again only checks');
  assert.throws(() => bookRevaluation(ws, '2026', RATES), /closed/, 'nothing can be dated 31.12. any more');

  const opened = await openYear(ws, '2026', RATES, '2027-03-01');
  assert.deepEqual(opened.opening.balances, { 1020: 10900, 1021: 1395, 2800: 10000, 2970: 2295 });
  assert.equal(opened.ratesReady, true, 'the stand-in table holds a rate of 2027');
  const config = loadBooks(ws).config;
  assert.deepEqual(config.openingBalances?.['2027'], opened.opening.balances);
  assert.deepEqual(config.openingBalancesNative?.['2027'], { 1021: { amount: 1500, currency: 'EUR' } });
  assert.deepEqual((await openYear(ws, '2026', RATES)).changes, [], 'a rerun finds nothing to update');
});

test('receivables: booked on 31.12. under the year\'s id, once; opening the next year reverses them on 1.1., a rerun keeps one reversal', async () => {
  const ws = readyToClose();
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '2451', '1100'].map((number) => ({ number, name: number }))));
  bookRevaluation(ws, '2026', RATES);
  for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na');
  updateInvoices(ws, (book) => { book.invoices.push(issuedInvoice('2026-004', 500)); });
  const input = { date: '2026-12-31', accountDebit: '1100', accountCredit: '3400', amount: 540.5, description: 'Debitoren per 31.12.2026: 2026-004' };
  const booked = bookEntry(ws, input, 'receivables');
  assert.equal(booked.id, 'yc-2026-receivables');
  assert.throws(() => bookEntry(ws, input, 'receivables'), /booked already/);
  await closeYear(ws, '2026', RATES, '2027-03-01');

  const opened = await openYear(ws, '2026', RATES, '2027-03-01');
  assert.equal(opened.opening.balances['1100'], 540.5, 'the receivables open 2027');
  const reversal = { id: 'yc-2027-receivables-reversal', transactionRef: 'yc-2027-receivables-reversal', date: '2027-01-01', accountDebit: '3400', accountCredit: '1100', amount: 540.5, description: `Auflösung Debitoren per 31.12.2026 (${booked.transactionRef})`, origin: 'year-close' };
  assert.deepEqual(opened.reversal, reversal);
  await openYear(ws, '2026', RATES, '2027-03-02');
  assert.deepEqual(loadBooks(ws).journalEntries.filter((x) => x.id.includes('receivables')), [booked, reversal]);
});

test('in a company repository (ADR 0013) the close and the opening are committed in the repository, with only the books', async () => {
  const ws = readyToClose(true);
  await initRepository(ws.paths.repository, 'Workspace set up');
  writeFileSync(join(ws.paths.repository, 'notes.md'), 'not part of the close');
  bookRevaluation(ws, '2026', RATES);
  for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na');
  assert.equal((await closeYear(ws, '2026', RATES, '2027-03-01')).committed, true);
  await openYear(ws, '2026', RATES, '2027-03-01');
  const git = (...args: string[]) => execFileSync('git', ['-C', ws.paths.repository, ...args], { encoding: 'utf8' }).trim();
  assert.deepEqual(git('log', '--format=%s').split('\n'), ['Eröffnung 2027: opening balances from the closed 2026', 'Jahresabschluss 2026: closed through 2026-12-31, 2026-Q4 sealed', 'Workspace set up']);
  assert.ok(git('show', '--name-only', '--format=', 'HEAD~1').split('\n').every((f) => f.startsWith('vanilla-accounting/')), 'only the books are in the close');
  assert.equal(git('status', '--porcelain'), '?? notes.md');
});

test('books that never filed and start in Q3 are not asked to file Q1 and Q2; books from February are', () => {
  const fresh = (date: string): Books => {
    const b = books();
    return { ...b, transactions: b.transactions.map((x) => ({ ...x, date })), journalEntries: [], config: { openingBalances: b.config.openingBalances } };
  };
  const notClosed = (b: Books) => yearClose(input(b, { seals: { checks: [], unsealed: [] } })).checks.find((c) => c.id === 'quartersSealed')!.problems;
  assert.deepEqual(notClosed(fresh('2026-07-14')), [{ code: 'notClosed', quarter: '2026-Q3' }]);
  assert.deepEqual(notClosed(fresh('2026-02-10')).map((p) => 'quarter' in p && p.quarter), ['2026-Q1', '2026-Q2', '2026-Q3']);
});

test('the year end books only on accounts of the chart (r9c-2): the receivables account is the chart\'s, a chart without one leaves the pick blank and names the missing account; a booking on an account outside the chart is refused; a balance on such an account fails «Schlussbilanz geht auf»', () => {
  const receivables = { invoices: [{ number: '2026-004', customer: 'Kunde', date: '2026-12-01', currency: 'CHF', open: 540.5, chf: 540.5 }], total: 540.5, revenueAccount: '3400' };
  const b = books();
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  const without = yearClose(input(b, { receivables }));
  assert.deepEqual(without.accounts.receivables, { account: '1100', inChart: false }, 'the chart of the test year has no 1100');
  assert.equal(without.templates.find((t) => t.id === RECEIVABLES_ID)?.accountDebit, '', 'no account outside the chart is prefilled');
  const withIt = yearClose(input(b, { receivables, chart: [...CHART, '1100'] }));
  assert.deepEqual(withIt.accounts.receivables, { account: '1100', inChart: true });
  assert.equal(withIt.templates.find((t) => t.id === RECEIVABLES_ID)?.accountDebit, '1100');

  // Booked on 1100 anyway (the chart lacks it): the ledger's double entry balances, but the Bilanz leaves 1100 out.
  const booked = books();
  applyRevaluation(booked, '2026', revaluationEntries('2026', revaluations(booked, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  booked.journalEntries.push(e('yc-2026-receivables', '2026-12-31', '1100', '3400', 540.5));
  const close = yearClose(input(booked, { receivables, state: { ...emptyState('2026'), templates: { ...Object.fromEntries(yearEndTemplates().map((t) => [t.id, 'na' as const])), receivables: 'done' } } }));
  assert.equal(close.ledger.residual, 0, 'the double entry balances');
  assert.deepEqual(close.ledger.causes, [{ code: 'notInChart', account: '1100', amount: 540.5 }]);
  assert.deepEqual(close.blockers, [{ code: 'notInChart', account: '1100', amount: 540.5 }], 'the year cannot close on an account the Bilanz does not show');
  assert.equal(close.ledger.balanced, false, 'the check «Schlussbilanz geht auf» fails');
  assert.equal(yearClose(input(booked, { receivables, chart: [...CHART, '1100'], state: close.state })).ledger.balanced, true, 'with the account in the chart it passes');
});

test('a year-end entry on an account the chart lacks is refused with the account named (r9c-2)', () => {
  const ws = readyToClose();
  bookRevaluation(ws, '2026', RATES);
  const input = { date: '2026-12-31', accountDebit: '1100', accountCredit: '3400', amount: 540.5, description: 'Debitoren per 31.12.2026: 2026-004' };
  assert.throws(() => bookEntry(ws, input, 'receivables'), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'accountNotInChart' && err.why.params.account === '1100');
  assert.ok(!loadBooks(ws).journalEntries.some((x) => x.id === 'yc-2026-receivables'), 'nothing booked');
  assert.throws(() => bookEntry(ws, { ...input, accountDebit: '1300', accountCredit: '6300' }), /1300/, 'a hand entry of the close as well');
});

test('«zurück» on a booked step takes its booking back too (r9c-16): the entry the step booked is removed and the step is open again; a step marked by hand only loses its mark', () => {
  const ws = workspace();
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '2300', '1100'].map((number) => ({ number, name: number }))));
  const accrual = bookEntry(ws, { date: '2026-12-31', accountDebit: '6570', accountCredit: '2300', amount: 250, description: 'Abgrenzung Hosting Dezember' }, 'accruedExpense');
  const debtors = bookEntry(ws, { date: '2026-12-31', accountDebit: '1100', accountCredit: '3400', amount: 540.5, description: 'Debitoren per 31.12.2026: 2026-004' }, 'receivables');
  markTemplate(ws, '2026', 'depreciation', 'done');
  assert.deepEqual(readState(ws, '2026').templates, { accruedExpense: 'done', receivables: 'done', depreciation: 'done' });

  const reopened = reopenTemplate(ws, '2026', 'accruedExpense');
  assert.deepEqual(reopened.removed.map((x) => x.id), [accrual.id], 'the booking the step made goes with it');
  assert.deepEqual(reopened.state.templates, { receivables: 'done', depreciation: 'done' });
  assert.ok(!loadBooks(ws).journalEntries.some((x) => x.id === accrual.id));

  const debtorsBack = reopenTemplate(ws, '2026', 'receivables');
  assert.deepEqual(debtorsBack.removed.map((x) => x.id), [debtors.id]);
  assert.ok(!loadBooks(ws).journalEntries.some((x) => x.id === debtors.id), 'the receivables entry can be booked again');
  const byHand = reopenTemplate(ws, '2026', 'depreciation');
  assert.deepEqual([byHand.state.templates, byHand.removed], [{}, []], 'marked done by hand, nothing booked: only the mark goes');
});

test('a payment that names an open invoice without being linked to it blocks the Debitoren: their revenue would count twice (r9c-3)', () => {
  const b = books();
  applyRevaluation(b, '2026', revaluationEntries('2026', revaluations(b, '2026', foreignAccounts(BANKS), RATES), ACCOUNTS.fxDifference));
  const unlinked = [{ transactionRef: 'W1', date: '2026-10-12', number: '2026-002', currency: 'EUR', amount: 3000 }];
  const receivables = { invoices: [{ number: '2026-002', customer: 'Kunde', date: '2026-10-16', currency: 'EUR', open: 4200, chf: 3906 }], total: 3906, revenueAccount: '3400', unlinked };
  const close = yearClose(input(b, { receivables, chart: [...CHART, '1100'] }));
  assert.deepEqual(close.blockers, [{ code: 'undecided', templates: ['receivables'] }, { code: 'paymentsUnlinked', payments: unlinked }]);
  assert.deepEqual(yearClose(input(b, { receivables: { ...receivables, unlinked: undefined }, chart: [...CHART, '1100'] })).blockers, [{ code: 'undecided', templates: ['receivables'] }], 'linked: only the decision is open');
});

test('r9k-1: a bank account whose ledger account the chart lacks is a typed problem of the checklist (said in the person\'s language), not doctor\'s English line', () => {
  const close = yearClose(input(books(), { bankAccounts: [...BANKS, { bank: 'Raiffeisen 2', currency: 'CHF', account: '1022', label: 'Coiffure Nachbar GmbH', statements: 'camt053', role: 'bank' }] }));
  const doctor = close.checks.find((c) => c.id === 'doctor')!;
  assert.deepEqual(doctor.problems, [{ code: 'bankNotInChart', account: '1022', label: 'Coiffure Nachbar GmbH' }]);
  assert.equal(doctor.status, 'fail');
});

test('r10c-1: a booked Debitoren step whose figure changed since (an invoice cancelled) is stale, not «erfasst»: the step says booked against now, and the close blocks until it is booked again', () => {
  const b = books();
  b.journalEntries.push(e('yc-2026-receivables', '2026-12-31', '1100', '3400', 2704.57, { origin: 'manual' }));
  const chart = [...CHART, '1100'];
  const state = { ...emptyState('2026'), templates: { ...Object.fromEntries(yearEndTemplates().map((t) => [t.id, 'na' as const])), receivables: 'done' as const } };
  const receivables = { invoices: [{ number: '2026-002', customer: 'Kunde', date: '2026-10-16', currency: 'EUR', open: 1200, chf: 1147.93 }], total: 1147.93, revenueAccount: '3400' };
  const close = yearClose(input(b, { receivables, chart, state }));
  const step = close.templates.find((t) => t.id === RECEIVABLES_ID)!;
  assert.deepEqual(step.booked, [{ id: 'yc-2026-receivables', transactionRef: 'yc-2026-receivables', chf: 2704.57 }]);
  assert.deepEqual(step.stale, { booked: 2704.57, now: 1147.93 });
  const blockers = (c: YearClose) => c.blockers.filter((p) => p.code !== 'fxToBook');
  assert.deepEqual(blockers(close), [{ code: 'entryStale', template: 'receivables', booked: 2704.57, now: 1147.93 }]);

  const same = yearClose(input(b, { receivables: { ...receivables, total: 2704.57 }, chart, state }));
  assert.deepEqual([same.templates.find((t) => t.id === RECEIVABLES_ID)!.stale, blockers(same)], [undefined, []], 'the same figure: booked, nothing blocks');

  const none = yearClose(input(b, { receivables: { invoices: [], total: 0, revenueAccount: '3400' }, chart, state }));
  assert.deepEqual(none.templates.find((t) => t.id === RECEIVABLES_ID)?.stale, { booked: 2704.57, now: 0 }, 'every invoice paid or cancelled since: the step stays, with nothing to book');
});

test('r10c-1: «Neu buchen» replaces the Debitoren booking with today\'s figure on the same accounts and keeps the step booked; with nothing open any more the booking goes and the step is open again', () => {
  const ws = workspace();
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '1100'].map((number) => ({ number, name: number }))));
  updateInvoices(ws, (book) => { book.invoices.push(issuedInvoice('2026-002', 1000)); });
  const old = bookEntry(ws, { date: '2026-12-31', accountDebit: '1100', accountCredit: '3400', amount: 2704.57, description: 'Debitoren per 31.12.2026: offene Rechnungen 2026-002, 2026-003' }, 'receivables');
  assert.deepEqual(yearCloseOf(ws, '2026', RATES).templates.find((t) => t.id === RECEIVABLES_ID)?.stale, { booked: 2704.57, now: 1081 });

  const again = rebookTemplate(ws, '2026', 'receivables', 'Debitoren per 31.12.2026: offene Rechnungen 2026-002', RATES);
  assert.deepEqual(again.removed.map((x) => x.id), [old.id]);
  assert.deepEqual([again.entry?.id, again.entry?.accountDebit, again.entry?.accountCredit, again.entry?.amount, again.entry?.description, again.entry?.origin, again.entry?.by?.kind],
    ['yc-2026-receivables', '1100', '3400', 1081, 'Debitoren per 31.12.2026: offene Rechnungen 2026-002', 'manual', 'person']);
  assert.deepEqual(loadBooks(ws).journalEntries.filter((x) => x.id === 'yc-2026-receivables').map((x) => x.amount), [1081], 'one booking, the new one');
  assert.equal(readState(ws, '2026').templates.receivables, 'done');
  assert.equal(yearCloseOf(ws, '2026', RATES).templates.find((t) => t.id === RECEIVABLES_ID)?.stale, undefined);
  assert.throws(() => rebookTemplate(ws, '2026', 'receivables', 'x', RATES), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'entryNotStale', 'nothing changed: nothing to book again');

  updateInvoices(ws, (book) => { (book.invoices[0] as Issued).cancelled = { date: '2026-12-20', reason: 'doppelt' }; });
  const gone = rebookTemplate(ws, '2026', 'receivables', 'x', RATES);
  assert.deepEqual([gone.removed.map((x) => x.id), gone.entry], [['yc-2026-receivables'], undefined]);
  assert.ok(!loadBooks(ws).journalEntries.some((x) => x.id === 'yc-2026-receivables'));
  assert.equal(readState(ws, '2026').templates.receivables, undefined, 'nothing to book: the step is open again');
});

/**
 * #119: a firm that never imports a statement, with a cash box and an employee's account: the year
 * closes on the bank's year-end confirmations and the cash count, as the law asks (OR Art. 958c),
 * not a month's statement more.
 */
function withoutStatements(): Workspace {
  const base = workspace();
  const ws: Workspace = { ...base, bankAccounts: [
    ...base.bankAccounts,
    { bank: 'Kasse', currency: 'CHF', account: '1000', label: 'Kasse', role: 'cash' },
    { bank: 'Lohn', currency: 'CHF', account: '2271', label: 'Mia Muster', role: 'employee' },
  ] };
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '1000', '2271', '2451'].map((number) => ({ number, name: number }))));
  const y = yearPaths(ws.paths, '2026');
  mkdirSync(y.filings, { recursive: true });
  writeFileSync(join(y.filings, 'mwst-ech0217-2026-Q4.xml'), Q4_FILED);
  const b = loadBooks(ws);
  b.bankStatements = [];
  b.statementBalances = [];
  b.journalEntries.push(e('cash', '2026-11-02', '1000', '1020', 200, { description: 'Bargeldbezug' }), e('advance', '2026-11-03', '2271', '1020', 50, { description: 'Vorschuss Mia' }));
  saveBooks(ws, b);
  for (const q of ['2026-Q1', '2026-Q2', '2026-Q3'] as const) writeSeal(ws, loadBooks(ws), q, '2026-10-15');
  bookRevaluation(ws, '2026', RATES);
  for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na');
  return ws;
}

const LETTER = { name: 'Saldobestaetigung 2026.pdf', body: Buffer.from('%PDF-1.4 year-end confirmation') };
const codesOf = (c: YearClose) => c.blockers.map((p) => ('account' in p ? `${p.code} ${p.account}` : p.code));

test('#119: without a single imported statement the year closes on the banks\' year-end confirmations and the cash count; the owner\'s and the employee\'s accounts are never asked for', async () => {
  const ws = withoutStatements();
  const before = yearCloseOf(ws, '2026', RATES);
  assert.deepEqual(codesOf(before), ['noYearEndBalance 1020', 'noYearEndBalance 1021', 'noCashCount 1000'], 'no statementGap: no account has an imported statement');
  assert.deepEqual(before.balances.map((b) => [b.account, b.proof, b.book]), [['1020', 'bank', 10650], ['1021', 'bank', 1500], ['1000', 'count', 200]], 'bank, card and cash only: not 2451 (owner) nor 2271 (employee)');
  await assert.rejects(() => closeYear(ws, '2026', RATES), YearCloseRefused);

  const balance = setYearEndBalance(ws, '2026', '1020', 10650, LETTER);
  assert.deepEqual(balance, { account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-12-31', amount: 10650, source: 'pdf', sourceFile: 'year-end/1020-2026-12-31.pdf' }, 'a StatementClosingBalance read off a PDF, as a statement\'s');
  assert.equal(readFileSync(join(yearPaths(ws.paths, '2026').filings, balance.sourceFile), 'utf8'), '%PDF-1.4 year-end confirmation', 'the confirmation is kept beside the year\'s filings');
  setCashCount(ws, '2026', '1000', 200);
  assert.deepEqual(codesOf(yearCloseOf(ws, '2026', RATES)), ['noYearEndBalance 1021'], 'a bank account without its balance still blocks');
  await assert.rejects(() => closeYear(ws, '2026', RATES), YearCloseRefused);

  setYearEndBalance(ws, '2026', '1021', 1500, { name: 'wise.png', body: Buffer.from('png') });
  const ready = yearCloseOf(ws, '2026', RATES);
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.balances.find((b) => b.account === '1021')?.document, true);
  assert.equal((await closeYear(ws, '2026', RATES, '2027-02-01')).closedThrough, '2026-12-31');
  assert.throws(() => setCashCount(ws, '2026', '1000', 199), YearCloseRefused, 'a closed year keeps its count');
  assert.throws(() => setYearEndBalance(ws, '2026', '1020', 1, LETTER), YearCloseRefused, 'and its balances');
});

test('#119: a cash count off the books is shown with both figures and blocks the close, never booked by the app; a bank\'s confirmation off the books blocks as a statement\'s does', () => {
  const ws = withoutStatements();
  setYearEndBalance(ws, '2026', '1020', 10650, LETTER);
  setYearEndBalance(ws, '2026', '1021', 1490, LETTER);
  setCashCount(ws, '2026', '1000', 180.5);
  const entries = loadBooks(ws).journalEntries.length;
  const close = yearCloseOf(ws, '2026', RATES);
  assert.deepEqual(close.blockers, [
    { code: 'balanceDiffers', account: '1021', label: 'Wise EUR', currency: 'EUR', bank: 1490, book: 1500, date: '2026-12-31' },
    { code: 'cashDiffers', account: '1000', label: 'Kasse', currency: 'CHF', counted: 180.5, book: 200 },
  ]);
  assert.equal(loadBooks(ws).journalEntries.length, entries, 'no difference booked');
  setCashCount(ws, '2026', '1000', null);
  assert.equal(readState(ws, '2026').cashCounts, undefined, 'taken back');
});

test('#119: a hand balance is refused where a statement states the day, on an account that is no bank or card, and without a PDF or image; taking it back removes its file', () => {
  const ws = readyToClose();
  assert.throws(() => setYearEndBalance(ws, '2026', '1020', 10900, LETTER), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'yearEndBalanceStated', 'the statement is the proof');
  const bare = withoutStatements();
  assert.throws(() => setYearEndBalance(bare, '2026', '2451', 1, LETTER), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'yearEndAccountUnknown', 'the owner\'s account needs no confirmation');
  assert.throws(() => setCashCount(bare, '2026', '1020', 1), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'yearEndAccountUnknown', 'a bank account is not counted');
  assert.throws(() => setYearEndBalance(bare, '2026', '1020', 1, { name: 'saldo.docx', body: Buffer.from('x') }), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'yearEndDocumentType');
  const first = setYearEndBalance(bare, '2026', '1020', 10650, LETTER);
  const { sourceFile } = setYearEndBalance(bare, '2026', '1020', 10650, { name: 'scan.PNG', body: Buffer.from('png') });
  const filings = yearPaths(bare.paths, '2026').filings;
  assert.deepEqual([existsSync(join(filings, first.sourceFile)), readFileSync(join(filings, sourceFile), 'utf8')], [false, 'png'], 'a new confirmation replaces the old one');
  removeYearEndBalance(bare, '2026', '1020');
  assert.equal(existsSync(join(yearPaths(bare.paths, '2026').filings, sourceFile)), false);
  assert.ok(codesOf(yearCloseOf(bare, '2026', RATES)).includes('noYearEndBalance 1020'));
});

test('#119: «every month has its statement» only on an account with an imported statement; a country module can ask it of a role (Switzerland asks it of none)', () => {
  const b = books();
  b.bankStatements = [{ bank: 'Raiffeisen', filename: 'r.xml', fromDate: '2026-01-01', toDate: '2026-11-30', currency: 'CHF' }];
  const gaps = (c: YearClose) => c.checks.find((x) => x.id === 'statementsComplete')!.problems.map((p) => ('account' in p ? p.account : ''));
  assert.deepEqual(gaps(yearClose(input(b))), ['1020'], '1021 never had a statement: no month of it is missing');
  assert.deepEqual(yearEndData().moneyAccounts, { monthlyStatements: [] });
  const swiss = yearEndData().moneyAccounts;
  yearEndData().moneyAccounts = { monthlyStatements: ['bank'] };
  try {
    assert.deepEqual(gaps(yearClose(input(b))), ['1020', '1021'], 'a stricter country asks every bank account for every month');
  } finally {
    yearEndData().moneyAccounts = swiss;
  }
});

test('review (#254): a statement PDF\'s question of the year still open closes with the year, its PDF kept as the statement; the close is not refused by its own save', async () => {
  const ws = readyToClose();
  const b = loadBooks(ws);
  const statement = { currency: 'CHF', period: { from: '2026-11-01', to: '2026-11-30' }, opening: { date: '2026-11-01', amount: 0 }, closing: { date: '2026-11-30', amount: 0 }, movements: [] };
  b.statementAsks = [{ file: 'Raiffeisen/Kontoauszug 01.11.2026 - 30.11.2026.pdf', account: '1020', date: '2026-11-30', since: '2026-12-01', read: { by: 'hand', statement, check: { ok: true, gaps: [] }, known: [] } }];
  saveBooks(ws, b);
  bookRevaluation(ws, '2026', RATES);
  for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na');
  const result = await closeYear(ws, '2026', RATES, '2027-03-01');
  assert.equal(result.closedThrough, '2026-12-31');
  const after = loadBooks(ws);
  assert.deepEqual([after.config.closedThrough, after.statementAsks], ['2026-12-31', undefined], 'closed, the question with it');
  assert.ok(sealsOf(after).checks.every((c) => c.status === 'intact'));
});

test('a filed movement read from a PDF and not booked there, confirmed the same as an open bank movement: the year counts it booked once its twin is (#254)', () => {
  const b: Books & { reconciliations?: Reconciliation[] } = books();
  const move = (ref: string, date: string) => ({ ref, bank: 'Raiffeisen', date, amount: 150, currency: 'CHF', direction: 'DBIT' as const, description: 'Reinigung Muster', counterparty: 'Reinigung Muster' });
  b.transactions.push(move('P', '2026-09-29'), move('B', '2026-10-06'));
  const { isClosed } = periodLock(b);
  openReconciliations(b, { pdf: new Set(['P']), structured: new Set(['B']), both: new Set(), spans: [{ account: '1020', from: '2026-10-01', to: '2026-10-31' }] }, () => '1020', '2026-10-28', isClosed);
  confirm(b as never, pending(b)[0], { pairs: [{ read: 'P', bank: 'B' }], own: [] }, { rateOf: () => undefined, isClosed, chart: new Set(CHART), bankOf: () => '1020', today: '2026-10-28' });
  assert.deepEqual([b.transactions.some((t) => t.ref === 'P'), b.reconciliations?.[0].pairs], [true, [{ read: 'P', bank: 'B' }]], 'confirmed: the filed one stays as filed, paired');
  const unbooked = () => yearClose(input(b)).checks.find((c) => c.id === 'allBooked')!.problems;
  assert.deepEqual(unbooked(), [{ code: 'unbooked', count: 2, refs: ['P', 'B'] }], 'its twin unbooked: both wait');
  b.journalEntries.push(e('B', '2026-10-06', '6570', '1020', 150));
  assert.deepEqual(unbooked(), [], 'its twin booked: the filed one is that payment, booked');
});

test('a movement of amount 0 (a quarter\'s closing statement of nothing) needs no booking and is not listed as unbooked (#290)', () => {
  const b = books();
  b.transactions.push({ ref: 'Z', bank: 'Raiffeisen', date: '2026-09-30', amount: 0, currency: 'CHF', direction: 'CRDT', description: 'Abschluss 01.07.2026 - 30.09.2026' });
  assert.deepEqual(yearClose(input(b)).checks.find((c) => c.id === 'allBooked')!.problems, []);
});
