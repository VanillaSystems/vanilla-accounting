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
import type { PayrollWay } from '../knowledge/payroll-way.js';

const isPayroll = (e: JournalEntry) => e.by?.kind === 'code' && e.by.check === 'payroll';
const fold = (s: string | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The liability account of a firm's insurance. */
export const accountOfInsurance = (data: PayrollData, i: Pick<PayrollInsurance, 'kind' | 'account'>): string | undefined => i.account ?? data.insurances[i.kind]?.account;

/** The firm's insurances a payment goes to: by its business file, else by the insurer's name as the bank writes it. Several when they share a payee (two insurances at one fund). */
export function insurancesOfPayment(tx: BankTransaction, store: Pick<PayrollStore, 'insurances'>, businessOf: (tx: BankTransaction) => string | undefined): PayrollInsurance[] {
  const business = businessOf(tx);
  const payee = fold(tx.counterparty);
  return store.insurances.filter((i) => (!!business && i.business === business) || (!!payee && !!i.name && payee === fold(i.name)));
}

/** The firm's insurance a payment goes to, the first when several share the payee. */
export const insuranceOfPayment = (tx: BankTransaction, store: Pick<PayrollStore, 'insurances'>, businessOf: (tx: BankTransaction) => string | undefined): PayrollInsurance | undefined =>
  insurancesOfPayment(tx, store, businessOf)[0];

/** An entry that expenses a contribution: a payslip's (LR-) or a final statement's difference (LS-). */
const accrues = (e: JournalEntry) => isPayroll(e) && (e.transactionRef.startsWith('LR-') || e.transactionRef.startsWith('LS-'));

const monthEnd = (day: string) => {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7));
  return `${day.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** A payment to one of the firm's payroll insurers while payroll runs here (§22 decision 45). */
export interface InsurerPayment {
  insurance: PayrollInsurance;
  account: string;
  /** The payee pays several of the firm's insurances (two insurances at one fund): no one account takes it by itself. */
  shared: boolean;
  /**
   * What the account holds at the end of the payment's month (the payslips' accruals through that month, less what was
   * paid before) covers the payment: code books it against the liability. Otherwise it waits for the person (never the
   * model): it may pay months before payroll ran here, which level A books.
   */
  covered: boolean;
  /** The company's kept way with this fund's uncovered payments (its business file's `payroll.payments`, «Immer so»): the liability. */
  kept?: PayrollWay;
  /** Code books it against the liability at once: covered, or not covered and the company keeps that way (not for a shared payee). */
  books: boolean;
  /** The business file the way is kept in, or would be: the insurance's own, else the one the payment routes to. */
  business?: string;
}

/** The company's kept way of a business file (src/knowledge/payroll-way.ts), by the business's id. */
export type PayrollWayOf = (business: string) => PayrollWay | undefined;

/**
 * The one decision of §22 decision 45, for the classifier, receipt-wait and the hand form alike: whether `tx` pays one of
 * the firm's payroll insurers while payroll runs here, and whether the liability covers it. Payroll runs here for the
 * account once a payslip accrued on it, or in a year a person has an opening from payroll's first month after it
 * (payrollSince); a firm with persons but no payroll here keeps level A's way. Payments out only, in the books' currency.
 */
export function insurerPaymentOf(
  tx: BankTransaction, entries: readonly JournalEntry[], data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'employees'>,
  businessOf: (tx: BankTransaction) => string | undefined, currency: string, wayOf: PayrollWayOf = () => undefined,
): InsurerPayment | undefined {
  if (tx.direction !== 'DBIT' || tx.currency !== currency || tx.amount === 0) return undefined;
  const all = insurancesOfPayment(tx, store, businessOf);
  const ins = all[0];
  const account = ins && accountOfInsurance(data, ins);
  if (!ins || !account) return undefined;
  const on = entries.filter((e) => e.transactionRef !== tx.ref && (e.accountCredit === account || e.accountDebit === account));
  const accrued = on.some((e) => accrues(e) && e.accountCredit === account && e.date <= monthEnd(tx.date));
  const year = tx.date.slice(0, 4);
  const since = store.employees.some((e) => openingOf(e, year)) ? payrollSince(store, year) : undefined;
  if (!accrued && !(since && since <= tx.date)) return undefined;
  const end = monthEnd(tx.date);
  const held = round2(on.filter((e) => (accrues(e) ? e.date <= end : e.date <= tx.date))
    .reduce((s, e) => s + (e.accountCredit === account ? e.amount : 0) - (e.accountDebit === account ? e.amount : 0), 0));
  const shared = all.length > 1;
  const covered = !shared && held + 0.005 >= Math.abs(tx.amount);
  // «Immer so» (§22 decision 126): the insurance's business file, else the one the payment routes to, keeps the way.
  const routed = businessOf(tx);
  const business = [ins.business, routed].find((b) => !!b && wayOf(b)) ?? ins.business ?? routed;
  const kept = business ? wayOf(business) : undefined;
  return { insurance: ins, account, shared, covered, ...(kept ? { kept } : {}), books: covered || (!shared && kept === 'liability'), ...(business ? { business } : {}) };
}

/**
 * Books the open, unbooked payments to the firm's insurers against their liability accounts, by code, when the
 * liability covers them or the company keeps that way for the fund (insurerPaymentOf `books`; `only`: these payments): a firm whose payroll is done elsewhere keeps the booking it has (level A,
 * src/booking/withheld.ts); one the liability does not cover waits for the person. Returns the refs booked.
 */
export function bookInsurerPayments(
  books: { transactions: BankTransaction[]; journalEntries: JournalEntry[] },
  data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'employees'>, lock: Pick<PeriodLock, 'isClosed'>,
  businessOf: (tx: BankTransaction) => string | undefined, bankAccountOf: (tx: BankTransaction) => string | undefined, newId: () => string,
  opts: { currency: string; ruled?: (tx: BankTransaction) => boolean; wayOf?: PayrollWayOf; only?: (tx: BankTransaction) => boolean; keep?: boolean },
): string[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const out: string[] = [];
  for (const tx of [...books.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    // Only payments out: what an insurer pays in is mostly a benefit (a daily allowance, family allowances), never a contribution's refund by default.
    if (booked.has(tx.ref) || lock.isClosed(tx.date) || opts.ruled?.(tx) || (opts.only && !opts.only(tx))) continue;
    const pay = insurerPaymentOf(tx, books.journalEntries, data, store, businessOf, opts.currency, opts.wayOf);
    // `keep`: the way being kept right now («Immer so»), whose file is not written yet: the liability for every payment of `only`.
    if (!pay || !(pay.books || (opts.keep && !pay.shared))) continue;
    const bank = bankAccountOf(tx);
    if (!bank) continue;
    books.journalEntries.push({
      id: newId(), transactionRef: tx.ref, date: tx.date,
      accountDebit: pay.account, accountCredit: bank, amount: round2(Math.abs(tx.amount)),
      description: `Zahlung ${pay.insurance.name}`, by: { kind: 'code', check: 'payroll' },
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

const dayBefore = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

/** What a final statement is compared with (§22 decision 44): the year's contributions as the books hold them. */
export interface SettlementCompare {
  /** Credited on the liability account by the payslips (and an earlier final statement) of the year. */
  accrued: number;
  /**
   * Paid for the opening's months: the payments out to this insurer alone, in the books' currency, dated from 1 February
   * to the day before payroll's start (`beforeUntil`; a January payment settles the year before), not booked on its
   * liability account (level A). Zero without an opening.
   */
  before: number;
  /** The last day a payment counts in `before`. */
  beforeUntil?: string;
  /** Payees that take several of the firm's insurances (two insurances at one fund): their payments are not split, so none counts. */
  sharedPayees?: string[];
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
  currency?: string,
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
  const since = store.employees.some((e) => openingOf(e, year)) ? payrollSince(store, year) : undefined;
  const until = since ? dayBefore(since) : undefined;
  const mine = (books.transactions ?? []).filter((tx) => !!until && tx.direction === 'DBIT' && (!currency || tx.currency === currency) && tx.amount !== 0
    && tx.date >= `${year}-02-01` && tx.date <= until && insurancesOfPayment(tx, store, businessOf).some((i) => i.id === ins.id))
    .filter((tx) => { const es = byRef.get(tx.ref) ?? []; return es.length > 0 && !es.some((e) => e.accountDebit === account || e.accountCredit === account); });
  const shared = mine.filter((tx) => insurancesOfPayment(tx, store, businessOf).length > 1);
  const before = round2(mine.filter((tx) => !shared.includes(tx)).reduce((s, tx) => s + Math.abs(tx.amount), 0));
  const sharedPayees = [...new Set(shared.map((tx) => tx.counterparty ?? ''))].filter(Boolean);
  const inBooks = round2(row.accrued + before);
  const difference = round2(total - inBooks);
  const openingThrough = store.employees.flatMap((e) => openingOf(e, year)?.through || []).sort().at(-1);
  const compare: SettlementCompare = {
    accrued: row.accrued, before, ...(until ? { beforeUntil: until } : {}), ...(sharedPayees.length ? { sharedPayees } : {}), books: inBooks, total, difference,
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
