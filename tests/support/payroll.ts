/**
 * The invented one-person GmbH of docs/specs/payroll.md §7.2 as payroll.json: the owner-employee, gross
 * 10,000; AHV/IV/EO and ALV by the law, BVG 300 fixed each side from the certificate, NBU 1 % paid by the
 * employee, BU 0.1 %, KTG 0.5 % each side, FAK 1.2 %, administration cost 3 %. Invented people only.
 */
import type { DatedEntry } from '../../src/core/dated.js';
import { loadJurisdiction } from '../../src/core/modules/load.js';
import { computePayslip, type PayrollContext, type PayslipDraft } from '../../src/payroll/compute.js';
import { historyOf } from '../../src/payroll/history.js';
import { emptyPayroll } from '../../src/payroll/store.js';
import type { PayrollEmployee, PayrollStore, PayslipClose, PayslipEvent } from '../../src/payroll/model.js';
import { APP_ROOT } from '../../src/workspace/workspace.js';

export const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
export const T0 = '2026-01-02T09:00:00.000Z';
export const dated = <T>(validFrom: string, value: T, enteredAt = T0, validUntil?: string): DatedEntry<T> =>
  ({ validFrom, value, enteredAt, ...(validUntil ? { validUntil } : {}) });

export function owner(overrides: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return {
    id: 'e1', isOwner: true, language: 'de', birthDate: '1980-05-12', sex: 'm',
    name: [dated('2026-01-01', { first: 'Mila', last: 'Beispiel' })],
    address: [dated('2026-01-01', { street: 'Musterweg', number: '1', postcode: '6300', town: 'Zug', country: 'CH' })],
    bank: [dated('2026-01-01', { iban: ['CH93', '00762011623852957'].join('') })],
    employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 10000, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })],
    recurring: [],
    insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 300, employer: 300 }, uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } })],
    ...overrides,
  };
}

export function firm(employees: PayrollEmployee[] = [owner()]): PayrollStore {
  const store = emptyPayroll();
  store.company.canton = [dated('2026-01-01', 'ZG')];
  store.insurances = [
    { id: 'ak', kind: 'ahv', name: 'Ausgleichskasse Beispiel', memberNumber: '100.200', solutions: [{ code: 'A', rates: [dated('2026-01-01', { adminCost: 3 })] }], validFrom: '2026-01-01' },
    { id: 'fak', kind: 'fak', name: 'FAK Beispiel', solutions: [{ code: 'A', rates: [dated('2026-01-01', { employer: 1.2 })] }], validFrom: '2026-01-01' },
    { id: 'uvg', kind: 'uvg', name: 'Unfallversicherung Beispiel', solutions: [{ code: 'A1', rates: [dated('2026-01-01', { bu: 0.1, nbu: 1, nbuEmployerShare: 0 })] }], validFrom: '2026-01-01' },
    { id: 'ktg', kind: 'ktg', name: 'Krankentaggeld Beispiel', solutions: [{ code: 'A', rates: [dated('2026-01-01', { employee: 0.5, employer: 0.5 })] }], validFrom: '2026-01-01' },
    { id: 'pk', kind: 'bvg', name: 'Pensionskasse Beispiel', contractNumber: 'V-77', solutions: [{ code: 'K', rates: [] }], validFrom: '2026-01-01' },
  ];
  store.employees = employees;
  return store;
}

export const ctxOf = (store: PayrollStore, events: PayslipEvent[] = []): PayrollContext => ({ data: ch.payroll!, years: ch.payrollYears, store, history: historyOf(events) });

/** A draft as its close keeps it (the pure part of src/payroll/close.ts), for building a year of closed months. */
export function closeOf(d: PayslipDraft, closedAt = `${d.month}-28T12:00:00.000Z`): PayslipClose {
  return {
    event: 'close', id: d.id, employee: d.employee, month: d.month, postingDate: d.postingDate, payday: d.payday, closedAt, closedBy: 'person',
    lines: d.lines, bases: d.bases, gross: d.gross, net: d.net, payout: d.payout, employer: d.employer, left: d.missing, entries: [], used: d.used, person: d.person,
  };
}

/** Closes the person's months from January up to (not including) `until`, in order, and returns the events. */
export function closedThrough(store: PayrollStore, until: string, employee = 'e1', events: PayslipEvent[] = []): PayslipEvent[] {
  const out = [...events];
  for (let m = 1; ; m++) {
    const month = `${until.slice(0, 4)}-${String(m).padStart(2, '0')}`;
    if (month >= until) return out;
    const d = computePayslip(ctxOf(store, out), employee, month);
    if (d) out.push(closeOf(d));
  }
}

export const line = (d: PayslipDraft, wageType: string) => d.lines.filter((l) => l.wageType === wageType);
export const amountOf = (d: PayslipDraft, wageType: string) => line(d, wageType).reduce((s, l) => s + l.amount, 0);
