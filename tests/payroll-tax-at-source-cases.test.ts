/**
 * The tax at source's special cases (docs/specs/payroll.md §22 decisions 119 on): a wage not paid monthly (the 180-hours
 * rule), against the worked examples of the ESTV's Kreisschreiben Nr. 45 of 12.6.2019 (KS 45) and the rates of the
 * cantons' tariff files of 2026.
 *
 * tests/fixtures/qst/tar26<kt>-excerpt.txt are excerpts of the ESTV's files for wages (see
 * tests/payroll-tax-at-source.test.ts); the brackets these tests need were added from the full files fetched on
 * 2026-11-19 from www.estv2.admin.ch/qst/2026/loehne/, unchanged, and the trailer's count is that of the excerpt.
 * The rates below were read in the full files; the taxes are base × rate, rounded to 5 Rappen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTariffFile } from '../src/providers/tax-at-source/tariff-file.js';
import { computePayslip } from '../src/payroll/compute.js';
import type { LoadedTariff } from '../src/payroll/tax-at-source.js';
import { lineSource, sourceText } from '../src/payroll/sources.js';
import type { MonthLine, PayrollEmployee, TaxAtSource } from '../src/payroll/model.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { ch, ctxOf, dated, firm, line, owner } from './support/payroll.js';

const FIX = join(APP_ROOT, 'tests/fixtures/qst');
const loaded = (kt: string): LoadedTariff => ({ region: kt.toUpperCase(), year: '2026', file: parseTariffFile(readFileSync(join(FIX, `tar26${kt}-excerpt.txt`), 'latin1')), sha256: `sha-${kt}-0123456789abcdef`, fetchedAt: '2026-11-19T10:00:00.000Z' });
const FILES: Record<string, LoadedTariff> = Object.fromEntries(['zh'].map((k) => [k.toUpperCase(), loaded(k)]));
const tariffs = (region: string, year: string) => (year === '2026' ? FILES[region] : undefined);

/** An invented person paid by the hour, subject to the tax in ZH; holidays taken as leave unless said otherwise. */
function hourly(rate: number, tax: Partial<TaxAtSource>, more: Partial<PayrollEmployee> = {}, from = '2026-01-01') {
  return owner({
    id: 'h1', isOwner: false,
    employment: [dated(from, { kind: 'hourly' as const, amount: rate, hoursPerWeek: 20, holidayDays: 25, holidayPay: 'leave' as const })],
    insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' } })],
    taxAtSource: [dated('2026-01-01', { subject: true, canton: 'ZH', code: 'A0', ...tax })], ...more,
  });
}
const entered = (month: string, lines: Array<Partial<MonthLine> & { wageType: string }>): MonthLine[] =>
  lines.map((l, i) => ({ id: `m${i}`, employee: 'h1', month, enteredAt: `${month}-01T00:00:00Z`, ...l }));
function slip(p: PayrollEmployee, month: string, lines: MonthLine[]) {
  const store = firm([p]);
  store.monthLines = lines;
  return computePayslip({ ...ctxOf(store), tariffs }, 'h1', month)!;
}

// ─── 1. A wage not paid monthly: 180 hours, 21.667 days (KS 45 Ziff. 6.5) ─────

test('KS 45 Ziff. 6.5 Beispiel 4: 72 hours at 35 from 17 to 28 June, paid at the end: 2520 / 72 × 180 = 6300 sets the rate', () => {
  const d = slip(hourly(35, { notMonthly: true }, {}, '2026-06-17'), '2026-06', entered('2026-06', [{ wageType: 'stundenlohn', quantity: 72 }]));
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 2520);
  assert.equal(l.tariff?.income, 6300, 'no extrapolation of the part month on top: the 180 hours cover it');
  assert.deepEqual(l.tariff?.units, { key: 'hours', paid: 2520, quantity: 72, per: 180 });
  // ZH A0N 6'251–6'300: 7.10 % (the full file); 2520 × 7.10 % = 178.92 → 178.90.
  assert.equal(l.rate, 7.1);
  assert.equal(l.amount, 178.9);
});

test('the same month paid monthly (no flag): the hours count as paid, the rate is that of 2520 (KS 45 Ziff. 6.2, FAQ Frage 13)', () => {
  const d = slip(hourly(35, {}, {}, '2026-06-17'), '2026-06', entered('2026-06', [{ wageType: 'stundenlohn', quantity: 72 }]));
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.tariff?.income, 2520);
  assert.equal(l.tariff?.units, undefined);
  // ZH A0N 2'501–2'550: 1.76 %.
  assert.equal(l.rate, 1.76);
});

test('KS 45 Ziff. 6.5 Beispiel 6: 75 hours at 35, a sick-pay allowance of 2000 and family allowances of 1200: taxed 5825, rate-determining 7500', () => {
  const d = slip(hourly(35, { notMonthly: true }), '2026-07', entered('2026-07', [
    { wageType: 'stundenlohn', quantity: 75 }, { wageType: 'taggeld-ktg', amount: 2000 }, { wageType: 'kinderzulage', amount: 1200 },
  ]));
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 5825, '2625 + 2000 + 1200, all taxed');
  assert.equal(l.tariff?.income, 7500, '2625 / 75 × 180 = 6300, the allowance as paid; the daily allowance sets no rate');
  // ZH A0N 7'451–7'500: 8.24 %; 5825 × 8.24 % = 479.98 → 480.00.
  assert.equal(l.rate, 8.24);
  assert.equal(l.amount, 480);
});

test('the holiday surcharge is paid on the hours and counts in their rate; a bonus sets no rate (KS 45 Ziff. 6.5: «einzig»)', () => {
  // 80 h × 40 = 3200; 5 weeks of holidays: 5 / 47 = 10.64 % → 340.50; (3200 + 340.50) / 80 × 180 = 7966.13.
  const p = hourly(40, { notMonthly: true }, { employment: [dated('2026-01-01', { kind: 'hourly' as const, amount: 40, hoursPerWeek: 20, holidayDays: 25 })] });
  const d = slip(p, '2026-03', entered('2026-03', [{ wageType: 'stundenlohn', quantity: 80 }, { wageType: 'bonus', amount: 1000 }]));
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 4540.5, '3200 + 340.50 + the bonus 1000');
  assert.equal(l.tariff?.income, 7966.13);
  assert.deepEqual(l.tariff?.units, { key: 'hours', paid: 3540.5, quantity: 80, per: 180 });
  // ZH A0N 7'951–8'000: 8.66 %; 4540.50 × 8.66 % = 393.21 → 393.20.
  assert.equal(l.rate, 8.66);
  assert.equal(l.amount, 393.2);
});

test('other employments are covered by the 180 hours: no extrapolation to 100 % on top (KS 45 Ziff. 6.5, Beispiel 3)', () => {
  // Beispiel 3: 70 h at 23 = 1610, another 50 % job unknown to the firm: 1610 / 70 × 180 = 4140.
  const d = slip(hourly(23, { notMonthly: true, otherEmployment: 'unknown' }), '2026-04', entered('2026-04', [{ wageType: 'stundenlohn', quantity: 70 }]));
  assert.equal(line(d, 'quellensteuer')[0].tariff?.income, 4140);
});

test('hours and days in the same month: «unvollständig», never a guess between 180 hours and 21.667 days', () => {
  const d = slip(hourly(35, { notMonthly: true }), '2026-05', entered('2026-05', [{ wageType: 'stundenlohn', quantity: 10 }, { wageType: 'taglohn', quantity: 2, rate: 200 }]));
  assert.equal(line(d, 'quellensteuer').length, 0);
  assert.ok(d.missing.some((m) => m.wageType === 'quellensteuer' && m.missing === 'notMonthlyMixed'));
});

test('a daily wage not paid monthly: the day rate × 21.667 (KS 45 Ziff. 6.5 Beispiel 2: 2090 / 11 × 21.667 = 4116.73)', () => {
  const d = slip(hourly(0, { notMonthly: true }), '2026-05', entered('2026-05', [{ wageType: 'taglohn', quantity: 11, rate: 190 }]));
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 2090);
  assert.equal(l.tariff?.income, 4116.73, 'the circular rounds to 4117');
  assert.deepEqual(l.tariff?.units, { key: 'days', paid: 2090, quantity: 11, per: 21.667 });
});

test('the tax line says how its rate was found, on the page and in the PDF', () => {
  const d = slip(hourly(35, { notMonthly: true }, {}, '2026-06-17'), '2026-06', entered('2026-06', [{ wageType: 'stundenlohn', quantity: 72 }]));
  const [l] = line(d, 'quellensteuer');
  const src = lineSource(l, d, ch.payroll!, ch.payrollYears, [])!;
  assert.equal(sourceText(src, ch.payroll!.documents, 'de'), "Tarif ZH 2026 vom 08.12.2025 · A0N · satzbestimmend 6'300.00 · 2'520.00 für 72 Stunden, auf 180 Stunden hochgerechnet");
  assert.match(sourceText(src, ch.payroll!.documents, 'fr'), /2'520\.00 pour 72 heures, extrapolé à 180 heures$/);
});
