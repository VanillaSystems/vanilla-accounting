/**
 * What the classifier, receipt-wait and the hand form know of the firm's payroll insurers (docs/specs/payroll.md
 * §6.4, §22 decision 45), by the one decision of src/payroll/insurers.ts insurerPaymentOf: a payment to one of
 * them while payroll runs here needs no receipt (the payslips prove it; its bill still pairs) and is never the
 * model's. Code books it against the liability when the liability covers it; else it waits for the person, whose
 * hand form offers the liability (months from payroll's start) or level A's booking (months before). Only when
 * the jurisdiction's payroll books through its clearing account, as the classifier's wage match. Read from
 * payroll.json, by the insurance's business file or its name, never a named insurer.
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { baseCurrency, payroll, payrollClearing } from '../engines/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { insurerPaymentOf, type PayrollWayOf } from './insurers.js';
import type { Counterparty } from '../knowledge/counterparties.js';
import type { PayrollWay } from '../knowledge/payroll-way.js';
import { loadPayroll } from './store.js';

/** The insurer a payment goes to, its liability account, and whether the liability covers it. */
export type PayrollInsurerOf = (tx: BankTransaction, business: string | undefined, entries: readonly JournalEntry[]) =>
  { id: string; name: string; account: string; covered: boolean; shared: boolean; books: boolean; kept?: PayrollWay; business?: string } | undefined;

/** The ways the company keeps per business file (`payroll.payments`, «Immer so»). */
export const payrollWays = (counterparties: readonly Pick<Counterparty, 'id' | 'payroll'>[]): PayrollWayOf => {
  const ways = new Map(counterparties.flatMap((c) => (c.payroll ? [[c.id, c.payroll.payments] as const] : [])));
  return (business) => ways.get(business);
};

/** The context's `payrollInsurer`, when the firm has payroll insurances and people; else nothing. */
export function payrollInsurerContext(ws: Pick<Workspace, 'paths'>, counterparties: readonly Pick<Counterparty, 'id' | 'payroll'>[] = []): { payrollInsurer?: PayrollInsurerOf } {
  const data = payroll();
  if (!data || !payrollClearing()) return {};
  let store;
  try { store = loadPayroll(ws); } catch { return {}; }
  if (!store.insurances.length || !store.employees.length) return {};
  const currency = baseCurrency();
  const wayOf = payrollWays(counterparties);
  return {
    payrollInsurer: (tx, business, entries) => {
      const p = insurerPaymentOf(tx, entries, data, store, () => business, currency, wayOf);
      return p && { id: p.insurance.id, name: p.insurance.name, account: p.account, covered: p.covered, shared: p.shared, books: p.books, ...(p.kept ? { kept: p.kept } : {}), ...(p.business ? { business: p.business } : {}) };
    },
  };
}
