/**
 * The Sozialversicherungen through the year (docs/specs/payroll.md §6.4): each insurance's liability
 * account holds what the closed payslips accrued less what was paid. A payment to the fund or insurer
 * (an Akonto, a final bill) is booked against that account only, by code, since the payslips expensed
 * the contributions already: never twice. The final statement's difference to what the payslips accrued
 * is booked on the employer's contribution account against the liability, from the total the person
 * enters off the statement. Pure, browser-safe.
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { PeriodLock } from '../books/store.js';
import type { PayrollData } from '../core/modules/schema.js';
import { firmWageTypes } from './catalogue.js';
import type { PayrollInsurance, PayrollStore } from './model.js';
import { monthsBetween, round2 } from './money.js';
import { PayrollRefusal } from './close.js';
import { inOpening, openingOf } from './opening.js';

const isPayroll = (e: JournalEntry) => e.by?.kind === 'code' && e.by.check === 'payroll';
const fold = (s: string | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The liability account of a firm's insurance. */
export const accountOfInsurance = (data: PayrollData, i: Pick<PayrollInsurance, 'kind' | 'account'>): string | undefined => i.account ?? data.insurances[i.kind]?.account;

/** The firm's insurance a payment goes to: by its business file, else by the insurer's name as the bank writes it. */
export function insuranceOfPayment(tx: BankTransaction, store: Pick<PayrollStore, 'insurances'>, businessOf: (tx: BankTransaction) => string | undefined): PayrollInsurance | undefined {
  const business = businessOf(tx);
  const payee = fold(tx.counterparty);
  return store.insurances.find((i) => (!!business && i.business === business) || (!!payee && !!i.name && payee === fold(i.name)));
}

/** An entry that expenses a contribution: a payslip's (LR-) or a final statement's difference (LS-). */
const accrues = (e: JournalEntry) => isPayroll(e) && (e.transactionRef.startsWith('LR-') || e.transactionRef.startsWith('LS-'));

/**
 * Books the open, unbooked payments to the firm's insurers against their liability accounts, but only on an
 * account the closed payslips accrue onto by the payment's month, or from the first month payroll runs here
 * (`since`, payrollSince): a firm whose payroll is done elsewhere keeps the booking it has (level A,
 * src/booking/withheld.ts). Returns the refs booked.
 */
export function bookInsurerPayments(
  books: { transactions: BankTransaction[]; journalEntries: JournalEntry[] },
  data: PayrollData, store: Pick<PayrollStore, 'insurances'>, lock: Pick<PeriodLock, 'isClosed'>,
  businessOf: (tx: BankTransaction) => string | undefined, bankAccountOf: (tx: BankTransaction) => string | undefined, newId: () => string,
  opts: { currency: string; ruled?: (tx: BankTransaction) => boolean; since?: (year: string) => string | undefined },
): string[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  // The payslips accrue onto the account by the payment's month: it pays what they accrued or accrue (an Akonto
  // of a month whose payslips post at its end, a January payment of last year's), or it falls on or after the
  // first month payroll runs here (`since`), whose payslips are still to close. One before pays what level A booked.
  const onAccount = (account: string) => books.journalEntries.filter((e) => accrues(e) && e.accountCredit === account);
  const accruing = (account: string, day: string) => {
    const on = onAccount(account);
    if (on.some((e) => e.date.slice(0, 7) <= day.slice(0, 7))) return true;
    // Payroll runs here once a payslip accrued onto the account: from its first month on, a payment is the liability's.
    const since = on.length ? opts.since?.(day.slice(0, 4)) : undefined;
    return !!since && day >= since;
  };
  const out: string[] = [];
  for (const tx of books.transactions) {
    // Only payments out: what an insurer pays in is mostly a benefit (a daily allowance, family allowances), never a contribution's refund by default.
    if (tx.direction !== 'DBIT' || tx.currency !== opts.currency || booked.has(tx.ref) || lock.isClosed(tx.date) || tx.amount === 0 || opts.ruled?.(tx)) continue;
    const ins = insuranceOfPayment(tx, store, businessOf);
    const account = ins && accountOfInsurance(data, ins);
    if (!ins || !account || !accruing(account, tx.date)) continue;
    const bank = bankAccountOf(tx);
    if (!bank) continue;
    const amount = round2(Math.abs(tx.amount));
    const out_ = tx.direction === 'DBIT';
    books.journalEntries.push({
      id: newId(), transactionRef: tx.ref, date: tx.date,
      accountDebit: out_ ? account : bank, accountCredit: out_ ? bank : account, amount,
      description: `${out_ ? 'Zahlung' : 'Rückzahlung'} ${ins.name}`, by: { kind: 'code', check: 'payroll' },
    });
    out.push(tx.ref);
  }
  return out;
}

export interface InsurerRow {
  id: string; kind: string; name: string; account: string;
  /** Credited by the closed payslips in the year. */
  accrued: number;
  /** Paid to the insurer (or settled) in the year. */
  paid: number;
  /** The account's balance at the year's end (or today): what the insurer is still owed; negative: paid ahead. */
  open: number;
}


/** Per insurance of the firm: accrued by payslips (and final statements), paid, open, as facts from the books. */
export function insurerRows(books: { journalEntries: readonly JournalEntry[] }, data: PayrollData, store: Pick<PayrollStore, 'insurances'>, year: string): InsurerRow[] {
  return store.insurances.flatMap((i) => {
    const account = accountOfInsurance(data, i);
    if (!account) return [];
    // A final statement belongs to the year it settles (its ref), whenever it is dated; every other entry to its own year.
    const ofYear = (e: JournalEntry) => (e.transactionRef.startsWith('LS-') ? e.transactionRef.startsWith(`LS-${year}-`) : e.date.startsWith(year));
    const on = books.journalEntries.filter((e) => ofYear(e) && (e.accountCredit === account || e.accountDebit === account));
    const net = (es: JournalEntry[]) => round2(es.reduce((s, e) => s + (e.accountCredit === account ? e.amount : 0) - (e.accountDebit === account ? e.amount : 0), 0));
    const accrued = net(on.filter(accrues));
    const paid = round2(-net(on.filter((e) => !accrues(e))));
    return [{ id: i.id, kind: i.kind, name: i.name, account, accrued, paid, open: round2(accrued - paid) }];
  });
}

/**
 * The first day payroll runs here: the first month of any person that is no month of her opening, among the
 * months she is employed in, from `year` on; undefined while nobody has one (src/payroll/opening.ts).
 */
export function payrollSince(store: Pick<PayrollStore, 'employees'>, year: string): string | undefined {
  const firsts = store.employees.flatMap((e) => {
    const sorted = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const entry = sorted[0]?.validFrom;
    if (!entry) return [];
    for (const m of monthsBetween(`${year}-01`, `${year}-12`)) {
      if (`${m}-31` < entry || sorted.every((x) => x.validUntil !== undefined && x.validUntil < `${m}-01`)) continue;
      if (!inOpening(e, m)) return [`${m}-01` > entry ? `${m}-01` : entry];
    }
    return [];
  });
  return firsts.sort()[0];
}

/** What a final statement is compared with (§22 decision 44): the year's contributions as the books hold them. */
export interface SettlementCompare {
  /** Credited on the liability account by the payslips (and an earlier final statement) of the year. */
  accrued: number;
  /** Booked otherwise for the year: the payments to the insurer of the year not booked on its liability account (level A, the opening's months). */
  before: number;
  /** accrued + before: the year's contributions in the books. */
  books: number;
  total: number;
  /** total − books: what the entry books. */
  difference: number;
  /** Over the share of the year that is said before booking (5 %): «Trotzdem buchen». */
  large: boolean;
  /** The months of an opening of the year (its last), when a person has one: the comparison must hold them. */
  openingThrough?: string;
}

/** A difference larger than this share of the year's contributions is said in the page before it is booked. */
export const SETTLEMENT_WARN_SHARE = 0.05;

/**
 * The entry that books a final statement's difference (§6.4): the statement's total for the year less the
 * year's contributions in the books (what the payslips accrued, and what was booked for the months before
 * payroll ran here: the payments to the insurer not booked on its liability account), on the employer's
 * contribution account of the insurance's kind against its liability account; no entry when they agree.
 * `total`: what the statement says the year's contributions are. `businessOf`: the business a payment goes to.
 */
export function settlementOf(
  books: { journalEntries: readonly JournalEntry[]; transactions?: readonly BankTransaction[] }, data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'wageTypes' | 'employees'>,
  insuranceId: string, year: string, total: number, date: string, newId: () => string, businessOf: (tx: BankTransaction) => string | undefined = () => undefined,
): { entry?: JournalEntry; compare: SettlementCompare } {
  const ins = store.insurances.find((i) => i.id === insuranceId);
  const account = ins && accountOfInsurance(data, ins);
  if (!ins || !account) throw new PayrollRefusal('unknownInsurance', `Keine Sozialversicherung ${insuranceId}.`);
  if (!(total >= 0) || date < `${year}-01-01`) throw new PayrollRefusal('badInput', 'Das Total ist null oder mehr, und die Schlussabrechnung ist im Jahr oder danach datiert.');
  const row = insurerRows(books, data, { insurances: [ins] }, year)[0];
  if (!books.journalEntries.some((e) => e.transactionRef.startsWith(`LR-${year}-`) && (e.accountCredit === account || e.accountDebit === account))) {
    throw new PayrollRefusal('nothingAccrued', `Keine Lohnabrechnung ${year} hat auf ${account} gebucht.`);
  }
  const expense = [...firmWageTypes(data, store).values()].find((w) => w.stage === 'employer' && typeof w.credit === 'object' && w.credit.insurance === ins.kind && typeof w.debit === 'string')?.debit as string | undefined;
  if (!expense) throw new PayrollRefusal('noExpenseAccount', `Keine Arbeitgeber-Lohnart bucht auf ${account}.`);
  // The year's payments to this insurer that its liability account does not carry: level A's bookings (of the months before payroll ran here).
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) byRef.set(e.transactionRef, [...(byRef.get(e.transactionRef) ?? []), e]);
  const before = round2((books.transactions ?? []).filter((tx) => tx.date.startsWith(year) && tx.amount !== 0 && insuranceOfPayment(tx, { insurances: [ins] }, businessOf))
    .filter((tx) => { const es = byRef.get(tx.ref) ?? []; return es.length > 0 && !es.some((e) => e.accountDebit === account || e.accountCredit === account); })
    .reduce((s, tx) => s + (tx.direction === 'DBIT' ? 1 : -1) * Math.abs(tx.amount), 0));
  const inBooks = round2(row.accrued + before);
  const difference = round2(total - inBooks);
  const openingThrough = store.employees.flatMap((e) => openingOf(e, year)?.through ?? []).sort().at(-1);
  const compare: SettlementCompare = {
    accrued: row.accrued, before, books: inBooks, total, difference,
    large: Math.abs(difference) > SETTLEMENT_WARN_SHARE * Math.max(total, inBooks), ...(openingThrough ? { openingThrough } : {}),
  };
  if (difference === 0) return { compare };
  return {
    compare,
    entry: {
      id: newId(), transactionRef: `LS-${year}-${ins.id}`, date,
      accountDebit: difference > 0 ? expense : account, accountCredit: difference > 0 ? account : expense, amount: Math.abs(difference),
      description: `Schlussabrechnung ${year} ${ins.name}: Differenz zu den Beiträgen des Jahres in den Büchern`, by: { kind: 'code', check: 'payroll' },
    },
  };
}
