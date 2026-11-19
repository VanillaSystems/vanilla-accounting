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

// ─── 2. Codes beyond A–H and L–P (KS 45 Ziff. 4; format Ziff. 4.2, 4.4, 4.5) ──

/** An invented person on a monthly wage of `amount`, subject to the tax with `code` in `region`. */
function monthly(amount: number, tax: Partial<TaxAtSource>) {
  return owner({
    id: 'h1', isOwner: false,
    employment: [dated('2026-01-01', { kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })],
    insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' } })],
    taxAtSource: [dated('2026-01-01', { subject: true, canton: 'ZH', code: 'A0', ...tax })],
  });
}
const missingOf = (d: ReturnType<typeof slip>) => d.missing.find((m) => m.wageType === 'quellensteuer')?.missing;

test('code E (simplified procedure) is refused with its reason: the compensation fund collects it, though the ZH file carries E0N at 5 %', () => {
  assert.equal(FILES.ZH.file.tariffs.get('E0N')?.[0].brackets[0].rate, 5, 'the file has the flat 5 %');
  const d = slip(monthly(1500, { code: 'E0' }), '2026-03', []);
  assert.equal(line(d, 'quellensteuer').length, 0);
  assert.equal(missingOf(d), 'taxCodeRefused:E0N');
  assert.equal(line(d, 'bezugsprovision').length, 0, 'no commission on a tax not withheld');
});

test('codes G and Q (replacement income an insurer pays) are refused: a daily allowance through the wage takes the ordinary code (KS 45 Ziff. 6.10)', () => {
  assert.equal(FILES.ZH.file.tariffs.get('G9N')?.[0].brackets.find((b) => b.from === 6451)?.rate, 11.93, 'the ZH file has G9N, progressive');
  for (const code of ['G9N', 'Q9N']) assert.equal(missingOf(slip(monthly(6500, { code }), '2026-03', [])), `taxCodeRefused:${code}`);
  // The ordinary code on a month with a daily allowance paid through the wage: all of it taxed at A0N (Ziff. 6.10, Beispiel: 4500 + 1000).
  const d = slip(monthly(6500, { code: 'A0' }), '2026-03', entered('2026-03', [{ wageType: 'taggeld-uvg', amount: 1000 }]));
  assert.equal(line(d, 'quellensteuer')[0].base, 7500);
  assert.equal(line(d, 'quellensteuer')[0].tariff?.code, 'A0N');
});

test('code SF (France, special agreement): no tax, but the wage is declared at 0 % in the canton\'s list (BE file, record 11 SFN)', async () => {
  FILES.BE = loaded('be');
  const p = monthly(6500, { canton: 'BE', code: 'SF' });
  const store = firm([p]);
  const d = computePayslip({ ...ctxOf(store), tariffs }, 'h1', '2026-03')!;
  const [l] = line(d, 'quellensteuer');
  assert.deepEqual([l.base, l.rate, l.amount, l.tariff?.code], [6500, 0, 0, 'SFN']);
  assert.equal(line(d, 'bezugsprovision').length, 0);
  const { settlementsOf } = await import('../src/payroll/settlement.js');
  const { firmWageTypes } = await import('../src/payroll/catalogue.js');
  const { closeOf } = await import('./support/payroll.js');
  const [list] = settlementsOf([closeOf(d)], '2026', ch.payroll!, firmWageTypes(ch.payroll!, store), store);
  assert.deepEqual([list.region, list.rows[0].code, list.rows[0].wage, list.rows[0].tax, list.totals.payable], ['BE', 'SFN', 6500, 0, 0]);
  const src = lineSource(l, d, ch.payroll!, ch.payrollYears, [])!;
  assert.match(sourceText(src, ch.payroll!.documents, 'de'), /Sondervereinbarung mit Frankreich/);
});

test('L to P: the 4.5 % note names the certificate and the 60 days without returning home (KS 45 Ziff. 4.6, Gre-3)', () => {
  const d = slip(monthly(7000, { code: 'L0' }), '2026-03', []);
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.rate, 4.5);
  const src = lineSource(l, d, ch.payroll!, ch.payrollYears, [])!;
  assert.match(sourceText(src, ch.payroll!.documents, 'de'), /Gre-1.*Gre-3/);
});

test('a fixed-rate code (D: persons refunded their AHV contributions, only in the GE file, format Ziff. 4.4) is read as any code of the file', () => {
  // The format's own example records (Ziff. 4.4: «0601GED0N … 0000000000001000»), in an invented file; the 2026 files carry no D.
  const rec = (kind: string, code: string, rate: string) => `${kind}01GE${code.padEnd(10)}20260101000000100099999900 00000000000${rate}   `;
  const lines = [`00GE${' '.repeat(15)}20251201${' '.repeat(35)}`, rec('06', 'D0N', '01000'), rec('12', 'PEL', '00100')];
  const text = [...lines, `99${' '.repeat(15)}GE${String(lines.length + 1).padStart(8, '0')}`].join('\r\n');
  const ge = parseTariffFile(text);
  assert.equal(ge.tariffs.get('D0N')?.[0].brackets[0].rate, 10);
  for (const [kt, f] of Object.entries(FILES)) assert.equal(f.file.tariffs.has('D0N'), false, `${kt} 2026 has no D`);
});

// ─── 3. Days worked abroad (KS 45 Ziff. 3.2.2, 6.7) ─────────────────────────────

/** A person resident in Germany (her address), on a monthly wage, with days worked abroad in `month`. */
function abroadSlip(amount: number, abroad: { abroad: number; total?: number }, month = '2026-09', lines: MonthLine[] = [], country = 'DE') {
  const p = monthly(amount, { code: 'A0' });
  p.address = [dated('2026-01-01', { street: 'Hauptstrasse', number: '5', postcode: '79539', town: 'Lörrach', country })];
  const store = firm([p]);
  store.monthLines = lines;
  store.taxDays = { [`${month}-h1`]: { ...abroad, enteredAt: '2026-09-01T00:00:00Z' } };
  return computePayslip({ ...ctxOf(store), tariffs }, 'h1', month)!;
}

test('KS 45 Ziff. 6.7 Beispiel 1: 8000 a month, 5 of 20 working days abroad: taxed 6000 at the rate of 8000', () => {
  const d = abroadSlip(8000, { abroad: 5 });
  const [l] = line(d, 'quellensteuer');
  assert.equal(l.base, 6000, '8000 / 20 × 15');
  assert.equal(l.tariff?.income, 8000, 'the rate is the whole wage\'s');
  assert.deepEqual(l.tariff?.abroad, { days: 5, total: 20, wage: 8000 });
  // ZH A0N 7'951–8'000: 8.66 %; 6000 × 8.66 % = 519.60.
  assert.equal(l.rate, 8.66);
  assert.equal(l.amount, 519.6);
  assert.ok(!d.facts.some((f) => f.key.startsWith('abroad')), 'nothing aperiodic, not resident: no fact');
  const src = lineSource(l, d, ch.payroll!, ch.payrollYears, [])!;
  assert.match(sourceText(src, ch.payroll!.documents, 'de'), /satzbestimmend 8'000\.00 · 15 von 20 Arbeitstagen in der Schweiz \(ganzer Lohn 8'000\.00\)$/);
  assert.match(sourceText(src, ch.payroll!.documents, 'it'), /15 giorni lavorativi in Svizzera su 20 \(salario intero 8'000\.00\)$/);
});

test('FAQ KS 45 Frage 1: 10\'000, 8 of 20 days abroad: 6\'000 taxed at the rate of 10\'000; the commission on that tax', () => {
  const d = abroadSlip(10000, { abroad: 8 });
  const [l] = line(d, 'quellensteuer');
  assert.deepEqual([l.base, l.tariff?.income, l.rate, l.amount], [6000, 10000, 10.59, 635.4], 'ZH A0N 9\'951–10\'000: 10.59 %');
  assert.equal(line(d, 'bezugsprovision')[0].base, 635.4);
});

test('KS 45 Ziff. 6.7 Beispiel 2: a bonus of an earlier period is taxed whole, and the payslip says the circular would take its period\'s share', () => {
  const d = abroadSlip(10000, { abroad: 4 }, '2026-04', [{ id: 'b', employee: 'h1', month: '2026-04', wageType: 'bonus', amount: 30000, enteredAt: '2026-04-01T00:00:00Z' }]);
  const [l] = line(d, 'quellensteuer');
  // The circular: 8000 + 30000 / 240 × 200 = 33000, with the year before's 200 Swiss days of 240; the app has no such days.
  assert.equal(l.base, 38000, '10000 / 20 × 16 + the bonus whole');
  assert.equal(l.tariff?.income, 40000, '10000 + 30000, as the circular');
  assert.equal(l.rate, 26, 'ZH A0N 35\'001–40\'000: 26.00 %');
  assert.deepEqual(d.facts.find((f) => f.key === 'abroadAperiodic')?.vars, { amount: 30000 });
});

test('another number of working days, all of them abroad, and a resident: each as the person entered it', () => {
  const total = line(abroadSlip(8000, { abroad: 6, total: 22 }), 'quellensteuer')[0];
  assert.equal(total.base, 5818.18, '8000 / 22 × 16');
  assert.deepEqual(total.tariff?.abroad, { days: 6, total: 22, wage: 8000 });
  const all = abroadSlip(8000, { abroad: 20 });
  assert.equal(line(all, 'quellensteuer').length, 0, 'no Swiss day: no tax, no line');
  const resident = abroadSlip(8000, { abroad: 5 }, '2026-09', [], 'CH');
  assert.equal(line(resident, 'quellensteuer')[0].base, 6000, 'warn, don\'t block: taken off as entered');
  assert.ok(resident.facts.some((f) => f.key === 'abroadResident'), 'but said: a resident is taxed on them unless a treaty says otherwise');
});
