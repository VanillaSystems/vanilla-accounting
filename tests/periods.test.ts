/**
 * The period tokens of the app's URL (src/accounting/periods.ts): every token resolves to the
 * right days, weeks start on Monday, presets cross year boundaries, and a calendar range that
 * covers a whole quarter becomes that quarter again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriod, rangeToken, vatPeriodOf, RELATIVE_PRESETS, derivePeriod, isIsoDate, inPeriod } from '../src/accounting/periods.js';

const range = (token: string, today = '2026-10-09') => {
  const p = parsePeriod(token, today);
  return p && `${p.from}..${p.to}`;
};

test('fixed periods', () => {
  assert.equal(range('2026'), '2026-01-01..2026-12-31');
  assert.equal(range('2026-H1'), '2026-01-01..2026-06-30');
  assert.equal(range('2026-H2'), '2026-07-01..2026-12-31');
  assert.equal(range('2026-Q1'), '2026-01-01..2026-03-31');
  assert.equal(range('2026-Q3'), '2026-07-01..2026-09-30');
  assert.equal(range('2026-02'), '2026-02-01..2026-02-28');
  assert.equal(range('2028-02'), '2028-02-01..2028-02-29');
  assert.equal(range('2026-12'), '2026-12-01..2026-12-31');
  assert.equal(parsePeriod('all', '2026-10-09')?.kind, 'all');
  assert.deepEqual(['2026', '2026-H2', '2026-Q3', '2026-09'].map((t) => parsePeriod(t, '2026-10-09')!.kind), ['year', 'half', 'quarter', 'month']);
});

test('custom ranges', () => {
  assert.equal(range('2026-10-01..2026-10-09'), '2026-10-01..2026-10-09');
  assert.equal(range('2026-10-09..2026-10-09'), '2026-10-09..2026-10-09');
  assert.equal(range('2025-12-15..2026-01-15'), '2025-12-15..2026-01-15');
  assert.equal(range('2028-02-29..2028-03-01'), '2028-02-29..2028-03-01');
  assert.equal(parsePeriod('2026-10-01..2026-10-09', '2026-10-09')?.kind, 'range');
});

test('relative presets on a Friday in Q4 (2026-10-09)', () => {
  const expected: Record<string, string> = {
    'today': '2026-10-09..2026-10-09',
    'yesterday': '2026-10-08..2026-10-08',
    'last-7d': '2026-10-03..2026-10-09',
    'last-30d': '2026-09-10..2026-10-09',
    'last-90d': '2026-07-12..2026-10-09',
    'last-365d': '2025-10-10..2026-10-09',
    'last-week': '2026-09-28..2026-10-04',
    'last-month': '2026-09-01..2026-09-30',
    'last-quarter': '2026-07-01..2026-09-30',
    'last-12m': '2025-10-01..2026-09-30',
    'last-year': '2025-01-01..2025-12-31',
    'wtd': '2026-10-05..2026-10-09',
    'mtd': '2026-10-01..2026-10-09',
    'qtd': '2026-10-01..2026-10-09',
    'ytd': '2026-01-01..2026-10-09',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...RELATIVE_PRESETS].sort(), 'every preset has a case');
  for (const [token, want] of Object.entries(expected)) assert.equal(range(token), want, token);
});

test('weeks start on Monday: on a Monday, Sunday and the first of January', () => {
  assert.equal(range('wtd', '2026-10-05'), '2026-10-05..2026-10-05');
  assert.equal(range('wtd', '2026-10-11'), '2026-10-05..2026-10-11');
  assert.equal(range('last-week', '2026-10-11'), '2026-09-28..2026-10-04');
  assert.equal(range('wtd', '2027-01-01'), '2026-12-28..2027-01-01');
  assert.equal(range('last-week', '2027-01-01'), '2026-12-21..2026-12-27');
});

test('presets cross year boundaries and leap days', () => {
  assert.equal(range('yesterday', '2027-01-01'), '2026-12-31..2026-12-31');
  assert.equal(range('last-month', '2027-01-15'), '2026-12-01..2026-12-31');
  assert.equal(range('last-quarter', '2027-02-10'), '2026-10-01..2026-12-31');
  assert.equal(range('last-12m', '2027-01-15'), '2026-01-01..2026-12-31');
  assert.equal(range('last-month', '2028-03-10'), '2028-02-01..2028-02-29');
  assert.equal(range('last-7d', '2028-03-02'), '2028-02-25..2028-03-02');
  assert.equal(range('last-365d', '2029-02-28'), '2028-03-01..2029-02-28');
  assert.equal(range('qtd', '2026-12-31'), '2026-10-01..2026-12-31');
});

test('invalid tokens are refused (the app falls back to all)', () => {
  for (const bad of ['', '2026-Q5', '2026-Q0', '2026-H3', '2026-13', '2026-00', '26', 'Q3-2026', '2026-02-30..2026-03-01',
    '2026-10-09..2026-10-01', '2026-10-01-2026-10-09', '01-10-2026..09-10-2026', 'last-8d', 'tomorrow', 'receipts']) {
    assert.equal(parsePeriod(bad, '2026-10-09'), null, bad);
  }
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
});

test('round trip: a fixed token is its own range token; any other range stays from..to', () => {
  for (const token of ['2026', '2026-H1', '2026-H2', '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', '2026-01', '2026-09', '2028-02', '2026-10-01..2026-10-09', '2026-01-01..2026-12-30', '2026-03-01..2026-05-31', '2025-12-01..2026-01-31']) {
    const p = parsePeriod(token, '2026-10-09')!;
    assert.equal(rangeToken(p.from, p.to), token, token);
    assert.equal(parsePeriod(rangeToken(p.from, p.to), '2026-10-09')?.to, p.to);
  }
});

test('the VAT tab: only a range that is exactly a year, half or quarter has a return', () => {
  const vat = (token: string, today = '2026-10-09') => vatPeriodOf(parsePeriod(token, today)!);
  assert.equal(vat('2026-Q3'), '2026-Q3');
  assert.equal(vat('2026-H1'), '2026-H1');
  assert.equal(vat('2026'), '2026');
  assert.equal(vat('last-quarter'), '2026-Q3');
  assert.equal(vat('last-year'), '2025');
  assert.equal(vat('2026-07-01..2026-09-30'), '2026-Q3');
  assert.equal(vat('qtd'), null);
  assert.equal(vat('qtd', '2026-12-31'), '2026-Q4');
  assert.equal(vat('2026-09'), null);
  assert.equal(vat('last-30d'), null);
  assert.equal(vat('all'), null);
});

test('derivePeriod still names only VAT periods', () => {
  assert.equal(derivePeriod('2026-09'), null);
  assert.equal(derivePeriod('qtd'), null);
  assert.deepEqual(derivePeriod('2026-Q4'), { from: '2026-10-01', to: '2026-12-31' });
});

test('inPeriod: inclusive at both ends; undated items show everywhere', () => {
  const p = parsePeriod('2026-10-01..2026-10-09', '2026-10-09')!;
  assert.deepEqual(['2026-09-30', '2026-10-01', '2026-10-09', '2026-10-10'].map((d) => inPeriod(p, d)), [false, true, true, false]);
  assert.equal(inPeriod(p, undefined), true);
});

test('openingBalancesAt: a range that starts mid-year carries the year so far', async () => {
  const { openingBalancesAt } = await import('../src/accounting/ledger.js');
  const e = (id: string, date: string, debit: string, credit: string, amount: number) =>
    ({ id, date, accountDebit: debit, accountCredit: credit, amount, description: id }) as never;
  const entries = [e('a', '2026-02-10', '1020', '3200', 100), e('b', '2026-07-05', '6500', '1020', 30), e('c', '2026-07-20', '1020', '3200', 5)];
  const openings = { '2026': { '1020': 1000 } };
  assert.deepEqual(openingBalancesAt(entries, '2026-01-01', openings), { '1020': 1000 });
  assert.deepEqual(openingBalancesAt(entries, '2026-07-01', openings), { '1020': 1100, '3200': 100 });
  assert.deepEqual(openingBalancesAt(entries, '2026-07-10', openings), { '1020': 1070, '3200': 100, '6500': 30 });
  assert.deepEqual(openingBalancesAt(entries, '0000-01-01', openings), { '1020': 1000 }, "the period 'all' starts at the first openings");
});

test('parseSwissDate: typed dd.mm.yyyy, with or without leading zeros; no impossible days', async () => {
  const { parseSwissDate } = await import('../src/accounting/periods.js');
  assert.equal(parseSwissDate('09.10.2026'), '2026-10-09');
  assert.equal(parseSwissDate(' 9.1.2026 '), '2026-01-09');
  assert.equal(parseSwissDate('29.02.2028'), '2028-02-29');
  for (const bad of ['29.02.2026', '2026-10-09', '9/10/2026', '32.01.2026', '1.13.2026', '']) assert.equal(parseSwissDate(bad), null, bad);
});

test('periodContaining: a link keeps the current period when it holds the date, else the quarter', async () => {
  const { periodContaining } = await import('../src/accounting/periods.js');
  const qtd = parsePeriod('qtd', '2026-10-09')!;
  assert.equal(periodContaining('2026-10-02', qtd), 'qtd');
  assert.equal(periodContaining('2026-05-31', qtd), '2026-Q2');
  assert.equal(periodContaining('2025-12-31', parsePeriod('2026', '2026-10-09')!), '2025-Q4');
  assert.equal(periodContaining('2026-01-01', parsePeriod('all', '2026-10-09')!), 'all');
  assert.equal(periodContaining(undefined, qtd), 'all');
  assert.equal(periodContaining('2026-08-15'), '2026-Q3', 'without a current period: the quarter');
});
