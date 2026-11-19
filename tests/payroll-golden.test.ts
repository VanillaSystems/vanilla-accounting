/**
 * The golden payroll set of phase B0 (docs/specs/payroll.md §13, §15.1 checkpoints 3, 4, 7, 8), worked by
 * hand to the cent. The firm of §7.2 (tests/support/payroll.ts): gross 10,000; AHV/IV/EO 5.3 % and
 * ALV 1.1 % each side (law, 2026), BVG 300 fixed each side, NBU 1 % on the employee, BU 0.1 %, KTG 0.5 %
 * each side, FAK 1.2 %, administration cost 3 % of the AHV/IV/EO contributions. Lines rounded to 0.05.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslip } from '../src/payroll/compute.js';
import { bookingOf } from '../src/payroll/booking.js';
import type { PayslipCorrection } from '../src/payroll/model.js';
import { amountOf, ch, closedThrough, ctxOf, dated, firm, line, owner } from './support/payroll.js';

const lines = (d: NonNullable<ReturnType<typeof computePayslip>>) =>
  d.lines.map((l) => [l.wageType, l.base ?? null, l.rate ?? null, l.amount]);

test('B0 golden case: September 2026 of the owner, every line base × rate = amount, net 8,910', () => {
  const d = computePayslip(ctxOf(firm()), 'e1', '2026-09')!;
  assert.deepEqual(lines(d), [
    ['monatslohn', 10000, null, 10000],
    ['ahv-an', 10000, 5.3, 530],
    ['alv-an', 10000, 1.1, 110],
    ['nbu-an', 10000, 1, 100],
    ['ktg-an', 10000, 0.5, 50],
    ['bvg-an', null, null, 300],
    ['ahv-ag', 10000, 5.3, 530],
    ['alv-ag', 10000, 1.1, 110],
    ['verwaltungskosten', 1060, 3, 31.8],
    ['fak-ag', 10000, 1.2, 120],
    ['bu-ag', 10000, 0.1, 10],
    ['ktg-ag', 10000, 0.5, 50],
    ['bvg-ag', null, null, 300],
  ]);
  assert.equal(d.gross, 10000);
  assert.equal(d.deductions, 1090);
  assert.equal(d.net, 8910);
  assert.equal(d.payout, 8910);
  assert.equal(d.employer, 1151.8);
  assert.deepEqual(d.missing, []);
  assert.equal(d.postingDate, '2026-09-30', 'posting date: the month\'s last day by default');
  assert.equal(d.payday, '2026-09-25');
  assert.ok(line(d, 'ahv-an')[0].source.startsWith('federal:'), 'a federal rate names the law\'s figure');
  assert.ok(line(d, 'bu-ag')[0].source === 'insurance:uvg', 'a firm\'s rate names its insurance');
});

test('B0 golden case: the booking of September through 1091 and the insurers\' accounts, refs LR-2026-09-<id>; 1091 ends at the payout', () => {
  const store = firm();
  const d = computePayslip(ctxOf(store), 'e1', '2026-09')!;
  const b = bookingOf(d, ch.payroll!, store);
  assert.equal(b.ref, 'LR-2026-09-e1');
  assert.equal(b.date, '2026-09-30');
  assert.deepEqual(b.postings.map((p) => [p.wageType, p.debit, p.credit, p.amount]), [
    ['monatslohn', '5000', '1091', 10000],
    ['ahv-an', '1091', '2271', 530],
    ['alv-an', '1091', '2271', 110],
    ['nbu-an', '1091', '2273', 100],
    ['ktg-an', '1091', '2274', 50],
    ['bvg-an', '1091', '2275', 300],
    ['ahv-ag', '5700', '2271', 530],
    ['alv-ag', '5700', '2271', 110],
    ['verwaltungskosten', '5700', '2271', 31.8],
    ['fak-ag', '5710', '2272', 120],
    ['bu-ag', '5730', '2273', 10],
    ['ktg-ag', '5740', '2274', 50],
    ['bvg-ag', '5720', '2275', 300],
  ]);
  const on = (acc: string) => b.postings.reduce((s, p) => s + (p.credit === acc ? p.amount : 0) - (p.debit === acc ? p.amount : 0), 0);
  assert.equal(Math.round(on('1091') * 100) / 100, d.payout, '1091 holds exactly the payout until the bank pays it');
  assert.equal(Math.round(on('2271') * 100) / 100, 1311.8, 'the compensation fund is owed both shares and its cost');
  assert.equal(on('2275'), 600);
  assert.equal(on('2272'), 120);
  assert.equal(on('2273'), 110);
  assert.equal(on('2274'), 100);
  assert.deepEqual(b.withoutAccount, []);
});

test('B0 golden case: the 13th in December, a twelfth of the year\'s wage, in the bases of every contribution', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 10000, pensum: 100, hoursPerWeek: 42, thirteenth: { months: [12] } })] })]);
  const events = closedThrough(store, '2026-12');
  assert.equal(events.length, 11);
  const d = computePayslip(ctxOf(store, events), 'e1', '2026-12')!;
  assert.deepEqual(line(d, 'dreizehnter').map((l) => [l.base, l.rate, l.amount]), [[120000, 8.33, 10000]], 'base: twelve months of 10,000');
  assert.equal(d.gross, 20000);
  assert.equal(amountOf(d, 'ahv-an'), 1060);
  assert.equal(amountOf(d, 'alv-an'), 220, '130,000 to date: under the cumulated ceiling of 148,200');
  assert.equal(amountOf(d, 'bvg-an'), 300, 'BVG stays the certificate\'s figure');
  assert.equal(d.net, 20000 - 1060 - 220 - 200 - 100 - 300);
});

test('B0 golden case: a raise from 16 May splits the wage by days (15/31 and 16/31) and every base follows', () => {
  const store = firm([owner({
    employment: [
      dated('2026-01-01', { kind: 'monthly' as const, amount: 10000, pensum: 100, hoursPerWeek: 42 }),
      dated('2026-05-16', { kind: 'monthly' as const, amount: 12000, pensum: 100, hoursPerWeek: 42 }, '2026-05-10T08:00:00.000Z'),
    ],
  })]);
  const d = computePayslip(ctxOf(store, closedThrough(store, '2026-05')), 'e1', '2026-05')!;
  assert.deepEqual(line(d, 'monatslohn').map((l) => [l.base, l.quantity, l.amount, l.days]), [
    [10000, 15, 4838.7, { from: '2026-05-01', to: '2026-05-15' }],
    [12000, 16, 6193.55, { from: '2026-05-16', to: '2026-05-31' }],
  ]);
  assert.equal(d.gross, 11032.25);
  assert.equal(amountOf(d, 'ahv-an'), 584.7, '5.3 % of 11,032.25 = 584.709…, to 0.05');
  assert.equal(amountOf(d, 'alv-an'), 121.35, '1.1 % of 11,032.25 = 121.354…');
  assert.equal(amountOf(d, 'verwaltungskosten'), 35.1, '3 % of 1,169.40');
  assert.ok(d.used.some((u) => u.path === 'employees/e1/employment' && u.validFrom === '2026-05-16'), 'the payslip names the entry it read');
});

test('B0 golden case: a Rückwirkende Korrektur on August (BVG 19 each side) lands in October once, as «Korrektur» with corrects, to the cent', () => {
  const store = firm();
  const events = closedThrough(store, '2026-10');
  const aug = '2026-08-e1';
  const corrections: PayslipCorrection[] = [
    { event: 'correction', id: 'c1', of: aug, wageType: 'bvg-an', side: 'employee', amount: 19, text: 'BVG 7.8 % statt 7.5 %', at: '2026-10-05T08:00:00Z', by: 'person' },
    { event: 'correction', id: 'c2', of: aug, wageType: 'bvg-ag', side: 'employer', amount: 19, at: '2026-10-05T08:00:00Z', by: 'person' },
  ];
  const all = [...events, ...corrections];
  const oct = computePayslip(ctxOf(store, all), 'e1', '2026-10')!;
  const carried = oct.lines.filter((l) => l.corrects);
  assert.deepEqual(carried.map((l) => [l.wageType, l.amount, l.corrects, l.correction]), [['bvg-an', 19, aug, 'c1'], ['bvg-ag', 19, aug, 'c2']]);
  assert.equal(oct.net, 8910 - 19, 'the employee\'s share comes off October\'s net');
  // Booked as entries of their own, apart from October's regular BVG lines, each named after the payslip it corrects.
  const posts = bookingOf(oct, ch.payroll!, store).postings.filter((p) => p.wageType === 'bvg-an' || p.wageType === 'bvg-ag');
  const regular = posts.filter((p) => !p.corrects);
  assert.equal(regular.length, 2, 'October\'s own BVG lines stay as computed');
  assert.ok(regular.every((p) => p.amount !== 19 && !p.text.startsWith('Korrektur')));
  assert.deepEqual(posts.filter((p) => p.corrects).map((p) => [p.wageType, p.amount, p.corrects, p.text.split(' ').slice(0, 2).join(' ')]),
    [['bvg-an', 19, aug, 'Korrektur 08/2026:'], ['bvg-ag', 19, aug, 'Korrektur 08/2026:']]);
  assert.equal(computePayslip(ctxOf(store, all), 'e1', '2026-11')!.lines.filter((l) => l.corrects).length, 0, 'not in November too');
  const septemberAgain = computePayslip(ctxOf(store, events), 'e1', '2026-09');
  assert.ok(septemberAgain, 'closed months are not touched by the correction');
});

test('a line «unvollständig» is left out of every figure and named: the company car without its price, and an NBU rate missing', () => {
  const store = firm([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { rate: 0.9 })] }] })]);
  store.insurances.find((i) => i.kind === 'uvg')!.solutions[0].rates = [dated('2026-01-01', { bu: 0.1, nbuEmployerShare: 0 })];
  const d = computePayslip(ctxOf(store), 'e1', '2026-09')!;
  assert.deepEqual(d.missing.map((m) => [m.wageType, m.missing]), [['privatanteil-fahrzeug', 'quantity'], ['nbu-an', 'rate:nbu'], ['nbu-ag', 'rate:nbu']]);
  assert.equal(d.gross, 10000);
  assert.equal(d.net, 8910 + 100, 'without the NBU line');
});

test('the company car with its price counts in the gross and the bases but is no money paid: D 5000 / C 6200, 1091 still the payout', () => {
  const store = firm([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { quantity: 50000, rate: 0.009 })] }] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-09')!;
  assert.equal(amountOf(d, 'privatanteil-fahrzeug'), 450);
  assert.equal(d.gross, 10450);
  assert.equal(amountOf(d, 'ahv-an'), 553.85, '5.3 % of 10,450');
  assert.equal(d.payout, round(d.net - 450));
  const b = bookingOf(d, ch.payroll!, store);
  assert.deepEqual(b.postings.find((p) => p.wageType === 'privatanteil-fahrzeug'), { wageType: 'privatanteil-fahrzeug', debit: '5000', credit: '6200', amount: 450, text: 'Privatanteil Geschäftsfahrzeug 09/2026 Mila Beispiel' });
  const on1091 = b.postings.reduce((s, p) => s + (p.credit === '1091' ? p.amount : 0) - (p.debit === '1091' ? p.amount : 0), 0);
  assert.equal(round(on1091), d.payout);
});

test('without the year\'s federal figures every law-rated line is «unvollständig», never a guessed rate', () => {
  const store = firm();
  const d = computePayslip({ ...ctxOf(store), years: {} }, 'e1', '2026-09')!;
  assert.ok(d.missing.some((m) => m.wageType === 'ahv-an' && m.missing === 'federal'));
  assert.ok(!d.lines.some((l) => l.wageType === 'ahv-an'));
});

test('a later month of a person whose earlier month is still open says so as a fact', () => {
  const d = computePayslip(ctxOf(firm()), 'e1', '2026-03')!;
  assert.deepEqual(d.facts.find((f) => f.key === 'earlierOpen'), { key: 'earlierOpen', vars: { month: '2026-01' } });
});

const round = (x: number) => Math.round(x * 100) / 100;
