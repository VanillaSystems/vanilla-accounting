/**
 * The tax at source (docs/specs/payroll.md §3f, §13 B2, §15.4): the tariff file's reader, and the payslip's
 * tax by the monthly model against values read directly from the cantons' tariff files of 2026.
 *
 * tests/fixtures/qst/tar26<kt>-excerpt.txt are excerpts of the ESTV's files for wages (tar26zh.txt of
 * 08.12.2025, tar26be.txt of 27.11.2025, tar26lu.txt of 26.11.2025, tar26ag.txt of 04.03.2026, the AG file
 * corrected during the year), fetched 2026-11-19 from www.estv2.admin.ch/qst/2026/loehne/: the header,
 * the brackets around the incomes below of ten codes, the commission and median records unchanged; the
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
import { bookingOf } from '../src/payroll/booking.js';
import { settlementsOf } from '../src/payroll/settlement.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import type { TaxAtSource } from '../src/payroll/model.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { amountOf, closeOf, ctxOf, dated, firm, line, owner } from './support/payroll.js';

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
  assert.equal(c.amount, 9.46);
  assert.equal(c.side, 'employer');
  const b = bookingOf(d, ctxOf(firm()).data, firm());
  const tax = b.postings.find((p) => p.wageType === 'quellensteuer')!;
  const com = b.postings.find((p) => p.wageType === 'bezugsprovision')!;
  assert.deepEqual([tax.debit, tax.credit, tax.amount], ['1091', '2279', 473.2]);
  assert.deepEqual([com.debit, com.credit, com.amount], ['2279', '5890', 9.46]);
  // The payout is net of the tax; the commission is no money of the person's.
  assert.equal(d.net, Math.round((d.gross - d.deductions) * 100) / 100);
  assert.ok(d.lines.every((l) => l.wageType !== 'bezugsprovision' || l.side === 'employer'));
});

test('a firm\'s own commission rate for the canton (a paper settlement) replaces the file\'s', () => {
  const store = firm([subject(6500, { subject: true, canton: 'BE', code: 'A0' })]);
  store.insurances.push({ id: 'qbe', kind: 'qst', name: 'Steuerverwaltung Beispiel', customerNumber: 'QST-1', solutions: [{ code: 'BE', rates: [dated('2026-01-01', { provision: 1 })] }], validFrom: '2026-01-01' });
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'q1', '2026-03')!;
  assert.equal(line(d, 'bezugsprovision')[0].rate, 1);
  assert.equal(amountOf(d, 'bezugsprovision'), 8.13, '812.50 × 1 %');
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
  assert.equal(zh.totals.commission, 15.76, '9.46 + 6.30');
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
