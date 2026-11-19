/**
 * What a payslip books (docs/specs/payroll.md §7.2): every line its Lohnart's debit and credit on the
 * posting date, one entry per Lohnart and account pair, under the payslip's ref; a negative amount books
 * the other way. The preview and the close call the same function, so what the preview shows is what
 * closing books. No line carries a VAT code. Pure, browser-safe.
 */
import type { PayrollData } from '../core/modules/schema.js';
import { firmWageTypes, resolveAccount } from './catalogue.js';
import { insuranceOf } from './compute.js';
import type { PayslipDraft } from './compute.js';
import type { PayrollStore } from './model.js';
import { payslipRef } from './model.js';
import { firstDay, lastDay, round2 } from './money.js';

export interface PayrollPosting {
  wageType: string;
  debit: string;
  credit: string;
  amount: number;
  text: string;
}

export interface PayslipBooking {
  ref: string;
  date: string;
  postings: PayrollPosting[];
  /** Lohnarten of the payslip whose account is not set: their lines cannot be booked until it is. */
  withoutAccount: string[];
}

type Slip = Pick<PayslipDraft, 'employee' | 'month' | 'postingDate' | 'lines' | 'person'>;

export function bookingOf(slip: Slip, data: PayrollData, store: Pick<PayrollStore, 'wageTypes' | 'insurances'>): PayslipBooking {
  const types = firmWageTypes(data, store);
  const from = firstDay(slip.month); const to = lastDay(slip.month);
  const merged = new Map<string, PayrollPosting>();
  const withoutAccount = new Set<string>();
  const [y, m] = slip.month.split('-');
  for (const l of slip.lines) {
    const w = types.get(l.wageType);
    if (!w) { withoutAccount.add(l.wageType); continue; }
    const kindOf = (ref: typeof w.debit) => (ref && typeof ref === 'object' ? ref.insurance : undefined);
    const kind = kindOf(w.debit) ?? kindOf(w.credit);
    const insurance = kind ? insuranceOf(store, kind, from, to) : undefined;
    const debit = resolveAccount(w.debit, data, insurance);
    const credit = resolveAccount(w.credit, data, insurance);
    if (!debit || !credit) { withoutAccount.add(w.key); continue; }
    const key = `${w.key}|${debit}|${credit}`;
    const p = merged.get(key) ?? { wageType: w.key, debit, credit, amount: 0, text: `${l.label} ${m}/${y} ${slip.person.name}` };
    p.amount = round2(p.amount + l.amount);
    merged.set(key, p);
  }
  const postings = [...merged.values()].filter((p) => p.amount !== 0).map((p) => (p.amount < 0 ? { ...p, debit: p.credit, credit: p.debit, amount: -p.amount } : p));
  return { ref: payslipRef(slip.month, slip.employee), date: slip.postingDate, postings, withoutAccount: [...withoutAccount] };
}
