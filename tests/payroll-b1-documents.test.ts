/**
 * The documents of phase B1 (docs/specs/payroll.md §5.6, §15.3 checkpoints 5 and 6): the FAK statement agrees
 * with what the payslips booked on the fund's account, the pension fund's expected wages, the persons exempt on
 * the AHV declaration, and for each person Lohnausweis field 8 and the declared AHV and ALV wages agree with
 * her Lohnkonto. A small firm of invented people, closed January to December.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslip } from '../src/payroll/compute.js';
import { bookingOf } from '../src/payroll/booking.js';
import { declarationRows, familyAllowanceStatement, lohnausweisOf, lohnkonto, pensionWages } from '../src/payroll/documents.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import type { PayrollEmployee, PayslipClose, PayslipEvent } from '../src/payroll/model.js';
import { round2 } from '../src/payroll/money.js';
import { ch, closeOf, ctxOf, dated, firm, owner } from './support/payroll.js';

const ins = (more = {}) => [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ...more })];
const person = (id: string, more: Partial<PayrollEmployee>): PayrollEmployee =>
  owner({ id, isOwner: false, sex: 'f', birthDate: '1988-05-05', name: [dated('2026-01-01', { first: 'Ida', last: id })], insurances: ins(), ...more });

const staff = [
  owner(),
  person('kid', { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 5000, pensum: 100, hoursPerWeek: 42, thirteenth: { months: [12] } })], children: [{ id: 'k', name: 'Lea', birthDate: '2019-02-11', allowance: [dated('2026-01-01', { wageType: 'kinderzulage', amount: 215 })] }] }),
  person('young', { birthDate: '2010-06-01', employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 900, pensum: 100, hoursPerWeek: 10 })] }),
  person('small', { employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 150, pensum: 100, hoursPerWeek: 3 })] }),
  person('old', { sex: 'm', birthDate: '1960-01-20', employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 4000, pensum: 100, hoursPerWeek: 30 })] }),
  person('hour', { employment: [dated('2026-03-01', { kind: 'hourly' as const, amount: 28, holidayDays: 20 })] }),
];

function year(): { closes: PayslipClose[]; store: ReturnType<typeof firm> } {
  const store = firm(staff);
  store.monthLines = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, employee: 'hour', month: `2026-${String(i + 3).padStart(2, '0')}`, wageType: 'stundenlohn', quantity: 60 + i, enteredAt: '2026-01-01T00:00:00Z' }));
  const events: PayslipEvent[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `2026-${String(m).padStart(2, '0')}`;
    for (const e of store.employees) {
      const d = computePayslip(ctxOf(store, events), e.id, month);
      if (d) events.push(closeOf(d));
    }
  }
  return { closes: events as PayslipClose[], store };
}

test('the FAK statement agrees with the fund\'s account: contributions less the allowances booked through it', () => {
  const { closes, store } = year();
  const f = familyAllowanceStatement(store.employees, closes, firmWageTypes(ch.payroll!, store), ch.payroll!, '2026');
  assert.equal(f.kind, 'fak');
  const kid = f.rows.find((r) => r.employee === 'kid')!;
  assert.deepEqual(kid.children.map((c) => [c.child, c.wageType, c.total]), [['Lea', 'kinderzulage', 12 * 215]]);
  assert.equal(f.totals.allowances, 2580);
  // What the payslips booked on 2272, posting by posting.
  let onFund = 0;
  for (const c of closes) for (const p of bookingOf(c, ch.payroll!, store).postings) onFund += (p.credit === '2272' ? p.amount : 0) - (p.debit === '2272' ? p.amount : 0);
  assert.equal(round2(onFund), f.totals.balance, 'the statement\'s balance is the account\'s movement from the payslips');
  assert.equal(f.totals.balance, round2(f.totals.contributions - f.totals.allowances));
});

test('the pension fund\'s expected wages: the January wage × 12 with the 13th; an hourly one from its first closed month; below the threshold said', () => {
  const { closes, store } = year();
  const rows = pensionWages(store.employees, closes, ch.payroll!, ch.payrollYears, '2026');
  const of = (id: string) => rows.find((r) => r.employee === id)!;
  assert.deepEqual([of('e1').yearly, of('e1').insured], [120000, true]);
  assert.equal(of('kid').yearly, 65000, '5,000 × 13');
  assert.equal(of('young').belowThreshold, 22680);
  assert.equal(of('hour').on, '2026-03-01', 'from the entry');
  assert.equal(of('hour').monthly, 1680 + 139.95, 'March: 60 h × 28 and the holiday surcharge 8.33 % (to 0.05), as the payslip kept the base');
});

test('the AHV declaration names the persons exempt: by age, as a pensioner with the allowance, by a small wage', () => {
  const { closes, store } = year();
  const rows = declarationRows(store.employees, closes, '2026', { data: ch.payroll!, years: ch.payrollYears });
  const of = (id: string) => rows.find((r) => r.employee === id)!;
  assert.deepEqual(of('young').exempt, { liable: 0, amount: 10800, reason: 'age' });
  assert.deepEqual(of('small').exempt, { liable: 0, amount: 1800, reason: 'smallWage' });
  assert.deepEqual(of('old').exempt, { liable: 31200, amount: 16800, reason: 'pensioner' }, '12 × 1,400 allowance (reference age in January 2025)');
  assert.equal(of('e1').exempt, undefined);
  assert.ok(!Object.keys(of('small').bases).some((k) => k.includes('#')), 'the small wage\'s bookkeeping is no declared base');
});

test('for each person, Lohnausweis field 8 is Σ gross and family allowances, and the declared AHV and ALV wages are the Lohnkonto\'s', () => {
  const { closes, store } = year();
  const types = firmWageTypes(ch.payroll!, store);
  const decl = declarationRows(store.employees, closes, '2026', { data: ch.payroll!, years: ch.payrollYears });
  for (const e of store.employees) {
    const mine = closes.filter((c) => c.employee === e.id);
    const la = lohnausweisOf(e, closes, types, ch.payroll!, '2026');
    const allowances = mine.flatMap((c) => c.lines.filter((l) => types.get(l.wageType)?.allowance)).reduce((a, l) => a + l.amount, 0);
    const field1 = mine.reduce((a, c) => a + c.gross, 0) + allowances;
    assert.ok(Math.abs(la.fields['8'] - field1) <= mine.length, `${e.id}: field 8 ${la.fields['8']} = Σ gross + allowances ${field1} (whole francs per field)`);
    const k = lohnkonto(mine, types, '2026');
    const d = decl.find((r) => r.employee === e.id)!;
    assert.equal(d.bases.ahv, round2(mine.reduce((a, c) => a + (c.bases.ahv?.month ?? 0), 0)), `${e.id}: AHV wage`);
    assert.equal(round2(k.totals.gross.total), round2(mine.reduce((a, c) => a + c.gross, 0)), `${e.id}: Lohnkonto gross`);
    assert.ok(d.bases['alv|alvCeiling'] === undefined || d.bases['alv|alvCeiling'] <= d.bases.alv, `${e.id}: ALV wage to the ceiling`);
  }
});
