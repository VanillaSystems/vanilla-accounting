/**
 * The tax at source (docs/specs/payroll.md §3f, §13 B2, §15.4): the tariff file's reader, and the payslip's
 * tax by the monthly model against values read directly from the cantons' tariff files of 2026.
 *
 * tests/fixtures/qst/tar26<kt>-excerpt.txt are excerpts of the ESTV's files for wages (tar26zh.txt of
 * 08.12.2025, tar26be.txt of 27.11.2025, tar26lu.txt of 26.11.2025, tar26ag.txt of 04.03.2026, the AG file
 * corrected during the year), fetched 2026-11-19 from www.estv2.admin.ch/qst/2026/loehne/: the header,
 * the brackets around the incomes of the tests of ten codes, the commission and median records unchanged; the
 * trailer's count is that of the excerpt. The expected rates and minimums are the full files' for those
 * incomes (looked up in them, not in the excerpts); the taxes are base × rate, rounded to 5 Rappen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bracketOf, parseTariffFile, provisionOf, TariffFileError } from '../src/providers/tax-at-source/tariff-file.js';
import { computePayslip } from '../src/payroll/compute.js';
import { tariffCode, type LoadedTariff } from '../src/payroll/tax-at-source.js';
import { roundStep } from '../src/payroll/money.js';
import { bookingOf } from '../src/payroll/booking.js';
import { settlementsOf } from '../src/payroll/settlement.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import type { TaxAtSource } from '../src/payroll/model.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { amountOf, ch, closeOf, ctxOf, dated, firm, line, owner } from './support/payroll.js';

const FIX = join(APP_ROOT, 'tests/fixtures/qst');
const text = (kt: string) => readFileSync(join(FIX, `tar26${kt}-excerpt.txt`), 'latin1');
const loaded = (kt: string): LoadedTariff => ({ region: kt.toUpperCase(), year: '2026', file: parseTariffFile(text(kt)), sha256: `sha-${kt}-0123456789abcdef`, fetchedAt: '2026-11-19T10:00:00.000Z' });
const FILES = Object.fromEntries(['zh', 'be', 'lu', 'ag'].map((k) => [k.toUpperCase(), loaded(k)]));
const tariffs = (region: string, year: string) => (year === '2026' ? FILES[region] : undefined);

// ─── the file ──────────────────────────────────────────────────────────────────

test('the reader takes the header, the brackets, the commission and the median', () => {
  const zh = FILES.ZH.file;
  assert.equal(zh.canton, 'ZH');
  assert.equal(zh.created, '2025-12-08');
  assert.equal(FILES.AG.file.created, '2026-03-04');
  assert.equal(provisionOf(zh, 'PEL', '2026-06-30'), 2);
  assert.equal(provisionOf(FILES.BE.file, 'PPA', '2026-06-30'), 1);
  assert.equal(zh.median, 5875);
});

test('a cut file, a mixed file or a mutation is refused, never read', () => {
  const zh = text('zh');
  const lines = zh.split('\r\n').filter(Boolean);
  assert.throws(() => parseTariffFile(lines.slice(0, -1).join('\r\n')), TariffFileError, 'no trailer');
  assert.throws(() => parseTariffFile([...lines.slice(0, 3), ...lines.slice(4)].join('\r\n')), /zählt/, 'a record missing');
  assert.throws(() => parseTariffFile(lines.map((l, i) => (i === 5 ? l.slice(0, 4) + 'BE' + l.slice(6) : l)).join('\r\n')), /Kanton BE/);
  assert.throws(() => parseTariffFile(lines.map((l, i) => (i === 5 ? l.slice(0, 2) + '02' + l.slice(4) : l)).join('\r\n')), /Mutation/);
  assert.throws(() => parseTariffFile('hello'), TariffFileError);
});

test('the bracket is the lower step: 850.50 lies in 801–850 (FAQ KS 45, Frage 4)', () => {
  assert.deepEqual(bracketOf(FILES.ZH.file, 'A0N', 850.5, '2026-01-31'), { from: 801, step: 50, rate: 0.24, minimum: 0 });
  assert.deepEqual(bracketOf(FILES.ZH.file, 'A0N', 851, '2026-01-31')?.from, 851);
  assert.equal(bracketOf(FILES.ZH.file, 'X9N', 5000, '2026-01-31'), undefined);
});

test('a tariff code: two characters take the church flag, three are as written', () => {
  assert.equal(tariffCode('a0', true), 'A0Y');
  assert.equal(tariffCode('B2', false), 'B2N');
  assert.equal(tariffCode('L0N', true), 'L0N');
  assert.equal(tariffCode('G9N', undefined), 'G9N');
  assert.equal(tariffCode('7', false), undefined);
});

// ─── the payslip ───────────────────────────────────────────────────────────────

/** An invented person subject to the tax: wage `amount` a month, code and canton as given. */
function subject(amount: number, tax: TaxAtSource, more: Partial<Parameters<typeof owner>[0]> = {}) {
  return owner({
    id: 'q1', isOwner: false,
    employment: [dated('2026-01-01', { kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })],
    insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' } })],
    taxAtSource: [dated('2026-01-01', tax)], ...more,
  });
}
const draft = (amount: number, tax: TaxAtSource, month = '2026-03', more = {}) => {
  const store = firm([subject(amount, tax, more)]);
  return computePayslip({ ...ctxOf(store), tariffs }, 'q1', month)!;
};
const taxOf = (amount: number, region: string, code: string, church = false) => {
  const d = draft(amount, { subject: true, canton: region, code, church });
  const [l] = line(d, 'quellensteuer');
  return { amount: l?.amount, rate: l?.rate, d };
};

// The golden set: one canton file, several codes and incomes; rate from the full file, tax = wage × rate.
const GOLDEN: Array<[region: string, code: string, church: boolean, wage: number, rate: number, tax: number]> = [
  ['ZH', 'A0', false, 6500, 7.28, 473.20],
  ['ZH', 'A0', true, 6500, 7.47, 485.55],
  ['ZH', 'B2', false, 8000, 2.49, 199.20],
  ['ZH', 'C1', true, 5200.5, 3.96, 205.95],
  ['ZH', 'H1', false, 4000, 0.65, 26.00],
  ['ZH', 'L0', false, 7000, 4.5, 315.00],
  ['ZH', 'M2', true, 9000, 4.5, 405.00],
  ['ZH', 'A0', false, 850.5, 0.24, 2.05],
  ['BE', 'A0', false, 6500, 12.5, 812.50],
  ['BE', 'B2', false, 8000, 6.32, 505.60],
  ['BE', 'L0', false, 7000, 4.5, 315.00],
  ['LU', 'A0', false, 6500, 9.87, 641.55],
  ['LU', 'H1', false, 4000, 0.55, 22.00],
  ['AG', 'A0', false, 6500, 8.4, 546.00],
  ['AG', 'A0', true, 6500, 9.2, 598.00],
  ['AG', 'L0', false, 7000, 4.5, 315.00],
];

for (const [region, code, church, wage, rate, tax] of GOLDEN) {
  test(`golden ${region} ${code}${church ? 'Y' : 'N'} on ${wage}: ${rate} % = ${tax.toFixed(2)}`, () => {
    const got = taxOf(wage, region, code, church);
    assert.equal(got.rate, rate);
    assert.equal(got.amount, tax);
  });
}

test('a canton\'s minimum tax: LU 13.00 and AG 2.00 where the rate gives less (format Ziff. 4.4)', () => {
  assert.equal(taxOf(850.5, 'LU', 'A0').amount, 13);
  assert.equal(taxOf(850.5, 'AG', 'A0').amount, 2);
});

test('a German cross-border worker (L–Q) pays the flat 4.5 % of the file, whatever the income', () => {
  for (const wage of [3000, 9000, 15000]) assert.equal(taxOf(wage, 'ZH', 'L0').rate, 4.5);
  assert.equal(taxOf(15000, 'ZH', 'L0').amount, 675);
});

test('the line names its file, its date, the code and the rate-determining income', () => {
  const [l] = line(taxOf(6500, 'ZH', 'A0').d, 'quellensteuer');
  assert.deepEqual(l.tariff, { region: 'ZH', code: 'A0N', income: 6500, created: '2025-12-08', version: 'sha-zh-01234' });
  assert.equal(l.source, 'tariff:ZH:2026');
  assert.equal(l.base, 6500);
  const d = taxOf(6500, 'ZH', 'A0').d;
  assert.ok(d.used.some((u) => u.path === 'tariffs/ZH/2026' && u.validFrom === '2025-12-08'), 'the close keeps the file it read');
});

test('an entry on the 15th: the wage of 16 days is extrapolated to 30 for the rate, the tax is on what was paid', () => {
  // 6'000 a month from 15 November (30 days): 16 days paid = 3'200; for the rate 3'200 / 16 × 30 = 6'000.
  const d = draft(6000, { subject: true, canton: 'ZH', code: 'A0' }, '2026-11', { employment: [dated('2026-11-15', { kind: 'monthly' as const, amount: 6000, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })] });
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 3200);
  assert.equal(l.tariff?.income, 6000);
  // ZH A0N 5'951–6'000: 6.79 % (the full file); on 3'200 = 217.28 → 217.30.
  assert.equal(l.rate, 6.79);
  assert.equal(l.amount, 217.3);
  // Without the extrapolation the rate would be 3'200's, lower.
  assert.ok(bracketOf(FILES.ZH.file, 'A0N', 3200, '2026-11-30')!.rate < l.rate!);
});

test('an entry on 15 October with calendar days: 17 of 31 days paid, the whole month\'s wage is the rate-determining income', () => {
  const d = draft(7200, { subject: true, canton: 'ZH', code: 'A0' }, '2026-10', { employment: [dated('2026-10-15', { kind: 'monthly' as const, amount: 7200, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })] });
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 3948.4, '7200 × 17 / 31, rounded to 5 Rappen');
  assert.equal(l.tariff?.income, 7200.02, '3948.40 / 17 × 31: the whole month, but for the wage line\'s rounding');
});

test('other employments: unknown extrapolates to 100 %, a known Pensum to the whole, a known income adds', () => {
  const half = { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 6400, pensum: 50, hoursPerWeek: 21, holidayDays: 25 })] };
  // 50 % of 6'400 = 3'200 paid.
  const none = line(draft(6400, { subject: true, canton: 'ZH', code: 'A0' }, '2026-03', half), 'quellensteuer')[0];
  assert.equal(none.tariff?.income, 3200, 'no other employment: the wage as it is (FAQ KS 45, Frage 13)');
  const unknown = line(draft(6400, { subject: true, canton: 'ZH', code: 'A0', otherEmployment: 'unknown' }, '2026-03', half), 'quellensteuer')[0];
  assert.equal(unknown.tariff?.income, 6400);
  const pensum = line(draft(6400, { subject: true, canton: 'ZH', code: 'A0', otherEmployment: { pensum: 30 } }, '2026-03', half), 'quellensteuer')[0];
  assert.equal(pensum.tariff?.income, 5120, '3200 / 50 × 80');
  const income = line(draft(6400, { subject: true, canton: 'ZH', code: 'A0', otherEmployment: { income: 1500 } }, '2026-03', half), 'quellensteuer')[0];
  assert.equal(income.tariff?.income, 4700);
  for (const l of [none, unknown, pensum, income]) assert.equal(l.base, 3200, 'the tax is always on the wage paid here');
});

test('an aperiodic payment (field 3: a bonus) adds to the rate-determining income as it is, never extrapolated', () => {
  const store = firm([subject(6000, { subject: true, canton: 'ZH', code: 'A0' }, { employment: [dated('2026-11-15', { kind: 'monthly' as const, amount: 6000, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })] })]);
  store.monthLines = [{ id: 'm1', employee: 'q1', month: '2026-11', wageType: 'bonus', amount: 1000, enteredAt: '2026-11-01T00:00:00Z' }];
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-11')!;
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 4200);
  assert.equal(l.tariff?.income, 7000, '3200 / 16 × 30 + 1000');
});

test('the commission is the file\'s electronic rate on the tax, an employer line, booked 2279 / 5890', () => {
  const d = taxOf(6500, 'ZH', 'A0').d;
  const [c] = line(d, 'bezugsprovision');
  assert.equal(c.base, 473.2);
  assert.equal(c.rate, 2);
  assert.equal(c.amount, 9.45, '473.20 × 2 % = 9.464, rounded to 5 Rappen as the tax (§22 decision 121)');
  assert.equal(c.side, 'employer');
  const b = bookingOf(d, ctxOf(firm()).data, firm());
  const tax = b.postings.find((p) => p.wageType === 'quellensteuer')!;
  const com = b.postings.find((p) => p.wageType === 'bezugsprovision')!;
  assert.deepEqual([tax.debit, tax.credit, tax.amount], ['1091', '2279', 473.2]);
  assert.deepEqual([com.debit, com.credit, com.amount], ['2279', '5890', 9.45]);
  // The payout is net of the tax; the commission is no money of the person's.
  assert.equal(d.net, Math.round((d.gross - d.deductions) * 100) / 100);
  assert.ok(d.lines.every((l) => l.wageType !== 'bezugsprovision' || l.side === 'employer'));
});

test('a firm\'s own commission rate for the canton (a paper settlement) replaces the file\'s', () => {
  const store = firm([subject(6500, { subject: true, canton: 'BE', code: 'A0' })]);
  store.insurances.push({ id: 'qbe', kind: 'qst', name: 'Steuerverwaltung Beispiel', customerNumber: 'QST-1', solutions: [{ code: 'BE', rates: [dated('2026-01-01', { provision: 1 })] }], validFrom: '2026-01-01' });
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-03')!;
  assert.equal(line(d, 'bezugsprovision')[0].rate, 1);
  assert.equal(amountOf(d, 'bezugsprovision'), 8.15, '812.50 × 1 % = 8.125, to 5 Rappen');
});

test('without the canton\'s file the line is «unvollständig: Tarif ZH 2026 nicht geladen», never a guess', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const d = computePayslip({ ...ctxOf(store), tariffs: () => undefined }, 'q1', '2026-03')!;
  assert.equal(line(d, 'quellensteuer').length, 0);
  assert.ok(d.missing.some((m) => m.wageType === 'quellensteuer' && m.missing === 'tariff:ZH:2026'));
});

test('a canton on the annual model, a missing code, an unknown code: each «unvollständig» with its reason', () => {
  const missing = (tax: TaxAtSource) => draft(6500, tax).missing.find((m) => m.wageType === 'quellensteuer')?.missing;
  assert.equal(missing({ subject: true, canton: 'GE', code: 'A0' }), 'annualModel:GE');
  assert.equal(missing({ subject: true, canton: 'ZH' }), 'taxCode');
  assert.equal(missing({ subject: true, code: 'A0' }), 'taxRegion');
  assert.equal(missing({ subject: true, canton: 'ZH', code: 'X0' }), 'taxCodeUnknown:X0N');
  assert.equal(missing({ subject: false, canton: 'ZH', code: 'A0' }), undefined);
});

test('the settlement list per canton and month equals what the payslips booked on 2279', () => {
  const store = firm([
    subject(6500, { subject: true, canton: 'ZH', code: 'A0' }),
    { ...subject(7000, { subject: true, canton: 'ZH', code: 'L0' }), id: 'q2', name: [dated('2026-01-01', { first: 'Jonas', last: 'Grenzgänger' })] },
    { ...subject(6500, { subject: true, canton: 'BE', code: 'B2' }), id: 'q3', name: [dated('2026-01-01', { first: 'Ana', last: 'Muster' })] },
  ]);
  const ctx = { ...ctxOf(store), tariffs };
  const closes = ['q1', 'q2', 'q3'].map((id) => closeOf(computePayslip(ctx, id, '2026-03')!));
  const lists = settlementsOf(closes, '2026', ctx.data, firmWageTypes(ctx.data, store), store);
  assert.deepEqual(lists.map((s) => `${s.month} ${s.region} ${s.rows.length}`), ['2026-03 BE 1', '2026-03 ZH 2']);
  const zh = lists.find((s) => s.region === 'ZH')!;
  assert.equal(zh.totals.tax, 788.2, '473.20 + 315.00');
  assert.equal(zh.totals.commission, 15.75, '9.45 + 6.30');
  // 2279's movements of the month: credits the tax, debits the commission.
  let credit = 0; let debit = 0;
  for (const c of closes) for (const p of bookingOf(c, ctx.data, store).postings) {
    if (p.credit === '2279') credit += p.amount;
    if (p.debit === '2279') debit += p.amount;
  }
  const all = lists.reduce((s, x) => ({ tax: s.tax + x.totals.tax, commission: s.commission + x.totals.commission, payable: s.payable + x.totals.payable }), { tax: 0, commission: 0, payable: 0 });
  assert.equal(Math.round(credit * 100), Math.round(all.tax * 100));
  assert.equal(Math.round(debit * 100), Math.round(all.commission * 100));
  assert.equal(Math.round((credit - debit) * 100), Math.round(all.payable * 100));
});

// ─── review fixes (2026-11-19) ─────────────────────────────────────────────────

import { affectedByTariff } from '../src/payroll/settings.js';
import type { PayslipEvent } from '../src/payroll/model.js';

const withQst = (store: ReturnType<typeof firm>, rates: Record<string, number>, account?: string) => {
  store.insurances.push(...Object.entries(rates).map(([region, provision]) => ({
    id: `q${region}`, kind: 'qst', name: `Steuerverwaltung ${region}`, customerNumber: `K-${region}`, ...(account ? { account } : {}),
    solutions: [{ code: region, rates: [dated('2026-01-01', { provision })] }], validFrom: '2026-01-01',
  })));
  return store;
};
const correction = (of: string, amount: number, at = '2026-04-02T00:00:00.000Z'): PayslipEvent =>
  ({ event: 'correction', id: `co-${of}-${amount}`, of, wageType: 'quellensteuer', side: 'employee', amount, at, by: 'person' });

/** What the closes book on 2279: the tax credited, the commission debited. */
function byRegionAndBooked(closes: ReturnType<typeof closeOf>[], store: ReturnType<typeof firm>) {
  const data = ctxOf(store).data;
  let credit = 0; let debit = 0;
  for (const c of closes) for (const p of bookingOf(c, data, store).postings) { if (p.credit === '2279') credit += p.amount; if (p.debit === '2279') debit += p.amount; }
  return { credit: Math.round(credit * 100) / 100, debit: Math.round(debit * 100) / 100 };
}

test('a canton move ZH → BE with a carried correction and the firm\'s rates: each canton\'s list has its tax and its commission', () => {
  const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' });
  p.taxAtSource = [...p.taxAtSource!, dated('2026-04-01', { subject: true, canton: 'BE', code: 'A0' })];
  const store = withQst(firm([p]), { ZH: 2, BE: 1 });
  const ev: PayslipEvent[] = [];
  const mar = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-03')!); ev.push(mar, correction(mar.id, 100));
  const apr = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-04')!);
  // April: BE's own tax at BE's 1 %, the ZH correction of 100 at ZH's 2 %, each line naming its canton.
  assert.deepEqual(line(apr as never, 'bezugsprovision').map((l) => [l.tariff?.region, l.base, l.rate, l.amount]), [['ZH', 100, 2, 2], ['BE', 812.5, 1, 8.15]]);
  const lists = settlementsOf([mar, apr], '2026', ctxOf(store).data, firmWageTypes(ctxOf(store).data, store), store);
  const april = lists.filter((s) => s.month === '2026-04');
  assert.deepEqual(april.map((s) => [s.region, s.totals.tax, s.totals.commission, s.insurer?.customerNumber]), [['BE', 812.5, 8.15, 'K-BE'], ['ZH', 100, 2, 'K-ZH']]);
  const all = lists.reduce((s, x) => ({ tax: s.tax + x.totals.tax, commission: s.commission + x.totals.commission }), { tax: 0, commission: 0 });
  const b = byRegionAndBooked([mar, apr], store);
  assert.equal(Math.round(all.tax * 100), Math.round(b.credit * 100), 'the lists\' tax = 2279\'s credits');
  assert.equal(Math.round(all.commission * 100), Math.round(b.debit * 100), 'the lists\' commission = 2279\'s debits');
});

test('a month that only carries a correction after the exit: its commission is listed and booked, with the firm\'s rate or the file\'s', () => {
  for (const firmRate of [true, false]) {
    const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' }, { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 6500, pensum: 100, hoursPerWeek: 42, holidayDays: 25 }, undefined, '2026-03-31')] });
    const store = firmRate ? withQst(firm([p]), { ZH: 2 }) : firm([p]);
    const ev: PayslipEvent[] = [];
    const mar = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-03')!); ev.push(mar, correction(mar.id, 100));
    const aprD = computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-04')!;
    assert.deepEqual(line(aprD, 'bezugsprovision').map((l) => [l.tariff?.region, l.amount]), [['ZH', 2]]);
    const apr = closeOf(aprD);
    const april = settlementsOf([mar, apr], '2026', ctxOf(store).data, firmWageTypes(ctxOf(store).data, store), store).find((s) => s.month === '2026-04')!;
    const b = byRegionAndBooked([apr], store);
    assert.deepEqual([april.region, april.totals.tax, april.totals.commission, april.totals.payable], ['ZH', 100, 2, 98]);
    assert.deepEqual([b.credit, b.debit], [100, 2]);
  }
});

test('no longer subject: a carried tax correction still takes its commission', () => {
  const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' });
  p.taxAtSource = [...p.taxAtSource!, dated('2026-04-01', { subject: false })];
  const store = firm([p]);
  const ev: PayslipEvent[] = [];
  const mar = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-03')!); ev.push(mar, correction(mar.id, -50));
  const apr = computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-04')!;
  assert.deepEqual(line(apr, 'quellensteuer').map((l) => [l.amount, l.corrects]), [[-50, mar.id]]);
  assert.deepEqual(line(apr, 'bezugsprovision').map((l) => [l.tariff?.region, l.amount]), [['ZH', -1]]);
});

const noFile = () => undefined;
/** The ZH file with A0N 6'451–6'500 at 7.50 % instead of 7.28 %: an invented correction, not the canton's. */
const corrected = (): LoadedTariff => {
  const t = text('zh').replace(/^00ZH {15}20251208/m, `00ZH${' '.repeat(15)}20260304`).replace(/^(0601ZHA0N {7}20260101000645100000005000 00000000000)00728/m, '$100750');
  return { region: 'ZH', year: '2026', file: parseTariffFile(t), sha256: 'sha-zh-corrected-0123', fetchedAt: '2026-11-19T10:00:00.000Z' };
};

test('the first file after a hand correction of the missing tax: compared with what the payslip withheld and its corrections, nothing twice', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const ev: PayslipEvent[] = [];
  const sep = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs: noFile }, 'q1', '2026-09')!);
  assert.equal(line(sep as never, 'quellensteuer').length, 0, 'closed without the file');
  ev.push(sep, correction(sep.id, 473.2, '2026-10-02T00:00:00.000Z'));
  const ctx = { ...ctxOf(store, ev), tariffs: noFile };
  const aff = affectedByTariff(ctx, { ...ctx, tariffs });
  assert.deepEqual(aff.flatMap((a) => a.differences.filter((d) => d.carry)), [], 'the hand correction already carries the tax');
});

test('«So lassen» on the first file, then a corrected file: the card shows what the month withheld (0) against the new tax', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const ev: PayslipEvent[] = [];
  const sep = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs: noFile }, 'q1', '2026-09')!);
  ev.push(sep, { event: 'keep', id: sep.id, at: '2026-10-02T00:00:00.000Z', by: 'person', path: 'tariffs/ZH/2026', validFrom: '2025-12-08' });
  const ctx = { ...ctxOf(store, ev), tariffs };
  const fixed = corrected();
  const aff = affectedByTariff(ctx, { ...ctx, tariffs: (r, y) => (r === 'ZH' && y === '2026' ? fixed : tariffs(r, y)) });
  const tax = aff[0].differences.find((d) => d.wageType === 'quellensteuer')!;
  assert.deepEqual([tax.before, tax.after, tax.diff, tax.carry], [0, 487.5, 487.5, true], '0 → 6500 × 7.50 %, never the files\' 14.30');
  assert.equal(aff[0].differences.find((d) => d.wageType === 'bezugsprovision')?.carry, false);
});

test('an hourly wage from the 16th: what is paid as worked counts as paid, never extrapolated (§22 decision 94)', () => {
  const p = subject(0, { subject: true, canton: 'ZH', code: 'A0' }, { employment: [dated('2026-11-16', { kind: 'hourly' as const, amount: 40, hoursPerWeek: 42, holidayDays: 25 })] });
  const store = firm([p]);
  store.monthLines = [{ id: 'm1', employee: 'q1', month: '2026-11', wageType: 'stundenlohn', quantity: 80, enteredAt: '2026-11-01T00:00:00Z' }];
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-11')!;
  const [l] = line(d, 'quellensteuer');
  // 80 h × 40 and the holiday surcharge on them (B1), all paid as worked.
  assert.equal(l.base, d.gross);
  assert.ok(l.base! > 3200);
  assert.equal(l.tariff?.income, l.base, 'not extrapolated to 30 days');
});

test('a monthly wage from the 16th with a child allowance entered in full: only the prorated wage is extrapolated', () => {
  const store = firm([subject(6000, { subject: true, canton: 'ZH', code: 'A0' }, { employment: [dated('2026-11-16', { kind: 'monthly' as const, amount: 6000, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })] })]);
  store.monthLines = [{ id: 'm1', employee: 'q1', month: '2026-11', wageType: 'kinderzulage', amount: 215, enteredAt: '2026-11-01T00:00:00Z' }];
  const [l] = line(computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-11')!, 'quellensteuer');
  // 6000 × 15/30 = 3000 paid, back to 6000; the allowance of 215 as paid.
  assert.equal(l.base, 3215);
  assert.equal(l.tariff?.income, 6215);
});

test('the commission books on the canton\'s own insurance (one per canton, each its account)', () => {
  const store = withQst(firm([subject(6500, { subject: true, canton: 'BE', code: 'A0' })]), { ZH: 2 });
  withQst(store, { BE: 1 }, '2278');
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-03')!;
  const b = bookingOf(d, ctxOf(store).data, store);
  assert.deepEqual(b.postings.filter((p) => /quellensteuer|bezugsprovision/.test(p.wageType)).map((p) => [p.debit, p.credit]), [['1091', '2278'], ['2278', '5890']]);
});

test('a byte-order mark before the header is read past', () => {
  assert.equal(parseTariffFile(`﻿${text('zh')}`).canton, 'ZH');
  assert.equal(parseTariffFile(`ï»¿${text('zh')}`).canton, 'ZH');
});

// ─── with B1 (absences, the Nachzahlung after the exit) ─────────────────────────

test('a month of illness with daily allowances: the tax on the whole taxable wage, the allowance included, a full month not extrapolated', () => {
  const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' }, {
    absences: [{ id: 'ab1', kind: 'illness', from: '2026-09-07', to: '2026-09-20', continuedPay: 100, dailyAllowance: 157.8, allowanceFrom: '2026-09-09', enteredAt: '2026-09-21T00:00:00Z' }],
  });
  const d = computePayslip({ ...ctxOf(firm([p])), tariffs }, 'q1', '2026-09')!;
  const types = firmWageTypes(ctxOf(firm()).data, firm());
  const qstBase = d.lines.filter((l) => types.get(l.wageType)?.bases.includes('qst') && l.side === 'employee').reduce((s, l) => s + (types.get(l.wageType)!.sign === '-' ? -l.amount : l.amount), 0);
  const [l] = line(d, 'quellensteuer');
  assert.ok(d.lines.some((x) => x.wageType === 'taggeld-ktg'), 'the daily allowance is on the payslip');
  assert.equal(l.base, Math.round(qstBase * 100) / 100, 'every line counting for the tax at source, the allowance included');
  assert.equal(l.tariff?.income, l.base, 'a whole month employed: nothing extrapolated');
  assert.equal(l.rate, bracketOf(FILES.ZH.file, 'A0N', l.base!, '2026-09-30')!.rate);
  assert.equal(line(d, 'bezugsprovision')[0].base, l.amount);
});

test('a Nachzahlung after the exit: taxed at the rate of the exit month\'s income plus the payment (FAQ KS 45, Frage 16)', () => {
  const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' }, { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 6500, pensum: 100, hoursPerWeek: 42, holidayDays: 25 }, undefined, '2026-06-30')] });
  const store = firm([p]);
  const ev: PayslipEvent[] = [];
  for (const m of ['2026-05', '2026-06']) ev.push(closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', m)!));
  store.monthLines = [{ id: 'nz', employee: 'q1', month: '2026-12', wageType: 'bonus', amount: 1000, enteredAt: '2026-12-02T00:00:00Z' }];
  const d = computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-12')!;
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 1000);
  assert.equal(l.tariff?.income, 7500, 'June\'s 6,500 + the 1,000 paid now');
  assert.equal(l.rate, bracketOf(FILES.ZH.file, 'A0N', 7500, '2026-12-31')!.rate);
  assert.equal(l.amount, roundStep(1000 * l.rate! / 100, 0.05));
  assert.equal(line(d, 'bezugsprovision')[0].tariff?.region, 'ZH');
});

// ─── the third walk's fixes (2026-11-19) ────────────────────────────────────────

import { affectedBetween, backdatedCorrections } from '../src/payroll/settings.js';

test('a code changed back over October: November\'s list has its own row and October\'s correction as a row of its own (§22 decision 120)', () => {
  const p = { ...subject(6500, { subject: true, canton: 'ZH', code: 'L0' }), name: [dated('2026-01-01', { first: 'Jonas', last: 'Grenzgänger' })] };
  const store = firm([p]);
  const ev: PayslipEvent[] = [];
  const oct = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-10')!); ev.push(oct);
  assert.deepEqual(line(oct as never, 'quellensteuer').map((l) => [l.tariff?.code, l.amount]), [['L0N', 292.5]]);
  // The certificate of residence was missing: A0 from October, dated back over the closed month.
  const changed = structuredClone(store);
  changed.employees[0].taxAtSource = [dated('2026-10-01', { subject: true, canton: 'ZH', code: 'A0' })];
  const ctx = { ...ctxOf(store, ev), tariffs };
  const aff = affectedBetween(ctx, { ...ctx, store: changed });
  let n = 0;
  const corrections = backdatedCorrections(ctx, aff, () => `co${++n}`, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(corrections.map((c) => [c.wageType, c.amount, c.tariff]), [['quellensteuer', 180.7, { region: 'ZH', code: 'A0N', income: 6500, wage: 6500, rate: 7.28 }]]);
  ev.push(...corrections);
  const nov = closeOf(computePayslip({ ...ctxOf(changed, ev), tariffs }, 'q1', '2026-11')!);
  const lists = settlementsOf([oct, nov], '2026', ctx.data, firmWageTypes(ctx.data, changed), changed);
  const november = lists.find((s) => s.month === '2026-11')!;
  assert.deepEqual(november.rows.map((r) => [r.corrects, r.code, r.wage, r.income, r.rate, r.tax]), [
    [undefined, 'A0N', 6500, 6500, 7.28, 473.2],
    ['2026-10', 'A0N', 6500, 6500, 7.28, 180.7],
  ], 'November\'s own tax, and October\'s correction: 473.20 under A0N less the 292.50 withheld under L0N');
  const booked = byRegionAndBooked([nov], changed);
  assert.equal(november.totals.wage, 6500, 'the wage total is the month\'s own');
  assert.equal(november.totals.tax, booked.credit, 'the list\'s tax = 2279\'s credits');
  assert.equal(Math.round(november.rows.reduce((s, r) => s + r.commission, 0) * 100) / 100, booked.debit, 'the rows\' commissions = 2279\'s debit');
  assert.equal(november.totals.payable, Math.round((booked.credit - booked.debit) * 100) / 100);
  assert.ok(november.rows.every((r) => r.commission > 0), 'each row carries its own commission');
});

test('a correction entered by hand: its own row with the corrected month\'s code, its wage and rate not known', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const ev: PayslipEvent[] = [];
  const mar = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-03')!); ev.push(mar, correction(mar.id, 50));
  const apr = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-04')!);
  const april = settlementsOf([mar, apr], '2026', ctxOf(store).data, firmWageTypes(ctxOf(store).data, store), store).find((s) => s.month === '2026-04')!;
  const row = april.rows.find((r) => r.corrects === '2026-03')!;
  assert.deepEqual([row.code, row.wage, row.rate, row.tax], ['A0N', undefined, undefined, 50]);
  assert.equal(april.rows.length, 2);
});

import { lineSource, sourceText } from '../src/payroll/sources.js';

test('an L code\'s tax line says the 4.5 % depends on the certificate of residence (Gre-1/Gre-2), in the payslip\'s language; A0 and the commission say nothing (§22 decision 123)', () => {
  const data = ctxOf(firm()).data;
  const textOf = (code: string, wageType: string, lang: 'de' | 'fr' | 'it' | 'en') => {
    const d = draft(7000, { subject: true, canton: 'ZH', code });
    const [l] = line(d, wageType);
    const s = lineSource(l, d, data, ch.payrollYears, []);
    return s && sourceText(s, data.documents, lang);
  };
  assert.equal(textOf('L0', 'quellensteuer', 'de'), 'Tarif ZH 2026 vom 08.12.2025 · L0N · satzbestimmend 7\'000.00 · Grenzgängertarif 4.5 % nur mit gültiger Ansässigkeitsbescheinigung (Formular Gre-1, Verlängerung Gre-2); ohne sie gilt der ordentliche Tarif');
  assert.match(textOf('M2', 'quellensteuer', 'fr')!, /attestation de résidence valable \(formulaire Gre-1, prolongation Gre-2\) ; sans elle, le barème ordinaire s’applique$/);
  assert.match(textOf('L0', 'quellensteuer', 'it')!, /certificato di residenza.*Gre-1.*tariffa ordinaria$/);
  assert.match(textOf('L0', 'quellensteuer', 'en')!, /certificate of residence \(form Gre-1, renewal Gre-2\); without it the ordinary tariff applies$/);
  assert.doesNotMatch(textOf('A0', 'quellensteuer', 'de')!, /Gre-1/);
  assert.doesNotMatch(textOf('L0', 'bezugsprovision', 'de')!, /Gre-1/, 'the commission names only its file');
});

// ─── review of the third walk's fixes ───────────────────────────────────────────

/** What the closes book per liability account of the tax at source: the tax credited less the commission debited. */
function owedOn(closes: ReturnType<typeof closeOf>[], store: ReturnType<typeof firm>): Record<string, number> {
  const m: Record<string, number> = {};
  const add = (a: string, x: number) => { m[a] = Math.round(((m[a] ?? 0) + x) * 100) / 100; };
  for (const c of closes) for (const p of bookingOf(c, ctxOf(store).data, store).postings) {
    if (!/quellensteuer|bezugsprovision/.test(p.wageType)) continue;
    if (/^227/.test(p.credit)) add(p.credit, p.amount);
    if (/^227/.test(p.debit)) add(p.debit, -p.amount);
  }
  return m;
}

test('a tariff file that only changes a closed month\'s commission by its rounding: no card, nothing to do', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const mar = closeOf(computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-03')!);
  // Closed before the commission was rounded to 5 Rappen: 9.46.
  mar.lines = mar.lines.map((l) => (l.wageType === 'bezugsprovision' ? { ...l, amount: 9.46 } : l));
  const ctx = { ...ctxOf(store, [mar]), tariffs };
  assert.deepEqual(affectedByTariff(ctx, { ...ctx, tariffs }), []);
});

test('a canton move ZH → BE dated back over a closed October: the tax back from ZH and owed to BE, each list right, totals = 2279', () => {
  const store = withQst(firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]), { ZH: 2, BE: 1 });
  const ev: PayslipEvent[] = [];
  const oct = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-10')!); ev.push(oct);
  const changed = structuredClone(store);
  changed.employees[0].taxAtSource = [dated('2026-01-01', { subject: true, canton: 'ZH', code: 'A0' }), dated('2026-10-01', { subject: true, canton: 'BE', code: 'A0' })];
  const ctx = { ...ctxOf(store, ev), tariffs };
  const aff = affectedBetween(ctx, { ...ctx, store: changed });
  let n = 0;
  const cs = backdatedCorrections(ctx, aff, () => `cb${++n}`, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(cs.map((c) => [c.tariff?.region, c.amount]), [['ZH', -473.2], ['BE', 812.5]]);
  ev.push(...cs);
  const nov = closeOf(computePayslip({ ...ctxOf(changed, ev), tariffs }, 'q1', '2026-11')!);
  const lists = settlementsOf([oct, nov], '2026', ctx.data, firmWageTypes(ctx.data, changed), changed).filter((s) => s.month === '2026-11');
  assert.deepEqual(lists.map((s) => [s.region, s.rows.map((r) => [r.corrects ?? 'own', r.code, r.rate, r.tax])]), [
    ['BE', [['own', 'A0N', 12.5, 812.5], ['2026-10', 'A0N', 12.5, 812.5]]],
    ['ZH', [['2026-10', 'A0N', 7.28, -473.2]]],
  ]);
  const all = settlementsOf([oct, nov], '2026', ctx.data, firmWageTypes(ctx.data, changed), changed).reduce((s, x) => s + x.totals.payable, 0);
  assert.equal(Math.round(all * 100) / 100, owedOn([oct, nov], changed)['2279']);
});

test('a correction entered by hand books, takes its commission and is listed in the corrected month\'s canton, on that canton\'s account', () => {
  const p = subject(6500, { subject: true, canton: 'ZH', code: 'A0' });
  p.taxAtSource = [...p.taxAtSource!, dated('2026-11-01', { subject: true, canton: 'BE', code: 'A0' })];
  const store = withQst(firm([p]), { BE: 1, ZH: 2 });
  store.insurances.find((i) => i.id === 'qBE')!.account = '2278';
  const ev: PayslipEvent[] = [];
  const oct = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-10')!); ev.push(oct, correction(oct.id, 100, '2026-11-02T00:00:00.000Z'));
  const nov = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-11')!);
  assert.equal(line(nov as never, 'quellensteuer').find((l) => l.corrects)?.tariff?.region, 'ZH', 'the line names the corrected month\'s canton');
  const lists = settlementsOf([oct, nov], '2026', ctxOf(store).data, firmWageTypes(ctxOf(store).data, store), store);
  const payable = (region: string) => Math.round(lists.filter((s) => s.region === region).reduce((s, x) => s + x.totals.payable, 0) * 100) / 100;
  assert.deepEqual(owedOn([oct, nov], store), { '2279': payable('ZH'), '2278': payable('BE') });
  assert.equal(payable('BE'), 804.35, 'BE\'s own November only');
});

test('an exact half of 5 Rappen is rounded up (FAQ KS 45 no. 5 «kaufmännisch»; its own example rounds 466.725 down, §22 decision 126)', () => {
  assert.equal(roundStep(466.725, 0.05), 466.75);
  assert.equal(roundStep(10.075, 0.05), 10.1);
  assert.equal(roundStep(10.025, 0.05), 10.05);
  // 6,505 × 4.5 % = 292.725 on the flat L0 tariff: 292.75.
  const [l] = line(draft(6505, { subject: true, canton: 'ZH', code: 'L0' }), 'quellensteuer');
  assert.deepEqual([l.base, l.rate, l.amount], [6505, 4.5, 292.75]);
});

import { lohnausweisOf } from '../src/payroll/documents.js';

test('the Lohnausweis\'s field 12 is the tax withheld, before the commission the employer keeps (KS 45 Ziff. 9.1)', () => {
  const store = firm([subject(6500, { subject: true, canton: 'ZH', code: 'A0' })]);
  const ev: PayslipEvent[] = [];
  for (const m of ['2026-01', '2026-02', '2026-03']) ev.push(closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', m)!));
  const closes = ev as ReturnType<typeof closeOf>[];
  assert.ok(closes.every((c) => line(c as never, 'bezugsprovision')[0]?.amount === 9.45), 'each month keeps a commission of 9.45');
  const la = lohnausweisOf(store.employees[0], closes, firmWageTypes(ctxOf(store).data, store), ctxOf(store).data, '2026');
  assert.equal(la.fields['12'], 1420, '3 × 473.20 = 1,419.60, in whole francs; not less the 28.35 of commission');
});

test('a hand correction of a month closed without its tax line books in the person\'s canton of that month, on its office\'s account', () => {
  const store = withQst(firm([subject(6500, { subject: true, canton: 'BE', code: 'A0' })]), { ZH: 2, BE: 1 });
  store.insurances.find((i) => i.id === 'qBE')!.account = '2278';
  const ev: PayslipEvent[] = [];
  const oct = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs: noFile }, 'q1', '2026-10')!); ev.push(oct);
  assert.equal(line(oct as never, 'quellensteuer').length, 0, 'closed without the file');
  ev.push(correction(oct.id, 800, '2026-11-01T00:00:00.000Z'));
  const nov = closeOf(computePayslip({ ...ctxOf(store, ev), tariffs }, 'q1', '2026-11')!);
  assert.equal(line(nov as never, 'quellensteuer').find((l) => l.corrects)?.tariff?.region, 'BE');
  const owed = owedOn([nov], store);
  assert.equal(owed['2279'], undefined, 'nothing on the ZH office\'s account');
  const lists = settlementsOf([oct, nov], '2026', ctxOf(store).data, firmWageTypes(ctxOf(store).data, store), store);
  assert.deepEqual(lists.map((s) => [s.region, s.rows.map((r) => [r.corrects ?? 'own', r.tax])]), [['BE', [['own', 812.5], ['2026-10', 800]]]]);
  assert.equal(owed['2278'], lists[0].totals.payable);
});
