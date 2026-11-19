/**
 * The golden payroll set of phase B1 (docs/specs/payroll.md §13, §15.3 checkpoints 1, 3, 4, 5), worked by hand
 * to the cent. The firm of §7.2 (tests/support/payroll.ts): AHV/IV/EO 5.3 % and ALV 1.1 % each side (law,
 * 2026), NBU 1 % on the employee, BU 0.1 %, KTG 0.5 % each side, FAK 1.2 %, administration cost 3 % of the
 * AHV/IV/EO contributions; lines rounded to 0.05. Every person is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslip } from '../src/payroll/compute.js';
import { bookingOf } from '../src/payroll/booking.js';
import { lohnausweisOf } from '../src/payroll/documents.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import type { PayrollEmployee, PayslipClose } from '../src/payroll/model.js';
import { amountOf, ch, closeOf, closedThrough, ctxOf, dated, firm, line, owner } from './support/payroll.js';

const lines = (d: NonNullable<ReturnType<typeof computePayslip>>) => d.lines.map((l) => [l.wageType, l.base ?? null, l.rate ?? null, l.amount]);
const facts = (d: NonNullable<ReturnType<typeof computePayslip>>) => d.facts.map((f) => f.key);
const monthly = (amount: number, more: Record<string, unknown> = {}) => ({ kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 42, holidayDays: 25, ...more });

/** A staff member of the firm (not the owner): in the UVG and KTG solutions, no pension certificate unless given. */
function staff(id: string, more: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return owner({ id, isOwner: false, birthDate: '1990-04-02', sex: 'f', name: [dated('2026-01-01', { first: 'Nora', last: id })], insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } })], ...more });
}

test('B1 golden case: part-time 1,550 a month, no BVG below the entry threshold, the reason shown', () => {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 3100, pensum: 50, hoursPerWeek: 21, holidayDays: 25 })] })]);
  const d = computePayslip(ctxOf(store), 'p1', '2026-09')!;
  assert.deepEqual(lines(d), [
    ['monatslohn', 1550, null, 1550],
    ['ahv-an', 1550, 5.3, 82.15],
    ['alv-an', 1550, 1.1, 17.05],
    ['nbu-an', 1550, 1, 15.5],
    ['ktg-an', 1550, 0.5, 7.75],
    ['ahv-ag', 1550, 5.3, 82.15],
    ['alv-ag', 1550, 1.1, 17.05],
    ['verwaltungskosten', 164.3, 3, 4.95],
    ['fak-ag', 1550, 1.2, 18.6],
    ['bu-ag', 1550, 0.1, 1.55],
    ['ktg-ag', 1550, 0.5, 7.75],
  ]);
  assert.equal(d.net, 1427.55);
  assert.deepEqual(d.missing, [], 'no line «unvollständig»: below the threshold no certificate is needed');
  const below = d.facts.find((f) => f.key === 'belowThreshold');
  assert.deepEqual(below?.vars, { amount: 22680, yearly: 18600 }, 'the fact names the threshold and the yearly wage: 1,550 × 12');
});

test('B1 golden case: hourly 70 h × 24.00, the holiday surcharge 4/48 = 8.33 % on its own line, no BVG with the reason', () => {
  const store = firm([staff('h1', { employment: [dated('2026-01-01', { kind: 'hourly' as const, amount: 24, holidayDays: 20 })] })]);
  store.monthLines = [{ id: 'm1', employee: 'h1', month: '2026-09', wageType: 'stundenlohn', quantity: 70, enteredAt: '2026-09-30T08:00:00Z' }];
  const d = computePayslip(ctxOf(store), 'h1', '2026-09')!;
  assert.deepEqual(lines(d).slice(0, 7), [
    ['stundenlohn', null, 24, 1680],
    ['ferienzuschlag', 1680, 8.33, 139.95],
    ['ahv-an', 1819.95, 5.3, 96.45],
    ['alv-an', 1819.95, 1.1, 20],
    ['nbu-an', 1819.95, 1, 18.2],
    ['ktg-an', 1819.95, 0.5, 9.1],
    ['ahv-ag', 1819.95, 5.3, 96.45],
  ]);
  assert.equal(line(d, 'stundenlohn')[0].quantity, 70);
  assert.equal(d.gross, 1819.95);
  assert.equal(d.net, 1676.2);
  assert.ok(facts(d).includes('belowThreshold'), 'the yearly wage 1,819.95 × 12 = 21,839.40 lies below 22,680');
  assert.equal(d.holidays, undefined, 'the holidays are paid with every hour: no balance in days');
  assert.ok(!facts(d).includes('belowHours'), 'NBU: 70 h × 12 / 52 = 16.2 h a week, from 8 h');
});

test('the holiday surcharge follows the weeks (5/47, 6/46), the legal minimum by age, the public-holiday surcharge and the firm\'s basis', () => {
  const at = (job: Record<string, unknown>, birthDate = '1990-04-02', basis?: 'wage-with-surcharge') => {
    const store = firm([staff('h1', { birthDate, employment: [dated('2026-01-01', { kind: 'hourly' as const, amount: 25, ...job })] })]);
    if (basis) store.company.holidayBasis = [dated('2026-01-01', basis)];
    store.monthLines = [{ id: 'm1', employee: 'h1', month: '2026-09', wageType: 'stundenlohn', quantity: 40, enteredAt: '2026-09-30T08:00:00Z' }];
    return computePayslip(ctxOf(store), 'h1', '2026-09')!;
  };
  assert.equal(line(at({ holidayDays: 25 }), 'ferienzuschlag')[0].rate, 10.64);
  assert.equal(line(at({ holidayDays: 30 }), 'ferienzuschlag')[0].rate, 13.04);
  assert.equal(line(at({}, '2007-01-10'), 'ferienzuschlag')[0].rate, 10.64, 'under 20 the minimum is 5 weeks');
  assert.equal(line(at({}), 'ferienzuschlag')[0].source, 'holidays-minimum');
  const pub = at({ holidayDays: 20, publicHolidaySurcharge: 3.6 });
  assert.deepEqual(lines(pub).slice(0, 3), [['stundenlohn', null, 25, 1000], ['feiertagszuschlag', 1000, 3.6, 36], ['ferienzuschlag', 1000, 8.33, 83.3]]);
  assert.deepEqual(line(at({ holidayDays: 20, publicHolidaySurcharge: 3.6 }, '1990-04-02', 'wage-with-surcharge'), 'ferienzuschlag')[0].base, 1036, 'the firm\'s basis: the wage with the public-holiday surcharge');
  assert.equal(amountOf(at({ holidayDays: 20, holidayPay: 'leave' }), 'ferienzuschlag'), 0, 'holidays taken as paid leave: no surcharge');
});

test('B1 golden case: a December bonus crosses the ALV ceiling, cumulated over the year', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', monthly(12000))] })]);
  store.monthLines = [{ id: 'b', employee: 'e1', month: '2026-12', wageType: 'bonus', amount: 20000, enteredAt: '2026-12-01T00:00:00Z' }];
  const events = closedThrough(store, '2026-12');
  const d = computePayslip(ctxOf(store, events), 'e1', '2026-12')!;
  assert.deepEqual(line(d, 'alv-an').map((l) => [l.base, l.amount]), [[16200, 178.2]], '148,200 − 11 × 12,000 = 16,200');
  assert.deepEqual(line(d, 'ahv-an').map((l) => [l.base, l.amount]), [[32000, 1696]], 'AHV has no ceiling');
  assert.equal(line(d, 'nbu-an')[0].base, 16200, 'the UVG ceiling is the same figure');
  assert.ok(facts(d).includes('ceiling'));
  assert.equal(d.bases['alv|alvCeiling'].year, 148200, 'the year\'s capped ALV wage is the ceiling');
});

test('B1 golden case: turning 65 in July: the allowance and no ALV from August; a waiver keeps the whole base', () => {
  const born = (insurances = {}) => firm([owner({ birthDate: '1961-07-15', insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 300, employer: 300 }, uvg: { insurance: 'uvg', code: 'A1' }, ...insurances })] })]);
  const jul = computePayslip(ctxOf(born()), 'e1', '2026-07')!;
  assert.equal(line(jul, 'ahv-an')[0].base, 10000);
  assert.equal(amountOf(jul, 'alv-an'), 110);
  const aug = computePayslip(ctxOf(born()), 'e1', '2026-08')!;
  assert.deepEqual(line(aug, 'ahv-an').map((l) => [l.base, l.amount]), [[8600, 455.8]], '10,000 − 1,400 allowance');
  assert.equal(line(aug, 'fak-ag')[0].base, 8600);
  assert.equal(amountOf(aug, 'alv-an'), 0);
  assert.equal(amountOf(aug, 'alv-ag'), 0);
  assert.ok(facts(aug).includes('pensioner'));
  const waived = computePayslip(ctxOf(born({ pensioner: 'waiver' })), 'e1', '2026-08')!;
  assert.equal(line(waived, 'ahv-an')[0].base, 10000, 'the person waived the allowance for the year');
});

test('B1 golden case: turning 18 in 2026 is liable all year; turning 17 is liable from 1 January 2027', () => {
  const eighteen = computePayslip(ctxOf(firm([staff('y1', { birthDate: '2008-10-20', employment: [dated('2026-01-01', monthly(1200))] })])), 'y1', '2026-03')!;
  assert.equal(amountOf(eighteen, 'ahv-an'), 63.6, 'the 17th birthday was in 2025: liable from 1 January 2026, months before the 18th too');
  const seventeen = computePayslip(ctxOf(firm([staff('y2', { birthDate: '2009-10-20', employment: [dated('2026-01-01', monthly(1200))] })])), 'y2', '2026-11')!;
  for (const w of ['ahv-an', 'alv-an', 'ahv-ag', 'alv-ag', 'fak-ag', 'verwaltungskosten']) assert.equal(amountOf(seventeen, w), 0, w);
  assert.equal(amountOf(seventeen, 'bu-ag'), 1.2, 'the accident insurance is owed from the first franc');
  assert.deepEqual(seventeen.facts.find((f) => f.key === 'notLiable')?.vars, { year: 2027 });
});

test('B1 golden case: an exit on 15 March, the 13th and BVG prorated, the holiday balance shown, the Lohnausweis ready', () => {
  const e = staff('x1', {
    employment: [dated('2026-01-01', monthly(6000, { thirteenth: { months: [12] } }), undefined, '2026-03-15')],
    insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 250, employer: 250 }, uvg: { insurance: 'uvg', code: 'A1' } })],
  });
  const store = firm([e]);
  const events = closedThrough(store, '2026-03', 'x1');
  const d = computePayslip(ctxOf(store, events), 'x1', '2026-03')!;
  assert.deepEqual(line(d, 'monatslohn').map((l) => [l.base, l.rate, l.amount]), [[6000, 48.39, 2903.25]], '6,000 × 15/31');
  assert.deepEqual(line(d, 'dreizehnter').map((l) => [l.base, l.rate, l.amount]), [[14903.25, 8.33, 1241.95]], 'a twelfth of 6,000 + 6,000 + 2,903.25');
  assert.equal(amountOf(d, 'bvg-an'), 120.95, '250 × 15/31');
  assert.equal(amountOf(d, 'bvg-ag'), 120.95);
  assert.ok(facts(d).includes('exit'));
  assert.deepEqual(d.holidays, { earned: 5.17, taken: 0, balance: 5.17 }, '25 days / 12 × (1 + 1 + 15/31)');
  assert.deepEqual(d.facts.find((f) => f.key === 'holidayBalance')?.vars, { days: 5.17 });
  const closes = [...events, closeOf(d)] as PayslipClose[];
  const types = firmWageTypes(ch.payroll!, store);
  const la = lohnausweisOf(e, closes, types, ch.payroll!, '2026');
  assert.deepEqual(la.openMonths, [], 'ready with the last payslip');
  assert.equal(la.to, '2026-03-15');
  assert.equal(la.fields['8'], Math.round(6000) + Math.round(6000) + Math.round(2903.25 + 1241.95), 'field 8 = Σ gross, each month\'s field 1 in whole francs');
});

test('B1 golden case: a wage under 2,500 a year owes no AHV, ALV or FAK; asked for, or past the limit, it does, the months before caught up', () => {
  const helper = (amount: number, insurances: Record<string, unknown> = {}) => firm([staff('s1', { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 4 })], insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ...insurances })] })]);
  const small = helper(200);
  const dec = computePayslip(ctxOf(small, closedThrough(small, '2026-12', 's1')), 's1', '2026-12')!;
  for (const w of ['ahv-an', 'alv-an', 'ahv-ag', 'alv-ag', 'fak-ag', 'verwaltungskosten']) assert.equal(amountOf(dec, w), 0, `${w}: 12 × 200 = 2,400`);
  assert.equal(amountOf(dec, 'bu-ag'), 0.2);
  assert.ok(facts(dec).includes('smallWage'));
  assert.ok(facts(dec).includes('belowHours'), 'and no NBU under 8 hours a week');
  const asked = computePayslip(ctxOf(helper(200, { smallWage: 'liable' })), 's1', '2026-03')!;
  assert.equal(amountOf(asked, 'ahv-an'), 10.6, 'liable on request: 200 × 5.3 %');
  assert.equal(amountOf(computePayslip(ctxOf(helper(300)), 's1', '2026-01')!, 'ahv-an'), 15.9, 'a monthly 300 promises 3,600: liable from January');
  // An hourly wage shows its year month by month: 10 hours × 20 to August (2,400 a year at that pace), 40 in September.
  const crossing = firm([staff('s1', { employment: [dated('2026-01-01', { kind: 'hourly' as const, amount: 20, holidayPay: 'leave' as const, hoursPerWeek: 4 })], insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } })] })]);
  crossing.monthLines = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, employee: 's1', month: `2026-${String(i + 1).padStart(2, '0')}`, wageType: 'stundenlohn', quantity: i === 8 ? 40 : 10, enteredAt: '2026-01-01T00:00:00Z' }));
  const events = closedThrough(crossing, '2026-09', 's1');
  const aug = events.at(-1) as PayslipClose;
  assert.ok(!aug.lines.some((l) => l.wageType === 'ahv-an'), 'August: 1,600 so far, 2,400 at that pace');
  const sep = computePayslip(ctxOf(crossing, events), 's1', '2026-09')!;
  assert.deepEqual(line(sep, 'ahv-an').map((l) => [l.base, l.amount]), [[2400, 127.2]], 'September: 2,400 so far, 3,200 at that pace: 800 and the 1,600 of January to August');
  assert.deepEqual(line(sep, 'alv-an').map((l) => [l.base, l.amount]), [[2400, 26.4]]);
  assert.ok(facts(sep).includes('smallWageCaught'));
  const oct = computePayslip(ctxOf(crossing, [...events, closeOf(sep)]), 's1', '2026-10')!;
  assert.deepEqual(line(oct, 'ahv-an').map((l) => [l.base, l.amount]), [[200, 10.6]], 'caught up once');
});

test('B1 golden case: a child allowance is paid with the wage and books D 2272 / C 1091; a birth allowance once', () => {
  const e = staff('c1', {
    employment: [dated('2026-01-01', monthly(5000))],
    children: [
      { id: 'k1', name: 'Lea', birthDate: '2019-02-11', allowance: [dated('2026-01-01', { wageType: 'kinderzulage', amount: 215 })] },
      // Born in September: the child allowance from the month of the birth (FamZG Art. 3), the birth allowance once, apart.
      { id: 'k2', name: 'Tim', birthDate: '2026-09-03', allowance: [dated('2026-09-01', { wageType: 'kinderzulage', amount: 215 })], birth: { wageType: 'geburtszulage', amount: 1500, month: '2026-09' } },
    ],
  });
  const store = firm([e]);
  const sep = computePayslip(ctxOf(store), 'c1', '2026-09')!;
  assert.deepEqual(sep.lines.filter((l) => l.source === 'fak').map((l) => [l.wageType, l.amount, l.text]), [['kinderzulage', 215, 'Lea'], ['kinderzulage', 215, 'Tim'], ['geburtszulage', 1500, 'Tim']]);
  assert.equal(line(sep, 'ahv-an')[0].base, 5000, 'no AHV on a family allowance');
  assert.equal(sep.payout, Math.round((sep.net + 1930) * 100) / 100, 'paid out with the net');
  const b = bookingOf(sep, ch.payroll!, store);
  assert.deepEqual(b.postings.filter((p) => p.debit === '2272').map((p) => [p.wageType, p.credit, p.amount]), [['kinderzulage', '1091', 430], ['geburtszulage', '1091', 1500]]);
  const oct = computePayslip(ctxOf(store), 'c1', '2026-10')!;
  assert.deepEqual(oct.lines.filter((l) => l.source === 'fak').map((l) => [l.wageType, l.amount]), [['kinderzulage', 215], ['kinderzulage', 215]], 'the birth allowance once; the child allowances go on');
  const low = computePayslip(ctxOf(firm([staff('c2', { employment: [dated('2026-01-01', monthly(5000))], children: [{ id: 'k', name: 'Ada', birthDate: '2010-01-05', allowance: [dated('2026-01-01', { wageType: 'kinderzulage', amount: 200 })] }] })])), 'c2', '2026-03')!;
  assert.ok(facts(low).includes('allowanceBelowMinimum'), '200 is below the federal minimum of 215');
  assert.ok(facts(low).includes('allowanceAge'), 'Ada turned 16 in January 2026: the child allowance ends by the fund\'s decision');
});

test('an illness with continued pay and the sick-pay insurer\'s daily allowance: the wage taken off, the allowance, the top-up; the bases follow', () => {
  const e = staff('a1', {
    employment: [dated('2026-01-01', monthly(6000))],
    absences: [
      { id: 'ab1', kind: 'illness', from: '2026-09-07', to: '2026-09-20', continuedPay: 100, dailyAllowance: 157.8, allowanceFrom: '2026-09-09', enteredAt: '2026-09-21T00:00:00Z' },
      { id: 'ab2', kind: 'unpaid', from: '2026-09-28', to: '2026-09-29', enteredAt: '2026-09-21T00:00:00Z' },
    ],
  });
  const store = firm([e]);
  const d = computePayslip(ctxOf(store), 'a1', '2026-09')!;
  assert.deepEqual(d.lines.filter((l) => l.source === 'absence').map((l) => [l.wageType, l.amount]), [
    ['taggeld-ktg', 1893.6],
    ['lohnausfall', 2800],
    ['lohn-krankheit', 906.4],
    ['unbezahlter-urlaub', 400],
  ], '12 allowance days × 157.80; 6,000 × 14/30 off; 2,800 continued less the allowance; 2 unpaid days');
  assert.equal(d.gross, 5600, '6,000 − 2,800 + 906.40 + 1,893.60 − 400');
  assert.equal(line(d, 'ahv-an')[0].base, 3706.4, 'the daily allowance is no AHV wage');
  const b = bookingOf(d, ch.payroll!, store);
  assert.deepEqual(b.postings.filter((p) => ['taggeld-ktg', 'lohnausfall', 'lohn-krankheit'].includes(p.wageType)).map((p) => [p.wageType, p.debit, p.credit, p.amount]), [
    ['taggeld-ktg', '2274', '1091', 1893.6],
    ['lohnausfall', '1091', '5000', 2800],
    ['lohn-krankheit', '5000', '1091', 906.4],
  ]);
  const short = computePayslip(ctxOf(firm([staff('a2', { employment: [dated('2026-01-01', monthly(6000))], absences: [{ id: 'x', kind: 'illness', from: '2026-09-07', to: '2026-09-08', enteredAt: '2026-09-21T00:00:00Z' }] })])), 'a2', '2026-09')!;
  assert.deepEqual(short.lines.filter((l) => l.source === 'absence'), [], 'two days, paid on, no allowance: no lines that cancel');
  assert.ok(facts(short).includes('absencePaid'));
});

test('the holiday balance counts the holidays taken in working days', () => {
  const e = staff('f1', { employment: [dated('2026-01-01', monthly(6000, { holidayDays: 25 }))], absences: [{ id: 'h', kind: 'holiday', from: '2026-07-06', to: '2026-07-17', enteredAt: '2026-06-01T00:00:00Z' }] });
  const d = computePayslip(ctxOf(firm([e])), 'f1', '2026-09')!;
  assert.deepEqual(d.holidays, { earned: 18.75, taken: 10, balance: 8.75 }, '25 / 12 × 9 months; two weeks Monday to Friday');
  assert.deepEqual(d.lines.filter((l) => l.source === 'absence'), [], 'holidays taken book no line');
});

test('«Nachzahlung»: a payment after the exit is a payslip of only the added Lohnarten, no BVG, the ceiling of the exit year', () => {
  const e = staff('n1', {
    employment: [dated('2026-01-01', monthly(6000, { thirteenth: { months: [12] } }), undefined, '2026-06-30')],
    insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 250, employer: 250 }, uvg: { insurance: 'uvg', code: 'A1' } })],
  });
  const store = firm([e]);
  const events = closedThrough(store, '2026-07', 'n1');
  assert.equal(computePayslip(ctxOf(store, events), 'n1', '2026-12'), undefined, 'no payslip after the exit unless something is added');
  store.monthLines = [{ id: 'nz', employee: 'n1', month: '2026-12', wageType: 'bonus', amount: 1000, enteredAt: '2026-12-02T00:00:00Z' }];
  const d = computePayslip(ctxOf(store, events), 'n1', '2026-12')!;
  assert.deepEqual(d.lines.filter((l) => l.side === 'employee').map((l) => l.wageType), ['bonus', 'ahv-an', 'alv-an', 'nbu-an'], 'no monthly wage, no 13th, no BVG (and no KTG: not in it)');
  assert.equal(line(d, 'alv-an')[0].base, 1000, 'the year\'s ceiling is 6 months of 12,350: room for it');
  assert.ok(facts(d).includes('afterExit'));
  const next = computePayslip(ctxOf(store, events), 'n1', '2026-12')!;
  assert.deepEqual(next.lines, d.lines, 'the same each read');
});

test('the fact of an entry is said on the entry month once, never again', () => {
  const store = firm([staff('j1', { employment: [dated('2026-03-10', monthly(5000))] })]);
  const mar = computePayslip(ctxOf(store), 'j1', '2026-03')!;
  assert.deepEqual(mar.facts.filter((f) => f.key === 'entry').map((f) => f.vars), [{ date: '2026-03-10' }]);
  assert.equal(line(mar, 'monatslohn')[0].amount, 3548.4, '5,000 × 22/31');
  const apr = computePayslip(ctxOf(store, closedThrough(store, '2026-04', 'j1')), 'j1', '2026-04')!;
  assert.ok(!facts(apr).includes('entry'));
});

// ─── back pay in a later year (WBB Rz 2036–2040) ────────────────────────────────

import { historyOf } from '../src/payroll/history.js';
import type { PayslipEvent, PayslipLine } from '../src/payroll/model.js';
import type { FederalFigure, PayrollYearData } from '../src/core/modules/schema.js';

/** Invented figures of 2027 that differ from 2026's, so the case shows whose year a line takes: AHV 5.5 %, ALV ceiling 150,000. */
function yearsWith2027(extra: string[] = ['2027']) {
  const y26 = ch.payrollYears!['2026'];
  const row = (y: string, key: string, value: number): FederalFigure => { const f = y26.figures[key]; return { ...(Array.isArray(f) ? f[0] : f), value, validFrom: `${y}-01-01` }; };
  const out: Record<string, PayrollYearData> = { ...ch.payrollYears };
  for (const y of extra) out[y] = { ...y26, year: Number(y), figures: { ...y26.figures, ahvEmployee: row(y, 'ahvEmployee', 5.5), ahvEmployer: row(y, 'ahvEmployer', 5.5), alvCeiling: row(y, 'alvCeiling', 150000) } };
  return out;
}

/** 2026 closed month by month at `wage`, the Anstellung ending `until` (or running on); a bonus of 2,000 paid in February 2027. */
function backPay(wage: number, until?: string) {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(wage), undefined, until)] })]);
  const years = yearsWith2027();
  const events: PayslipEvent[] = [];
  for (let m = 1; m <= 12; m++) { const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', `2026-${String(m).padStart(2, '0')}`); if (d) events.push(closeOf(d)); }
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2027-02', wageType: 'bonus', amount: 2000, enteredAt: '2027-02-10T08:00:00Z' }];
  return computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
}

test('B1 golden case: back pay after the exit takes the rates and ceilings of the year it was earned in (WBB Rz 2038)', () => {
  // 12,400 a month: 148,800 in 2026, above 2026's ALV ceiling of 148,200; 2027's 150,000 would leave room for 1,200.
  const d = backPay(12400, '2026-12-31');
  assert.deepEqual(lines(d).filter(([w]) => w === 'ahv-an' || w === 'alv-an'), [['ahv-an', 2000, 5.3, 106]], '2,000 × 5.3 % of 2026; no ALV: 2026\'s ceiling is reached');
  assert.ok(facts(d).includes('ceiling'));
});

test('B1 golden case: back pay while still employed in the later year takes the payment year\'s rates and ceilings (WBB Rz 2039)', () => {
  const d = backPay(12400);
  // February 2027 (the only month of 2027 here): 12,400 + 2,000 at 5.5 %; ALV up to 2027's ceiling for one month, 150,000 / 12.
  assert.deepEqual(lines(d).filter(([w]) => w === 'ahv-an' || w === 'alv-an'), [['ahv-an', 14400, 5.5, 792], ['alv-an', 12500, 1.1, 137.5]]);
});

import { addAbsence, affectedBy, driftOf } from '../src/payroll/settings.js';
import { lineSource } from '../src/payroll/sources.js';

test('B1 golden case: military service, EO allowance and the employer\'s top-up: the top-up is UVG premium wage, the allowance is not (UVV Art. 115 Abs. 1 lit. d)', () => {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(6000))] })]);
  addAbsence(store, ch.payroll!, 'p1', { kind: 'military', from: '2026-09-01', to: '2026-09-30', continuedPay: 100, dailyAllowance: 160 }, 'a1', 'now');
  const d = computePayslip(ctxOf(store), 'p1', '2026-09')!;
  const eo = amountOf(d, 'taggeld-eo');
  const topUp = amountOf(d, 'lohnfortzahlung');
  assert.ok(eo > 0 && topUp > 0, 'the fund\'s allowance and the employer\'s top-up to the full wage');
  assert.equal(Math.round((eo + topUp) * 100) / 100, 6000);
  // The UVG base: the month's wage less the absent days, plus the top-up; never the allowance.
  assert.equal(line(d, 'nbu-an')[0].base, d.bases.uvg?.month);
  assert.equal(d.bases.uvg?.month, Math.round((6000 - eo) * 100) / 100, 'the full wage less the EO allowance: the top-up counts, the allowance does not');
  assert.equal(d.bases.ahv?.month, 6000, 'the allowance is AHV wage (AHVG Art. 19a)');
});

// ─── the second review: per month, re-hires, a further year, a year not shipped ──

const ahvAlv = (d: NonNullable<ReturnType<typeof computePayslip>>) => lines(d).filter(([w]) => w === 'ahv-an' || w === 'alv-an');
/** Closes `months` of the store's person in order with `years`. */
function closeMonths(store: ReturnType<typeof firm>, months: string[], years: Record<string, PayrollYearData>, events: PayslipEvent[] = []) {
  for (const m of months) { const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', m); if (d) events.push(closeOf(d)); }
  return events;
}
const months26 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

test('a re-hire entered after a closed Nachzahlung changes nothing closed: the earlier month is still after the exit', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(12400), undefined, '2026-06-30')] })]);
  const events = closeMonths(store, months26.slice(0, 6), years);
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2027-02', wageType: 'bonus', amount: 2000, enteredAt: '2027-02-10T08:00:00Z' }];
  closeMonths(store, ['2027-02'], years, events);
  const feb = events.at(-1) as PayslipClose;
  assert.deepEqual(ahvAlv(feb as never), [['ahv-an', 2000, 5.3, 106]]);
  const next = structuredClone(store);
  next.employees[0].employment = [...next.employees[0].employment, dated('2027-09-01', monthly(12400), '2027-08-20T00:00:00Z')];
  const ctx = { data: ch.payroll!, years, store, history: historyOf(events) };
  assert.deepEqual(affectedBy(ctx, next), [], 'no closed month computes otherwise');
  assert.deepEqual(driftOf({ ...ctx, store: next }, feb), []);
});

test('a re-hire known before the payment month: a bonus in January 2027 between two employments counts in 2026, by 2026\'s ALV ceiling', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(12400), undefined, '2026-06-30'), dated('2027-03-01', monthly(5000))] })]);
  const events = closeMonths(store, months26.slice(0, 6), years);
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2027-01', wageType: 'bonus', amount: 2000, enteredAt: '2027-01-10T08:00:00Z' }];
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-01')!;
  // 6 × 12,400 = 74,400 already above 2026's ceiling for six months (74,100): no ALV; AHV at 2026's 5.3 %.
  assert.deepEqual(ahvAlv(d), [['ahv-an', 2000, 5.3, 106]]);
  assert.ok(facts(d).includes('afterExit') && facts(d).includes('ceiling'));
});

test('a second Nachzahlung in a further year counts the first against the earned year\'s ceiling', () => {
  const years = yearsWith2027(['2027', '2028']);
  // 12 × 12,300 = 147,600: 600 left under 2026's 148,200.
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(12300), undefined, '2026-12-31')] })]);
  const events = closeMonths(store, months26, years);
  store.monthLines = [
    { id: 'm1', employee: 'p1', month: '2027-02', wageType: 'bonus', amount: 500, enteredAt: '2027-02-10T08:00:00Z' },
    { id: 'm2', employee: 'p1', month: '2028-02', wageType: 'bonus', amount: 500, enteredAt: '2028-02-10T08:00:00Z' },
  ];
  closeMonths(store, ['2027-02'], years, events);
  assert.deepEqual(ahvAlv(events.at(-1) as never), [['ahv-an', 500, 5.3, 26.5], ['alv-an', 500, 1.1, 5.5]]);
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2028-02')!;
  assert.deepEqual(ahvAlv(d), [['ahv-an', 500, 5.3, 26.5], ['alv-an', 100, 1.1, 1.1]], 'only 100 left under 2026\'s ceiling');
});

test('earned in 2025: the shipped 2025 figures, the line citing them; earned in a year not shipped: the nearest year, said', () => {
  for (const [exit, figureYear, fact] of [['2025-12-31', '2025', false], ['2023-12-31', '2025', true]] as const) {
    const store = firm([staff('p1', { employment: [dated(`${exit.slice(0, 4)}-01-01`, monthly(6000), undefined, exit)] })]);
    store.monthLines = [{ id: 'm1', employee: 'p1', month: '2026-03', wageType: 'bonus', amount: 2000, enteredAt: '2026-03-10T08:00:00Z' }];
    const d = computePayslip({ data: ch.payroll!, years: ch.payrollYears, store, history: historyOf([]) }, 'p1', '2026-03')!;
    assert.deepEqual(lines(d).find(([w]) => w === 'ahv-an'), ['ahv-an', 2000, 5.3, 106], exit);
    assert.equal(d.used.find((u) => u.path === 'federal/ahvEmployee')?.validFrom, `${figureYear}-01-01`);
    assert.equal(d.facts.some((f) => f.key === 'figuresOfYear' && f.vars?.earned === exit.slice(0, 4) && f.vars?.year === figureYear), fact, exit);
    const src = lineSource(d.lines.find((l) => l.wageType === 'ahv-an')!, d, ch.payroll!, ch.payrollYears, store.insurances);
    assert.equal(src?.kind === 'federal' ? src.year : undefined, figureYear);
  }
});

test('liable by age in the year earned: born 2009, paid in 2027 for 2026, owes no AHV', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { birthDate: '2009-05-01', employment: [dated('2026-01-01', monthly(3000), undefined, '2026-12-31')] })]);
  const events = closeMonths(store, months26, years);
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2027-02', wageType: 'bonus', amount: 2000, enteredAt: '2027-02-10T08:00:00Z' }];
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
  assert.deepEqual(ahvAlv(d), []);
  assert.ok(facts(d).includes('notLiable'));
});

test('a Nachzahlung for a year the app holds no wages of: the ceiling by the months employed, and said', () => {
  const store = firm([staff('p1', { employment: [dated('2025-01-01', monthly(6000), undefined, '2025-12-31')] })]);
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2026-03', wageType: 'bonus', amount: 2000, enteredAt: '2026-03-10T08:00:00Z' }];
  const d = computePayslip({ data: ch.payroll!, years: ch.payrollYears, store, history: historyOf([]) }, 'p1', '2026-03')!;
  assert.deepEqual(ahvAlv(d), [['ahv-an', 2000, 5.3, 106], ['alv-an', 2000, 1.1, 22]], '12 months of 2025: the whole ceiling of 148,200, none of it known used');
  assert.ok(d.facts.some((f) => f.key === 'wagesNotInApp' && f.vars?.year === '2025'));
  assert.ok(!facts(d).includes('ceiling'));
});

// ─── the third review: one model of the earned year ─────────────────────────────

const months = (y: string, a = 1, b = 12) => Array.from({ length: b - a + 1 }, (_, i) => `${y}-${String(i + a).padStart(2, '0')}`);
const bonusIn = (month: string, amount: number) => ({ id: `b${month}`, employee: 'p1', month, wageType: 'bonus', amount, enteredAt: `${month}-10T08:00:00Z` });
const svLines = (d: { lines: PayslipLine[] }) => d.lines.filter((l) => /^(ahv|alv|nbu)-an$/.test(l.wageType)).map((l) => [l.wageType, l.base, l.amount]);

test('only part of the earned year in the app: the ceiling over the months held, said; never more than the Nachzahlung', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(15000), undefined, '2026-12-31')] })]);
  const events = closeMonths(store, months('2026', 10, 12), years);
  store.monthLines = [bonusIn('2027-02', 2000)];
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
  // October to December: 45,000 held against 3 months of 148,200 / 12 = 37,050: no room.
  assert.deepEqual(svLines(d), [['ahv-an', 2000, 106]]);
  assert.ok(d.facts.some((f) => f.key === 'wagesNotInApp' && f.vars?.year === '2026'));
});

test('a second exit: the Nachzahlung for 2027 counts only 2027\'s months, not one paid in 2027 for 2026 (no negative base)', () => {
  const years = yearsWith2027(['2027', '2028']);
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(6000), undefined, '2026-12-31'), dated('2027-05-01', monthly(12350), undefined, '2027-12-31')] })]);
  const events = closeMonths(store, months('2026'), years);
  store.monthLines = [bonusIn('2027-03', 5000), bonusIn('2028-02', 2000)];
  closeMonths(store, ['2027-03', ...months('2027', 5, 12)], years, events);
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2028-02')!;
  // 2027's figures (here 5.5 %, ALV ceiling 150,000): May to December 2027 at 12,350 = 98,800 held. ALV room 8/12 of
  // 150,000 less it = 1,200; UVG's 148,200 for 8 months = 98,800, none left. Never below zero, the March payment not counted.
  assert.deepEqual(svLines(d), [['ahv-an', 2000, 110], ['alv-an', 1200, 13.2]]);
});

test('a Nachzahlung that lifts a small-wage year over 2,500 catches that year\'s months up; one of another year is not caught up', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(200), undefined, '2026-12-31')] })]);
  const events = closeMonths(store, months('2026'), years);
  store.monthLines = [bonusIn('2027-02', 300)];
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
  assert.deepEqual(svLines(d).filter(([w]) => w === 'ahv-an'), [['ahv-an', 2700, 143.1]], '2026\'s 2,400 caught up with the 300');
  assert.ok(d.facts.some((f) => f.key === 'smallWageCaught' && f.vars?.caught === 2400));
  // The mirror: a Nachzahlung for 2026 paid in January 2027, then a re-hire from March 2027: March catches up nothing of it.
  const s2 = firm([staff('p1', { employment: [dated('2026-01-01', monthly(150), undefined, '2026-12-31'), dated('2027-03-01', monthly(1000))] })]);
  const ev2 = closeMonths(s2, months('2026'), years);
  s2.monthLines = [bonusIn('2027-01', 400)];
  closeMonths(s2, ['2027-01'], years, ev2);
  const mar = computePayslip({ data: ch.payroll!, years, store: s2, history: historyOf(ev2) }, 'p1', '2027-03')!;
  assert.ok(!mar.facts.some((f) => f.key === 'smallWageCaught'));
  assert.deepEqual(svLines(mar).filter(([w]) => w === 'ahv-an'), [['ahv-an', 1000, 55]]);
});

test('the reference age reached after the exit: a Nachzahlung for the months before it is no pensioner\'s', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { birthDate: '1962-01-10', employment: [dated('2026-01-01', monthly(6000), undefined, '2026-06-30')] })]);
  const events = closeMonths(store, months('2026', 1, 6), years);
  store.monthLines = [bonusIn('2027-02', 2000)];
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
  assert.ok(!facts(d).includes('pensioner'), 'reached 10.07.2026, after the exit');
  assert.deepEqual(svLines(d), [['ahv-an', 2000, 106], ['alv-an', 2000, 22], ['nbu-an', 2000, 20]]);
});

test('two Nachzahlungen: the later one, computed while the earlier is open, says the earlier month is open', () => {
  const years = yearsWith2027();
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(12300), undefined, '2026-12-31')] })]);
  const events = closeMonths(store, months('2026'), years);
  store.monthLines = [bonusIn('2027-02', 500), bonusIn('2027-03', 500)];
  const mar = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-03')!;
  assert.ok(mar.facts.some((f) => f.key === 'earlierOpen' && f.vars?.month === '2027-02'));
});

test('walk 3: the entry fact names the pension fund only for a person it insures (§22 decision 107)', () => {
  const at = (amount: number, more: Partial<PayrollEmployee> = {}) => computePayslip(ctxOf(firm([staff('j1', { employment: [dated('2026-03-10', monthly(amount))], ...more })])), 'j1', '2026-03')!;
  const below = at(1500);
  assert.ok(facts(below).includes('belowThreshold'));
  assert.deepEqual(below.facts.filter((f) => f.key.startsWith('entry')).map((f) => [f.key, f.vars]), [['entryNoPension', { date: '2026-03-10' }]], 'below the entry threshold: no pension fund to register with');
  assert.deepEqual(facts(at(5000)).filter((k) => k.startsWith('entry')), ['entry'], 'above it, without her certificate yet: the pension fund is named');
  const insured = at(5000, { insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 300, employer: 300 }, uvg: { insurance: 'uvg', code: 'A1' } })] });
  assert.deepEqual(facts(insured).filter((k) => k.startsWith('entry')), ['entry']);
  const noFund = firm([staff('j1', { employment: [dated('2026-03-10', monthly(5000))] })]);
  noFund.insurances = noFund.insurances.filter((i) => i.kind !== 'bvg');
  assert.deepEqual(facts(computePayslip(ctxOf(noFund), 'j1', '2026-03')!).filter((k) => k.startsWith('entry')), ['entryNoPension'], 'a firm without a pension fund names none');
});
