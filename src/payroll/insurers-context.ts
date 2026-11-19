/**
 * What the classifier and the hand form know of the firm's payroll insurers (docs/specs/payroll.md §6.4,
 * §22 decision 45): a payment to one of them, in a year payroll runs here, pays contributions the payslips
 * accrue on its liability account. It needs no receipt (the payslips are its proof, its bill still pairs) and
 * the hand form proposes bank / that account, never an expense the payslips booked already. Read from
 * payroll.json and the jurisdiction's payroll data, by the insurance's business file or its name, never a
 * named insurer.
 */
import type { BankTransaction } from '../types/index.js';
import { payroll } from '../engines/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { accountOfInsurance, insuranceOfPayment, payrollSince } from './insurers.js';
import { loadPayroll } from './store.js';

type InsurerOf = (tx: BankTransaction, business: string | undefined) => { name: string; account: string } | undefined;

/** The context's `payrollInsurer`, when the firm has payroll insurances and people; else nothing. */
export function payrollInsurerContext(ws: Pick<Workspace, 'paths'>): { payrollInsurer?: InsurerOf } {
  const data = payroll();
  if (!data) return {};
  let store;
  try { store = loadPayroll(ws); } catch { return {}; }
  if (!store.insurances.length || !store.employees.length) return {};
  const since = new Map<string, string | undefined>();
  const sinceOf = (year: string) => (since.has(year) ? since.get(year) : since.set(year, payrollSince(store, year)).get(year));
  return {
    payrollInsurer: (tx, business) => {
      if (tx.direction !== 'DBIT') return undefined;
      // Payroll runs here by the payment's day in its year (a month after the openings); before, level A booked these payments.
      const from = sinceOf(tx.date.slice(0, 4));
      if (!from || from > tx.date) return undefined;
      const ins = insuranceOfPayment(tx, store, () => business);
      const account = ins && accountOfInsurance(data, ins);
      return ins && account ? { name: ins.name, account } : undefined;
    },
  };
}
