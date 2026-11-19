/**
 * The payroll's checks of the year-end (docs/specs/payroll.md §6.7, §10.2 A7): facts the Abschluss page
 * shows, never a block and never a reminder. The clearing account at 31.12. against the payouts not paid
 * by then; each insurer's account (accrued, paid, open, its final statement); the wage account against
 * the gross lines of the payslips that book onto it, per person and month; each person's statement of
 * the year (its gross field against her gross, and whether one is issued and still agrees); and, for
 * wages booked from payslips made elsewhere (level A), the deductions account explained by what the
 * wages withheld and what was paid to the funds; the tax at source's account against what the settlement
 * lists leave to pay. Every figure is computed from the books and the closed
 * payslips as they are now. Pure, browser-safe.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import type { PayrollData } from '../core/modules/schema.js';
import { chfAmount } from '../accounting/ledger.js';
import { unclearedContributions } from '../booking/withheld.js';
import { bookingOf, lineInsuranceOf } from './booking.js';
import { firmWageTypes } from './catalogue.js';
import { countedCloses, lohnausweisOf, type LohnausweisData } from './documents.js';
import { accountOfInsurance, insurerRows, settlementOf, type InsurerRow } from './insurers.js';
import { settlementsOf } from './settlement.js';
import { openingOf } from './opening.js';
import { valueOn } from '../core/dated.js';
import { paidFor, paymentOf } from './payments.js';
import { payslipRef, settlementRefPrefix, type PayrollEmployee, type PayrollStore, type PayslipClose } from './model.js';
import { firstDay, lastDay, round2 } from './money.js';

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

/**
 * A liability account of the insurers at 31.12. (one fact per account: two insurances of one insurer may share it, as
 * accident and its supplement do): what it carried into the year, what the payslips accrued, what was paid, what is
 * open, the final statements booked on it, and which of its insurances take a final statement.
 */
export interface InsurerCheck {
  account: string;
  /** The firm's insurances on the account; `settleable`: settlementOf compares it (it refuses one no employer's Lohnart books on, as the tax at source). */
  insurances: Array<{ id: string; kind: string; name: string; settleable: boolean }>;
  carried: number;
  accrued: number;
  paid: number;
  open: number;
  settlement: Array<{ id: string; ref: string; date: string; amount: number }>;
  /**
   * What the year's contributions in the books are made of, as the final statement compares them (settlementOf): the
   * payslips' accrual and, for the opening's months, the payments to the insurers level A booked elsewhere (`before`,
   * through `beforeUntil`). Absent where none of the account's insurances can be compared.
   */
  compare?: { before: number; beforeUntil?: string; books: number };
}

/**
 * One payslip's (or, for level A, one external payslip's) share of the wage account: its gross, what its gross lines
 * book onto the wage account, and the refs its booking carries. A-2 adds the payslips other programs made as rows of
 * this shape, with the refs of the payments that book them.
 */
export interface WageRow {
  employee: string; name: string; month: string; id: string; gross: number; expected: number; refs: readonly string[]; source: 'payslip' | 'external';
  /** Why the row's booking cannot be compared: a Lohnart's accounts changed since it closed and a person changed its entries too. No difference is said. */
  cause?: 'accountsChanged';
}

export interface PersonWages {
  employee: string; name: string;
  gross: number;
  /** What her payslips' gross lines book onto the wage account (the gross less the lines booked elsewhere, as daily allowances). */
  expected: number;
  /** What the books hold on the wage account under her payslips' refs. */
  booked: number;
  difference: number;
  /** The months whose booking differs, each with its payslip. */
  months: Array<{ month: string; id: string; expected: number; booked: number; difference: number; cause?: WageRow['cause'] }>;
}

export interface WageCheck {
  account: string;
  /**
   * The opening's months (January to `through`, booked before payroll ran here, by hand or from another program): what the
   * wage account holds under no payslip's ref up to that month's end, beside the opening's gross as its Lohnausweis fields
   * hold it. A fact, never a difference: the fields hold what was booked elsewhere too (an allowance on the fund's account).
   */
  opening?: { through: string; expected: number; booked: number; difference: number };
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
  /**
   * Her gross as the form counts it: the closed payslips' lines whose Lohnart names one of the gross field's parts, signed as
   * the form signs them, and the opening's parts (a family allowance paid with the wage is in it, though no gross line).
   */
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

/**
 * The tax at source's account at 31.12. (§22 decision 113): what it carried into the year, what the year's settlement lists
 * leave to pay (the tax less the commission, as the closed payslips booked it), what was paid to the canton (its debits under
 * no payslip's ref), and the balance against carried + lists − paid. Whether or not the firm entered the canton's tax office.
 */
export interface TaxAtSourceCheck {
  account: string;
  /** The firm's tax offices on the account (a Quellensteuer insurance per canton), where it entered any. */
  insurances: Array<{ id: string; name: string }>;
  carried: number;
  /** Each settlement list of the year on the account: its month, canton and what it leaves to pay. */
  lists: Array<{ month: string; region: string; payable: number }>;
  payable: number;
  paid: number;
  /** carried + payable − paid: what the account should hold. */
  expected: number;
  balance: number;
  /** balance − expected: a payslip's entry changed, or a booking by hand on the account. */
  difference: number;
}

export interface PayrollYearEnd {
  year: string;
  clearing?: ClearingCheck;
  insurers: InsurerCheck[];
  taxAtSource: TaxAtSourceCheck[];
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
  store: Pick<PayrollStore, 'insurances' | 'wageTypes' | 'employees'>;
  /** The business a payment goes to (the business files), and the books' currency: what the final statement's comparison reads. */
  businessOf?: (tx: BankTransaction) => string | undefined;
  currency?: string;
  issued: readonly IssuedStatement[];
  isDebitNormal: (account: string) => boolean;
  /** The jurisdiction's wage account and deductions account (setup `wages`). */
  wageAccount?: string;
  deductionsAccount?: string;
  /** Where level A's payments to the funds are known (the business files, the payslips read): what the deductions task reads too. */
  withheldPayees?: ReadonlySet<string>;
  withheldShares?: Readonly<Record<string, number>>;
  /** The books' money accounts (bank, cash): a refund of the tax at source onto one is a payment back, not a difference. */
  moneyAccounts?: ReadonlySet<string>;
  /** The payslips other programs made, read (A-2): rows of the wage check beside the app's own. */
  external?: readonly WageRow[];
}

const yearEnd = (year: string) => `${year}-12-31`;

/** `account`'s credit at the end of `to` from the year's opening and the year's entries (in the books' currency). */
function creditOn(books: Books, account: string, year: string, to: string, isDebitNormal: (a: string) => boolean): number {
  // The year's opening where the books have one, else what the entries before the year left (a year not opened yet).
  const opening = books.config?.openingBalances?.[year]?.[account];
  let credit = opening === undefined ? 0 : isDebitNormal(account) ? -opening : opening;
  for (const e of books.journalEntries) {
    if ((opening !== undefined && e.date < `${year}-01-01`) || e.date > to) continue;
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
  const atEnd = { transactions: books.transactions.filter((t) => t.date <= end), journalEntries: books.journalEntries.filter((e) => e.date <= end), mappings: books.mappings };
  const unpaid = input.closes.filter((c) => c.postingDate <= end && c.payout !== 0).flatMap((c): UnpaidPayout[] => {
    // What was paid by 31.12.: the books as they stood that day.
    const paid = paidFor(atEnd, c, data.clearing, input.closes) ?? (paymentOf(atEnd, c) ? c.payout : 0);
    const open = round2(c.payout - paid);
    return open ? [{ id: c.id, employee: c.employee, name: c.person.name, month: c.month, payout: c.payout, open }] : [];
  }).sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
  const balance = creditOn(books, data.clearing, year, end, input.isDebitNormal);
  const expected = round2(unpaid.reduce((s, u) => s + u.open, 0));
  return { account: data.clearing, balance, unpaid, expected, difference: round2(balance - expected) };
}

export function insurerChecks(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'data' | 'store' | 'businessOf' | 'currency'>): InsurerCheck[] {
  const { year, books } = input;
  const byAccount = new Map<string, InsurerCheck>();
  for (const r of insurerRows(books, input.data, input.store, year)) {
    const compare = compareOf(input, r.id);
    const ins = { id: r.id, kind: r.kind, name: r.name, settleable: !!compare };
    const settlement = books.journalEntries.filter((e) => e.transactionRef === `${settlementRefPrefix(year)}${r.id}`)
      .map((e) => ({ id: e.id, ref: e.transactionRef, date: e.date, amount: round2(e.accountCredit === r.account ? e.amount : -e.amount) }));
    const had = byAccount.get(r.account);
    // The account's figures are the account's: the same for each insurance on it, so taken once.
    if (!had) { byAccount.set(r.account, { account: r.account, insurances: [ins], carried: r.carried, accrued: r.accrued, paid: r.paid, open: r.open, settlement, ...(compare ? { compare } : {}) }); continue; }
    had.insurances.push(ins);
    had.settlement.push(...settlement);
    if (compare) {
      const before = round2((had.compare?.before ?? 0) + compare.before);
      had.compare = { before, books: round2(had.accrued + before), ...(compare.beforeUntil ?? had.compare?.beforeUntil ? { beforeUntil: compare.beforeUntil ?? had.compare?.beforeUntil } : {}) };
    }
  }
  return [...byAccount.values()];
}

/** The final statement's comparison for an insurance, without a total (it is the statement's); none where settlementOf refuses it. */
function compareOf(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'data' | 'store' | 'businessOf' | 'currency'>, id: string): InsurerCheck['compare'] {
  try {
    const { compare: c } = settlementOf(input.books, input.data, input.store, id, input.year, 0, yearEnd(input.year), () => '', input.businessOf, input.currency);
    return { before: c.before, books: c.books, ...(c.beforeUntil ? { beforeUntil: c.beforeUntil } : {}) };
  } catch {
    return undefined;
  }
}

const isOwn = (e: JournalEntry) => e.by?.kind === 'code' && e.by.check === 'payroll';
const sameBooking = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount'>, p: { debit: string; credit: string; amount: number }) =>
  e.accountDebit === p.debit && e.accountCredit === p.credit && round2(e.amount) === round2(p.amount);

/**
 * The app's closed payslips of the year as rows of the wage check: what each one booked onto the wage account when it
 * closed. Its postings recomputed from its lines are that, while every entry the close booked and nobody changed still
 * reads so; once a Lohnart's accounts changed since, the entries as booked are (a person's changed one by what it was
 * before her change, `by.was`), and where that is not known either, the row names the cause and no difference.
 */
export function payslipWageRows(closes: readonly PayslipClose[], data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'wageTypes'>, year: string, account: string, entries: readonly JournalEntry[] = []): WageRow[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const onWage = (p: { debit: string; credit: string; amount: number }) => (p.debit === account ? p.amount : 0) - (p.credit === account ? p.amount : 0);
  return closes.filter((c) => c.postingDate.startsWith(year)).map((c) => {
    const today = bookingOf(c, data, store).postings;
    const booked = c.entries.map((id) => byId.get(id));
    const aligned = booked.length === today.length;
    // Each entry as the close booked it, where the books still tell: the payslip's own as it stands, a person's changed
    // one by what it was before her change; one she changed without that record, by today's posting while it is on the
    // same accounts (she changed its amount); else not known.
    const asClosed = booked.map((e, i) => {
      if (!e) return aligned ? today[i] : undefined;
      if (isOwn(e)) return { debit: e.accountDebit, credit: e.accountCredit, amount: e.amount };
      const was = e.by?.kind === 'person' ? e.by.was : undefined;
      if (was) return { debit: was.accountDebit ?? e.accountDebit, credit: was.accountCredit ?? e.accountCredit, amount: was.amount ?? e.amount };
      return aligned && e.accountDebit === today[i].debit && e.accountCredit === today[i].credit ? today[i] : undefined;
    });
    const unchanged = !c.entries.length || (aligned && asClosed.every((p, i) => !!p && sameBooking({ accountDebit: p.debit, accountCredit: p.credit, amount: p.amount }, today[i])));
    const expected = unchanged ? today.reduce((s, p) => s + onWage(p), 0)
      : asClosed.every((p) => !!p) ? asClosed.reduce((s, p) => s + onWage(p!), 0) : undefined;
    return {
      employee: c.employee, name: c.person.name, month: c.month, id: c.id, gross: c.gross, expected: round2(expected ?? 0),
      refs: [payslipRef(c.month, c.employee)], source: 'payslip' as const, ...(expected === undefined ? { cause: 'accountsChanged' as const } : {}),
    };
  });
}

/** The wage account of the year against its rows, per person; what no row books is `other`. Rows of any source (the app's payslips, A-2's). */
export function wageCheck(books: Pick<Books, 'journalEntries'>, account: string, year: string, rows: readonly WageRow[], opening?: { through: string; gross: number }): WageCheck {
  const ofYear = books.journalEntries.filter((e) => e.date.startsWith(year) && (e.accountDebit === account || e.accountCredit === account));
  const byRef = new Map<string, number>();
  for (const e of ofYear) byRef.set(e.transactionRef, (byRef.get(e.transactionRef) ?? 0) + debitOf(e, account));
  const persons = new Map<string, PersonWages>();
  const claimed = new Set<string>();
  for (const r of rows) {
    const booked = round2(r.refs.reduce((s, ref) => s + (claimed.has(ref) ? 0 : byRef.get(ref) ?? 0), 0));
    for (const ref of r.refs) claimed.add(ref);
    const p = persons.get(r.employee) ?? { employee: r.employee, name: r.name, gross: 0, expected: 0, booked: 0, difference: 0, months: [] };
    // A row that cannot be compared counts as booked: its cause is named instead of a difference.
    const expected = r.cause ? booked : r.expected;
    p.gross = round2(p.gross + r.gross);
    p.expected = round2(p.expected + expected);
    p.booked = round2(p.booked + booked);
    p.difference = round2(p.booked - p.expected);
    const difference = round2(booked - expected);
    if (difference || r.cause) p.months.push({ month: r.month, id: r.id, expected, booked, difference, ...(r.cause ? { cause: r.cause } : {}) });
    persons.set(r.employee, p);
  }
  const total = round2(ofYear.reduce((s, e) => s + debitOf(e, account), 0));
  const inRows = round2([...claimed].reduce((s, ref) => s + (byRef.get(ref) ?? 0), 0));
  const list = [...persons.values()].sort((a, b) => a.name.localeCompare(b.name));
  // What no row claims, up to the opening's last month, is the opening's wages (booked before payroll ran here).
  const openEnd = opening ? `${opening.through}-31` : '';
  const openingBooked = opening ? round2(ofYear.filter((e) => !claimed.has(e.transactionRef) && e.date <= openEnd).reduce((s, e) => s + debitOf(e, account), 0)) : 0;
  return {
    account, booked: total,
    ...(opening ? { opening: { through: opening.through, expected: opening.gross, booked: openingBooked, difference: round2(openingBooked - opening.gross) } } : {}),
    persons: list, other: round2(total - inRows - openingBooked), difference: round2(list.reduce((s, p) => s + p.difference, 0)),
  };
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
  return input.employees.flatMap((e): StatementCheck[] => {
    // The very payslips the Lohnausweis counts (none of a month her opening holds), so the check and the form agree on the set.
    const mine = countedCloses(e, input.closes, year);
    const opening = e.opening?.[year];
    if (!mine.length && !opening) return [];
    const la = lohnausweisOf(e, input.closes, types, data, year, e.language);
    const openingGross = parts.reduce((s, k) => s + (opening?.fields?.[k] ?? 0), 0);
    // As the form counts: each line whose Lohnart names a part of the gross field, signed as lohnausweisOf signs it.
    const linesGross = mine.reduce((s, c) => s + c.lines.reduce((a, l) => {
      const w = types.get(l.wageType);
      return w && w.side !== 'employer' && w.lohnausweis && parts.includes(w.lohnausweis) ? a + (w.sign === '-' ? -l.amount : l.amount) : a;
    }, 0), 0);
    const gross = round2(linesGross + openingGross);
    const today = la.fields[grossField.key] ?? 0;
    const unmapped = (la.unmapped ?? []).map((wageType) => ({ wageType, amount: round2(mine.reduce((s, c) => s + c.lines.filter((l) => l.wageType === wageType).reduce((a, l) => a + (types.get(wageType)?.sign === '-' ? -l.amount : l.amount), 0), 0)) }));
    // Each field is rounded to francs before the sum: up to half a franc per field that holds something is rounding, not a difference.
    const rounding = parts.filter((k) => (la.fields[k] ?? 0) !== 0).length * 0.5 + 0.005;
    const raw = round2(today - gross);
    const issued = input.issued.filter((s) => s.employee === e.id).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt)).at(-1);
    return [{
      employee: e.id, name: mine.at(-1)?.person.name ?? nameOf(e, year), gross, field: grossField.key, today,
      difference: Math.abs(raw) <= rounding ? 0 : raw, unmapped, openMonths: la.openMonths,
      ...(issued ? { issued: { id: issued.id, issuedAt: issued.issuedAt, value: issued.data.fields[grossField.key] ?? 0 } } : {}),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The person's name on 31.12. of the year (else her latest): for one with an opening and no payslip yet. */
const nameOf = (e: PayrollEmployee, year: string): string => {
  const n = valueOn(e.name, yearEnd(year)) ?? e.name.at(-1)?.value;
  return n ? `${n.first} ${n.last}` : e.id;
};

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

/**
 * The tax at source's accounts of the year: each account a settlement list of the year books on, or a tariff kind's
 * account that carried or moved; checked against the lists whatever insurances the firm entered.
 */
export function taxAtSourceChecks(input: Pick<PayrollYearEndInput, 'year' | 'books' | 'closes' | 'data' | 'store' | 'isDebitNormal' | 'moneyAccounts'>): TaxAtSourceCheck[] {
  const { year, books, data } = input;
  const kinds = Object.entries(data.insurances).filter(([, k]) => k.tariff).map(([k]) => k);
  if (!kinds.length) return [];
  const types = firmWageTypes(data, input.store);
  const lists = settlementsOf(input.closes, year, data, types, input.store);
  // The account each list books on, as bookingOf resolves it: the region's tax office, else the kind's first, else the kind's account.
  const accountOfList = (l: { month: string; region: string }) => {
    const i = lineInsuranceOf(data, input.store, kinds[0], l.region, firstDay(l.month), lastDay(l.month));
    return i ? accountOfInsurance(data, i) : data.insurances[kinds[0]]?.account;
  };
  const end = yearEnd(year);
  // The insurances that hold at some time in the year.
  const ofYear = input.store.insurances.filter((i) => i.validFrom <= end && (!i.validUntil || i.validUntil >= `${year}-01-01`));
  const accounts = new Set<string>();
  for (const k of kinds) if (data.insurances[k].account) accounts.add(data.insurances[k].account!);
  for (const i of ofYear) if (kinds.includes(i.kind)) { const a = accountOfInsurance(data, i); if (a) accounts.add(a); }
  for (const l of lists) { const a = accountOfList(l); if (a) accounts.add(a); }
  // An account another kind books on too (a tax office entered on the AHV's account): its balance is not the tax's alone,
  // so it stays the insurer's fact (decision 102) and no list is checked against it.
  const others = new Set<string>();
  for (const [k, def] of Object.entries(data.insurances)) if (!def.tariff && def.account) others.add(def.account);
  for (const i of ofYear) if (!kinds.includes(i.kind)) { const a = accountOfInsurance(data, i); if (a) others.add(a); }
  const refs = new Set(input.closes.map((c) => payslipRef(c.month, c.employee)));
  return [...accounts].filter((a) => !others.has(a)).flatMap((account): TaxAtSourceCheck[] => {
    const mine = lists.filter((l) => accountOfList(l) === account).map((l) => ({ month: l.month, region: l.region, payable: l.totals.payable }));
    const on = books.journalEntries.filter((e) => e.date >= `${year}-01-01` && e.date <= end && (e.accountDebit === account || e.accountCredit === account));
    const opening = books.config?.openingBalances?.[year]?.[account];
    const carried = opening !== undefined ? round2(input.isDebitNormal(account) ? -opening : opening)
      : creditOn({ ...books, journalEntries: books.journalEntries.filter((e) => e.date < `${year}-01-01`) }, account, year, end, input.isDebitNormal);
    if (!mine.length && !on.length && !carried) return [];
    // Paid: what moved between the account and a money account, net (a payment to the canton, less a refund from it),
    // and each other entry under no payslip's ref that takes off the account (paid by hand). One that adds to it
    // otherwise (a tax booked by hand, a refund onto an expense) is no list's: it shows as the difference.
    const debit = (e: JournalEntry) => (e.accountDebit === account ? chfAmount(e) : 0) - (e.accountCredit === account ? chfAmount(e) : 0);
    const money = (e: JournalEntry) => !!input.moneyAccounts?.has(e.accountDebit === account ? e.accountCredit : e.accountDebit);
    const paid = round2(on.filter((e) => !refs.has(e.transactionRef)).reduce((s, e) => s + (money(e) ? debit(e) : Math.max(0, debit(e))), 0));
    const payable = round2(mine.reduce((s, l) => s + l.payable, 0));
    const balance = creditOn(books, account, year, end, input.isDebitNormal);
    const expected = round2(carried + payable - paid);
    const insurances = input.store.insurances.filter((i) => kinds.includes(i.kind) && accountOfInsurance(data, i) === account).map((i) => ({ id: i.id, name: i.name }));
    return [{ account, insurances, carried, lists: mine, payable, paid, expected, balance, difference: round2(balance - expected) }];
  });
}

/** The opening of the year over every person: its last month and the gross it holds (the form's gross fields), else none. */
function openingWages(input: Pick<PayrollYearEndInput, 'year' | 'employees' | 'data'>): { through: string; gross: number } | undefined {
  const parts = (input.data.lohnausweis?.fields ?? []).find((f) => f.sum && !f.sum.minus?.length)?.sum?.plus ?? [];
  const os = input.employees.flatMap((e) => { const o = openingOf(e, input.year); return o?.through ? [o] : []; });
  if (!os.length) return undefined;
  return { through: os.map((o) => o.through!).sort().at(-1)!, gross: round2(os.reduce((s, o) => s + parts.reduce((a, k) => a + (o.fields[k] ?? 0), 0), 0)) };
}

/** Every payroll check of the year's close. */
export function payrollYearEnd(input: PayrollYearEndInput): PayrollYearEnd {
  const { year } = input;
  const hasPayslips = input.closes.some((c) => c.postingDate.startsWith(year)) || input.employees.some((e) => !!e.opening?.[year]);
  const opening = openingWages(input);
  const rows = input.wageAccount ? [...payslipWageRows(input.closes, input.data, input.store, year, input.wageAccount, input.books.journalEntries), ...(input.external ?? [])] : [];
  const clearing = hasPayslips || input.closes.some((c) => c.postingDate <= yearEnd(year)) ? clearingCheck(input) : undefined;
  const taxAtSource = taxAtSourceChecks(input);
  // An account the tax at source's check reads is not an insurer's fact too: the lists say what it owes, no final statement.
  const taxed = new Set(taxAtSource.map((x) => x.account));
  const tariffKind = (kind: string) => !!input.data.insurances[kind]?.tariff;
  const insurers = insurerChecks(input).filter((i) => i.accrued !== 0 || i.paid !== 0 || i.carried !== 0 || i.settlement.length)
    .filter((i) => !(taxed.has(i.account) && i.insurances.every((x) => tariffKind(x.kind))));
  return {
    year,
    ...(clearing && (hasPayslips || clearing.balance !== 0 || clearing.unpaid.length) ? { clearing } : {}),
    insurers, taxAtSource,
    ...(input.wageAccount && (rows.length || opening) ? { wages: wageCheck(input.books, input.wageAccount, year, rows, opening) } : {}),
    statements: statementChecks(input),
    ...(() => { const w = withheldCheck(input); return w ? { withheld: w } : {}; })(),
  };
}
