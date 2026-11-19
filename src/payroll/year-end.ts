/**
 * The payroll's checks of the year-end (docs/specs/payroll.md §6.7, §10.2 A7): facts the Abschluss page
 * shows, never a block and never a reminder. The clearing account at 31.12. against the payouts not paid
 * by then; each insurer's account (accrued, paid, open, its final statement); the wage account against
 * the gross lines of the payslips that book onto it, per person and month; each person's statement of
 * the year (its gross field against her gross, and whether one is issued and still agrees); and, for
 * wages booked from payslips made elsewhere (level A), the deductions account explained by what the
 * wages withheld and what was paid to the funds. Every figure is computed from the books and the closed
 * payslips as they are now. Pure, browser-safe.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import type { PayrollData } from '../core/modules/schema.js';
import { chfAmount } from '../accounting/ledger.js';
import { unclearedContributions } from '../booking/withheld.js';
import { bookingOf } from './booking.js';
import { firmWageTypes } from './catalogue.js';
import { lohnausweisOf, type LohnausweisData } from './documents.js';
import { insurerRows, type InsurerRow } from './insurers.js';
import { paidFor, paymentOf } from './payments.js';
import { payslipRef, settlementRefPrefix, type PayrollEmployee, type PayrollStore, type PayslipClose } from './model.js';
import { round2 } from './money.js';

type Books = {
  journalEntries: readonly JournalEntry[];
  transactions: readonly BankTransaction[];
  mappings: readonly Mapping[];
  receipts?: readonly Pick<Receipt, 'id' | 'extractedText'>[];
  config?: { openingBalances?: Record<string, Record<string, number>> };
};

/** A payout that 31.12. leaves on the clearing account: the payslip, and what of it the bank had not paid by then. */
export interface UnpaidPayout { id: string; employee: string; name: string; month: string; payout: number; open: number }

export interface ClearingCheck {
  account: string;
  /** The account's credit at 31.12. (the payouts it still owes). */
  balance: number;
  unpaid: UnpaidPayout[];
  /** What the unpaid payouts leave on it: what it should hold. */
  expected: number;
  /** balance − expected: 0 when the account holds exactly the payouts not paid. */
  difference: number;
}

/** An insurer at 31.12.: the payslips' accrual, what was paid, what is open, and its final statement's entries (LS-). */
export interface InsurerCheck extends InsurerRow { settlement: Array<{ id: string; ref: string; date: string; amount: number }> }

/**
 * One payslip's (or, for level A, one external payslip's) share of the wage account: its gross, what its gross lines
 * book onto the wage account, and the refs its booking carries. A-2 adds the payslips other programs made as rows of
 * this shape, with the refs of the payments that book them.
 */
export interface WageRow { employee: string; name: string; month: string; id: string; gross: number; expected: number; refs: readonly string[]; source: 'payslip' | 'external' }

export interface PersonWages {
  employee: string; name: string;
  gross: number;
  /** What her payslips' gross lines book onto the wage account (the gross less the lines booked elsewhere, as daily allowances). */
  expected: number;
  /** What the books hold on the wage account under her payslips' refs. */
  booked: number;
  difference: number;
  /** The months whose booking differs, each with its payslip. */
  months: Array<{ month: string; id: string; expected: number; booked: number; difference: number }>;
}

export interface WageCheck {
  account: string;
  /** The wage account's debit of the year. */
  booked: number;
  persons: PersonWages[];
  /** The part of the account no payslip of the app (or read) books: wages booked otherwise, by hand or from another program's slip. */
  other: number;
  /** The persons' differences summed. */
  difference: number;
}

export interface StatementCheck {
  employee: string; name: string;
  /** Her gross of the year: the closed payslips' and the opening of a firm that started payroll mid-year. */
  gross: number;
  /** The form's gross field as her closed payslips give it today (whole francs). */
  field: string;
  today: number;
  /** today − gross beyond the rounding of each field to francs; 0 inside it. */
  difference: number;
  /** Gross Lohnarten that name no field: the gross field is short of the gross by their lines. */
  unmapped: Array<{ wageType: string; amount: number }>;
  openMonths: string[];
  /** The newest statement issued for the year, with its gross field. */
  issued?: { id: string; issuedAt: string; value: number };
}

/** Level A's deductions account at 31.12.: what the wages withheld, what the payments to the funds took off, what else moved it. */
export interface WithheldCheck {
  account: string;
  opening: number;
  withheld: number;
  paid: number;
  other: number;
  balance: number;
  /** Contribution payments that took less of the employees' share off the account than it held: that much is on the expense instead. */
  uncleared: Array<{ ref: string; date: string; open: number }>;
}

export interface PayrollYearEnd {
  year: string;
  clearing?: ClearingCheck;
  insurers: InsurerCheck[];
  wages?: WageCheck;
  statements: StatementCheck[];
  withheld?: WithheldCheck;
}

/** A Lohnausweis as issued, as much of it as the check reads. */
export interface IssuedStatement { id: string; employee: string; issuedAt: string; data: Pick<LohnausweisData, 'fields'> }

export interface PayrollYearEndInput {
  year: string;
  books: Books;
  /** Every closed payslip as it stands (any year: an earlier year's unpaid payout is still on the clearing account). */
  closes: readonly PayslipClose[];
  employees: readonly PayrollEmployee[];
  data: PayrollData;
  store: Pick<PayrollStore, 'insurances' | 'wageTypes'>;
  issued: readonly IssuedStatement[];
  isDebitNormal: (account: string) => boolean;
  /** The jurisdiction's wage account and deductions account (setup `wages`). */
  wageAccount?: string;
  deductionsAccount?: string;
  /** Where level A's payments to the funds are known (the business files, the payslips read): what the deductions task reads too. */
  withheldPayees?: ReadonlySet<string>;
  withheldShares?: Readonly<Record<string, number>>;
  /** The payslips other programs made, read (A-2): rows of the wage check beside the app's own. */
  external?: readonly WageRow[];
}

const yearEnd = (year: string) => `${year}-12-31`;

/** `account`'s credit at the end of `to` from the year's opening and the year's entries (in the books' currency). */
function creditOn(books: Books, account: string, year: string, to: string, isDebitNormal: (a: string) => boolean): number {
  const opening = books.config?.openingBalances?.[year]?.[account] ?? 0;
  let credit = isDebitNormal(account) ? -opening : opening;
  for (const e of books.journalEntries) {
    if (e.date < `${year}-01-01` || e.date > to) continue;
    const chf = chfAmount(e);
    if (e.accountCredit === account) credit += chf;
    if (e.accountDebit === account) credit -= chf;
  }
  return round2(credit);
}

/** What an entry adds to the debit of `account`. */
const debitOf = (e: JournalEntry, account: string) => (e.accountDebit === account ? chfAmount(e) : 0) - (e.accountCredit === account ? chfAmount(e) : 0);

export function clearingCheck(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'closes' | 'data' | 'isDebitNormal'>): ClearingCheck {
  const { year, books, data } = input;
  const end = yearEnd(year);
  const unpaid = input.closes.filter((c) => c.postingDate <= end && c.payout !== 0).flatMap((c): UnpaidPayout[] => {
    const tx = paymentOf(books, c);
    const paid = tx && tx.date <= end ? paidFor(books, tx, c) : 0;
    const open = round2(c.payout - paid);
    return open ? [{ id: c.id, employee: c.employee, name: c.person.name, month: c.month, payout: c.payout, open }] : [];
  }).sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
  const balance = creditOn(books, data.clearing, year, end, input.isDebitNormal);
  const expected = round2(unpaid.reduce((s, u) => s + u.open, 0));
  return { account: data.clearing, balance, unpaid, expected, difference: round2(balance - expected) };
}

export function insurerChecks(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'data' | 'store'>): InsurerCheck[] {
  const { year, books } = input;
  return insurerRows(books, input.data, input.store, year).map((r) => ({
    ...r,
    settlement: books.journalEntries.filter((e) => e.transactionRef === `${settlementRefPrefix(year)}${r.id}`).map((e) => ({ id: e.id, ref: e.transactionRef, date: e.date, amount: round2(e.accountCredit === r.account ? e.amount : -e.amount) })),
  }));
}

/** The app's closed payslips of the year as rows of the wage check: what each one's gross lines book onto the wage account. */
export function payslipWageRows(closes: readonly PayslipClose[], data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'wageTypes'>, year: string, account: string): WageRow[] {
  const types = firmWageTypes(data, store);
  return closes.filter((c) => c.postingDate.startsWith(year)).map((c) => {
    const gross = { ...c, lines: c.lines.filter((l) => types.get(l.wageType)?.stage === 'gross') };
    const expected = round2(bookingOf(gross, data, store).postings.reduce((s, p) => s + (p.debit === account ? p.amount : 0) - (p.credit === account ? p.amount : 0), 0));
    return { employee: c.employee, name: c.person.name, month: c.month, id: c.id, gross: c.gross, expected, refs: [payslipRef(c.month, c.employee)], source: 'payslip' as const };
  });
}

/** The wage account of the year against its rows, per person; what no row books is `other`. Rows of any source (the app's payslips, A-2's). */
export function wageCheck(books: Pick<Books, 'journalEntries'>, account: string, year: string, rows: readonly WageRow[]): WageCheck {
  const ofYear = books.journalEntries.filter((e) => e.date.startsWith(year) && (e.accountDebit === account || e.accountCredit === account));
  const byRef = new Map<string, number>();
  for (const e of ofYear) byRef.set(e.transactionRef, (byRef.get(e.transactionRef) ?? 0) + debitOf(e, account));
  const persons = new Map<string, PersonWages>();
  const claimed = new Set<string>();
  for (const r of rows) {
    const booked = round2(r.refs.reduce((s, ref) => s + (claimed.has(ref) ? 0 : byRef.get(ref) ?? 0), 0));
    for (const ref of r.refs) claimed.add(ref);
    const p = persons.get(r.employee) ?? { employee: r.employee, name: r.name, gross: 0, expected: 0, booked: 0, difference: 0, months: [] };
    p.gross = round2(p.gross + r.gross);
    p.expected = round2(p.expected + r.expected);
    p.booked = round2(p.booked + booked);
    p.difference = round2(p.booked - p.expected);
    const difference = round2(booked - r.expected);
    if (difference) p.months.push({ month: r.month, id: r.id, expected: r.expected, booked, difference });
    persons.set(r.employee, p);
  }
  const total = round2(ofYear.reduce((s, e) => s + debitOf(e, account), 0));
  const inRows = round2([...claimed].reduce((s, ref) => s + (byRef.get(ref) ?? 0), 0));
  const list = [...persons.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { account, booked: total, persons: list, other: round2(total - inRows), difference: round2(list.reduce((s, p) => s + p.difference, 0)) };
}

/** Each person of the year with closed payslips (or an opening): her statement's gross field against her gross, and the one issued. */
export function statementChecks(input: Pick<PayrollYearEndInput, 'year' | 'closes' | 'employees' | 'data' | 'store' | 'issued'>): StatementCheck[] {
  const { year, data } = input;
  const form = data.lohnausweis?.fields ?? [];
  // The gross field: the form's sum that takes nothing off (the net sums take the deductions off it).
  const grossField = form.find((f) => f.sum && !f.sum.minus?.length);
  if (!grossField?.sum) return [];
  const parts = grossField.sum.plus;
  const types = firmWageTypes(data, input.store);
  const closes = input.closes.filter((c) => c.month.startsWith(year));
  return input.employees.flatMap((e): StatementCheck[] => {
    const mine = closes.filter((c) => c.employee === e.id);
    const opening = e.opening?.[year];
    if (!mine.length && !opening) return [];
    const la = lohnausweisOf(e, input.closes, types, data, year, e.language);
    const openingGross = parts.reduce((s, k) => s + (opening?.fields?.[k] ?? 0), 0);
    const gross = round2(mine.reduce((s, c) => s + c.gross, 0) + openingGross);
    const today = la.fields[grossField.key] ?? 0;
    const unmapped = (la.unmapped ?? []).map((wageType) => ({ wageType, amount: round2(mine.reduce((s, c) => s + c.lines.filter((l) => l.wageType === wageType).reduce((a, l) => a + (types.get(wageType)?.sign === '-' ? -l.amount : l.amount), 0), 0)) }));
    // Each field is rounded to francs before the sum: up to half a franc per field that holds something is rounding, not a difference.
    const rounding = parts.filter((k) => (la.fields[k] ?? 0) !== 0).length * 0.5 + 0.005;
    const raw = round2(today - gross);
    const issued = input.issued.filter((s) => s.employee === e.id).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt)).at(-1);
    return [{
      employee: e.id, name: mine.at(-1)?.person.name ?? e.id, gross, field: grossField.key, today,
      difference: Math.abs(raw) <= rounding ? 0 : raw, unmapped, openMonths: la.openMonths,
      ...(issued ? { issued: { id: issued.id, issuedAt: issued.issuedAt, value: issued.data.fields[grossField.key] ?? 0 } } : {}),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Level A's deductions account at 31.12., explained: undefined when it holds nothing and nothing moved it in the year. */
export function withheldCheck(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'isDebitNormal' | 'wageAccount' | 'deductionsAccount' | 'withheldPayees' | 'withheldShares'>): WithheldCheck | undefined {
  const { year, books, deductionsAccount: account, wageAccount } = input;
  if (!account) return undefined;
  const end = yearEnd(year);
  const on = books.journalEntries.filter((e) => e.date >= `${year}-01-01` && e.date <= end && (e.accountDebit === account || e.accountCredit === account));
  const openingRaw = books.config?.openingBalances?.[year]?.[account] ?? 0;
  const opening = round2(input.isDebitNormal(account) ? -openingRaw : openingRaw);
  if (!on.length && !opening) return undefined;
  const refsOf = (pred: (e: JournalEntry) => boolean) => new Set(books.journalEntries.filter(pred).map((e) => e.transactionRef));
  const wageRefs = wageAccount ? refsOf((e) => e.accountDebit === wageAccount) : new Set<string>();
  const out = new Set(books.transactions.filter((t) => t.direction === 'DBIT').map((t) => t.ref));
  let withheld = 0; let paid = 0; let other = 0;
  for (const e of on) {
    const credit = (e.accountCredit === account ? chfAmount(e) : 0) - (e.accountDebit === account ? chfAmount(e) : 0);
    if (credit > 0 && wageRefs.has(e.transactionRef)) withheld += credit;
    else if (credit < 0 && out.has(e.transactionRef) && !wageRefs.has(e.transactionRef)) paid -= credit;
    else other += credit;
  }
  const uncleared = unclearedContributions(books, `${year}-01-01`, end, input.withheldPayees ?? new Set(), input.withheldShares ?? {})
    .map((u) => ({ ref: u.tx.ref, date: u.tx.date, open: u.open }));
  return { account, opening, withheld: round2(withheld), paid: round2(paid), other: round2(other), balance: round2(opening + withheld - paid + other), uncleared };
}

/** Every payroll check of the year's close. */
export function payrollYearEnd(input: PayrollYearEndInput): PayrollYearEnd {
  const { year } = input;
  const hasPayslips = input.closes.some((c) => c.postingDate.startsWith(year)) || input.employees.some((e) => !!e.opening?.[year]);
  const rows = input.wageAccount ? [...payslipWageRows(input.closes, input.data, input.store, year, input.wageAccount), ...(input.external ?? [])] : [];
  const clearing = hasPayslips || input.closes.some((c) => c.postingDate <= yearEnd(year)) ? clearingCheck(input) : undefined;
  const insurers = insurerChecks(input).filter((i) => i.accrued !== 0 || i.paid !== 0 || i.settlement.length);
  return {
    year,
    ...(clearing && (hasPayslips || clearing.balance !== 0 || clearing.unpaid.length) ? { clearing } : {}),
    insurers,
    ...(input.wageAccount && rows.length ? { wages: wageCheck(input.books, input.wageAccount, year, rows) } : {}),
    statements: statementChecks(input),
    ...(() => { const w = withheldCheck(input); return w ? { withheld: w } : {}; })(),
  };
}
