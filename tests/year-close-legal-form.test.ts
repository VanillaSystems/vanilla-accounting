/**
 * The year close follows the legal form (r10f-28): an Einzelfirma closes the result to the owner's
 * capital and the private account into it, and gets no profit allocation (no Generalversammlung,
 * dividend, Verrechnungssteuer); a GmbH keeps 2970 and the allocation. Steps and accounts come from
 * modules/ch/year-end.yaml `byLegalForm` and the chart: an allocation account the chart lacks is
 * never offered.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { closingLedger, openingOf, yearClose, yearEndAccounts, type YearCloseInput } from '../src/accounting/year-close.js';
import { bookEntry, YearCloseRefused } from '../src/books/year-close.js';
import { stepsFor } from '../src/app/areas/close/model.js';
import { BANKS, CHART, RATES, books, e, workspace } from './support/year-close.js';
import { emptyState, yearEndTemplates } from '../src/accounting/year-close.js';

const OWNER_CHART = ['1020', '2800', '2850', '2970', '2979', '3400', '6570'];
const GMBH_CHART = [...CHART, '2206', '2451', '2950'];

test('the accounts of the close by legal form: an Einzelfirma carries the result to 2800 and closes 2850 into it, no allocation; a GmbH to 2970 with reserve, dividend and withholding tax', () => {
  const owner = yearEndAccounts(OWNER_CHART, 'Einzelfirma');
  assert.equal(owner.resultTo, '2800');
  assert.equal(owner.privateInto, '2850');
  assert.equal(owner.allocation, undefined, 'no Generalversammlung, no dividend, no Verrechnungssteuer');

  const gmbh = yearEndAccounts(GMBH_CHART, 'GmbH');
  assert.equal(gmbh.resultTo, '2970');
  assert.equal(gmbh.privateInto, undefined);
  assert.deepEqual(gmbh.allocation, { reserve: '2950', dividend: { account: '2451', withholdingTax: '2206', rate: 0.35 }, missing: [] });

  // A legal form the module does not name takes the capital company's path, as the setup's owner account does.
  assert.equal(yearEndAccounts(GMBH_CHART, 'AG').resultTo, '2970');
  assert.equal(yearEndAccounts(GMBH_CHART).resultTo, '2970');
});

test('an allocation account the chart lacks is never offered: without 2206 there is no dividend row, and the step names what is missing', () => {
  const a = yearEndAccounts([...CHART, '2451', '2950'], 'GmbH').allocation!;
  assert.equal(a.reserve, '2950');
  assert.equal(a.dividend, undefined);
  assert.deepEqual(a.missing, [{ role: 'withholdingTax', account: '2206' }]);
  const none = yearEndAccounts(CHART, 'GmbH').allocation!;
  assert.deepEqual([none.reserve, none.dividend, none.missing.map((m) => m.account)], [undefined, undefined, ['2950', '2451', '2206']]);
});

test('an Einzelfirma opens the next year with the result and the private account closed into the capital: 2800 = 10000 + result − 500 withdrawn, no 2850, no 2970', () => {
  const b = books();
  b.config.openingBalances = { 2026: { 1020: 10000, 1021: 940, 2800: 10940 } };
  b.journalEntries.push(e('draw', '2026-08-01', '2850', '1020', 500));
  const accounts = yearEndAccounts(OWNER_CHART, 'Einzelfirma');
  const closing = closingLedger(b, '2026', OWNER_CHART, accounts);
  assert.equal(closing.balances['2850'], -500, 'the private account carries the withdrawal (equity, so below zero)');
  const o = openingOf(closing, b, [], RATES, accounts);
  assert.equal(o.resultTo, '2800');
  assert.equal(o.balances['2800'], Math.round((10940 + closing.result - 500) * 100) / 100);
  assert.equal(o.balances['2850'], undefined, 'the private account starts the year at zero');
  assert.equal(o.balances['2970'], undefined, 'nothing goes to Gewinnvortrag');
  assert.equal(o.residual, 0);
});

test('the close of an Einzelfirma offers no allocation, a GmbH\'s does', () => {
  const input = (legalForm: YearCloseInput['legalForm'], chart: string[]): YearCloseInput => ({
    year: '2026', books: books(), chart, bankAccounts: BANKS, bankBalances: [], filed: [], seals: { checks: [], unsealed: [] }, doctor: [], rates: RATES, legalForm,
    state: { ...emptyState('2026'), templates: Object.fromEntries(yearEndTemplates().map((t) => [t.id, 'na' as const])) },
  });
  assert.equal(yearClose(input('Einzelfirma', OWNER_CHART)).accounts.allocation, undefined);
  assert.ok(yearClose(input('GmbH', GMBH_CHART)).accounts.allocation);
});

test('a profit allocation is refused on an Einzelfirma: the profit is the owner\'s without a resolution', () => {
  const ws = workspace();
  const owner = { ...ws, company: { ...ws.company, legalForm: 'Einzelfirma' as const } };
  assert.throws(() => bookEntry(owner, { date: '2027-06-30', accountDebit: '2970', accountCredit: '2950', amount: 100, description: 'Dividende' }, 'profitAllocation'), (err: unknown) => err instanceof YearCloseRefused && err.why.code === 'noProfitAllocation');
});

test('the year-end page of an Einzelfirma has six steps, without «Gewinn verwenden»; a GmbH seven', () => {
  assert.deepEqual(stepsFor('Einzelfirma'), ['q4', 'checks', 'entries', 'close', 'open', 'handover']);
  assert.deepEqual(stepsFor('GmbH'), ['q4', 'checks', 'entries', 'close', 'open', 'profit', 'handover']);
  assert.deepEqual(stepsFor(undefined), stepsFor('GmbH'));
});
