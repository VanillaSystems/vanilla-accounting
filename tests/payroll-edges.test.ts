/**
 * The payroll engine at its edges (docs/specs/payroll.md §3, §13 property tests): cumulated ceilings
 * with a contribution that was not owed in earlier months and with an opening above the ceiling, part
 * months unrounded, the 13th without a base, FAK only on AHV-liable wage, recurring Lohnarten prorated
 * to the days employed, and every Lohnart of the catalogue booking so that 1091 ends at the payout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslip, employedFraction } from '../src/payroll/compute.js';
import { bookingOf } from '../src/payroll/booking.js';
import { assistantArgs, NEVER_READ } from '../src/assistant/claude.js';
import { setJurisdiction } from '../src/engines/index.js';
import { amountOf, ch, closedThrough, ctxOf, dated, firm, line, owner } from './support/payroll.js';

const job = (amount: number, hoursPerWeek = 42) => ({ kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek });

test('the UVG ceiling holds for BU when NBU was not owed in the earlier months (under 8 hours a week)', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', job(20000, 6)), dated('2026-07-01', job(20000, 42), '2026-06-20T00:00:00Z')] })]);
  const events = closedThrough(store, '2026-07');
  const jul = computePayslip(ctxOf(store, events), 'e1', '2026-07')!;
  assert.equal(line(jul, 'bu-ag')[0].base, 12350, '148,200 / 12 a month: the months before used their share already');
  assert.equal(line(jul, 'nbu-an')[0].base, 12350);
});

test('an opening above the ceiling gives no negative base', () => {
  const store = firm([owner({ employment: [dated('2026-07-01', job(15000))], opening: { 2026: { months: 6, bases: { ahv: 90000, alv: 90000, uvg: 90000 } } } })]);
  const jul = computePayslip(ctxOf(store), 'e1', '2026-07')!;
  assert.equal(line(jul, 'alv-an')[0].base, 12350, 'the opening used 74,100 of the ceiling, July its own 12,350');
});

test('a part month is not rounded before it prorates: entry on 16 March, the BVG certificate prorated by 16/31', () => {
  const store = firm([owner({ employment: [dated('2026-03-16', job(10000))] })]);
  assert.equal(employedFraction(store.employees[0], '2026-03', 'calendar-days'), 16 / 31);
  const d = computePayslip(ctxOf(store), 'e1', '2026-03')!;
  assert.equal(amountOf(d, 'bvg-an'), 154.85, '300 × 16/31 = 154.84, to 0.05');
});

test('the 13th of an hourly person without hours in December is 0, never NaN', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'hourly' as const, amount: 30, hoursPerWeek: 20, thirteenth: { months: [12] } })] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-12')!;
  assert.ok(Number.isFinite(d.gross) && Number.isFinite(d.payout));
  assert.ok(d.missing.some((m) => m.missing === 'hours'));
});

test('FAK follows the AHV wage: none for a person not yet liable, the allowance off for a pensioner', () => {
  const young = computePayslip(ctxOf(firm([owner({ birthDate: '2010-03-01' })])), 'e1', '2026-09')!;
  assert.equal(amountOf(young, 'ahv-ag'), 0);
  assert.equal(amountOf(young, 'fak-ag'), 0);
  const old = computePayslip(ctxOf(firm([owner({ birthDate: '1958-02-10' })])), 'e1', '2026-09')!;
  assert.equal(line(old, 'ahv-an')[0].base, 8600);
  assert.equal(line(old, 'fak-ag')[0].base, 8600);
  assert.equal(amountOf(old, 'alv-an'), 0, 'no ALV past the reference age');
});

test('a recurring Lohnart is prorated to the days employed: flat expenses of a person who starts on the 16th', () => {
  const store = firm([owner({ employment: [dated('2026-03-16', job(10000))], recurring: [{ wageType: 'pauschalspesen', value: [dated('2026-01-01', { amount: 600 })] }] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-03')!;
  assert.equal(amountOf(d, 'pauschalspesen'), 309.7, '600 × 16/31');
});

test('every Lohnart a person can enter books so that 1091 ends at the payout', () => {
  const entered = ch.payroll!.wageTypes.filter((w) => !w.computes);
  for (const w of entered) {
    const store = firm();
    store.monthLines = [{ id: 'l1', employee: 'e1', month: '2026-09', wageType: w.key, ...(w.input === 'quantity' ? { quantity: 2, rate: 50 } : { amount: 100 }), enteredAt: '2026-09-02T00:00:00Z' }];
    const d = computePayslip(ctxOf(store), 'e1', '2026-09')!;
    const b = bookingOf(d, ch.payroll!, store);
    const on1091 = b.postings.reduce((s, p) => s + (p.credit === '1091' ? p.amount : 0) - (p.debit === '1091' ? p.amount : 0), 0);
    assert.equal(Math.round(on1091 * 100) / 100, d.payout, `${w.key}: 1091 holds the payout`);
  }
});

test('the AI sidebar never reads payroll.json, the payslip events or a payslip\'s PDF', () => {
  setJurisdiction(ch);
  const args = assistantArgs({ language: 'de' }, undefined, '/tmp/repo', 'Mila');
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const p of NEVER_READ) assert.ok(denied.includes(`Read(${p})`), p);
  assert.ok(NEVER_READ.some((p) => p.includes('payroll.json')) && NEVER_READ.some((p) => p.includes('/payroll/')));
});
