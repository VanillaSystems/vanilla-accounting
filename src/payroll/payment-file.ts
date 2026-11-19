/**
 * The payment file of a month's Lohnzahlungen (docs/specs/payroll.md §6.3, §21 decision 5): the payouts not paid
 * yet, each to the IBAN the payslip printed, from one of the firm's bank accounts in the books' currency, written
 * in the bank format of src/providers/pain001. The person uploads it in e-banking; «bezahlt» still comes only from
 * the bank statement (src/payroll/payments.ts). A payout without an IBAN, or paid already, is left out and named.
 */
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { Address } from '../invoices/model.js';
import { pain001 } from '../providers/pain001/xml.js';
import type { PayslipClose } from './model.js';
import type { PaymentRow } from './payments.js';

export interface PaymentFilePlan {
  /** The firm's accounts a file may debit: bank accounts in the books' currency with an IBAN. */
  accounts: Array<{ account: string; label: string; iban: string }>;
  /** The payouts the file pays. */
  included: Array<{ id: string; name: string; amount: number }>;
  /** The payouts it leaves out, and why. */
  left: Array<{ id: string; name: string; why: 'paid' | 'noIban' }>;
  /** The day the bank is asked to pay: the payday, or today when the payday is past. */
  executionDate: string;
}

export function paymentFilePlan(rows: readonly PaymentRow[], bankAccounts: readonly LedgerBankAccount[], currency: string, today: string): PaymentFilePlan {
  const accounts = bankAccounts.filter((a) => a.role === 'bank' && a.currency === currency && a.iban).map((a) => ({ account: a.account, label: a.label, iban: String(a.iban) }));
  const payable = rows.filter((r) => r.payout > 0);
  const included = payable.filter((r) => !r.paid && r.iban).map((r) => ({ id: r.id, name: r.name, amount: r.payout }));
  const left = payable.filter((r) => r.paid || !r.iban).map((r) => ({ id: r.id, name: r.name, why: r.paid ? 'paid' as const : 'noIban' as const }));
  const payday = payable.map((r) => r.valueDate).sort()[0] ?? today;
  return { accounts, included, left, executionDate: payday < today ? today : payday };
}

const painAddress = (a: Address | undefined) => (a?.town ? { ...(a.street ? { street: a.street } : {}), ...(a.number ? { number: a.number } : {}), postcode: a.postcode, town: a.town, country: a.country } : undefined);

/** The file's bytes: one debit of `account` for the payouts the plan includes. */
export function paymentFileOf(plan: PaymentFilePlan, rows: readonly PaymentRow[], closes: readonly PayslipClose[], firm: { name: string; address?: Address }, account: string, currency: string, now: string): string {
  const debtor = plan.accounts.find((a) => a.account === account) ?? plan.accounts[0];
  if (!debtor) throw new Error('no account');
  const month = rows[0]?.id.slice(0, 7) ?? now.slice(0, 7);
  return pain001({
    messageId: `L${month.replace('-', '')}-${now.replace(/\D/g, '').slice(0, 14)}`,
    created: now, executionDate: plan.executionDate, currency,
    debtor: { name: firm.name, iban: debtor.iban, ...(painAddress(firm.address) ? { address: painAddress(firm.address)! } : {}) },
    payments: plan.included.map((p) => {
      const row = rows.find((r) => r.id === p.id)!;
      const address = painAddress(closes.find((c) => c.id === p.id)?.person.address);
      return { id: p.id, name: p.name, iban: row.iban!, amount: p.amount, purpose: row.purpose, ...(address ? { address } : {}) };
    }),
  });
}
