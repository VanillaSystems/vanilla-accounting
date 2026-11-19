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
import { round2 } from './money.js';
import { PayrollRefusal } from './close.js';

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
 * Books the open, unbooked payments to (and refunds from) the firm's insurers against their liability
 * accounts, but only on an account the closed payslips accrued onto this year: a firm whose payroll is
 * done elsewhere keeps the booking it has (level A, src/booking/withheld.ts). Returns the refs booked.
 */
export function bookInsurerPayments(
  books: { transactions: BankTransaction[]; journalEntries: JournalEntry[] },
  data: PayrollData, store: Pick<PayrollStore, 'insurances'>, lock: Pick<PeriodLock, 'isClosed'>,
  businessOf: (tx: BankTransaction) => string | undefined, bankAccountOf: (tx: BankTransaction) => string | undefined, newId: () => string,
  opts: { currency: string; ruled?: (tx: BankTransaction) => boolean },
): string[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  // The payslips accrued onto the account before this payment: it pays what they accrued (an Akonto after the
  // first closed month, a January payment of last year's). One before payroll ran here pays what level A booked.
  const accruedBefore = (account: string, day: string) => books.journalEntries.some((e) => accrues(e) && e.accountCredit === account && e.date < day);
  const out: string[] = [];
  for (const tx of books.transactions) {
    // Only payments out: what an insurer pays in is mostly a benefit (a daily allowance, family allowances), never a contribution's refund by default.
    if (tx.direction !== 'DBIT' || tx.currency !== opts.currency || booked.has(tx.ref) || lock.isClosed(tx.date) || tx.amount === 0 || opts.ruled?.(tx)) continue;
    const ins = insuranceOfPayment(tx, store, businessOf);
    const account = ins && accountOfInsurance(data, ins);
    if (!ins || !account || !accruedBefore(account, tx.date)) continue;
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
 * The entry that books a final statement's difference (§6.4): the statement's total for the year less what
 * the payslips accrued, on the employer's contribution account of the insurance's kind against its
 * liability account; undefined when they agree. `total`: what the statement says the year's contributions are.
 */
export function settlementEntry(books: { journalEntries: readonly JournalEntry[] }, data: PayrollData, store: Pick<PayrollStore, 'insurances' | 'wageTypes'>, insuranceId: string, year: string, total: number, date: string, newId: () => string): JournalEntry | undefined {
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
  const diff = round2(total - row.accrued);
  if (diff === 0) return undefined;
  return {
    id: newId(), transactionRef: `LS-${year}-${ins.id}`, date,
    accountDebit: diff > 0 ? expense : account, accountCredit: diff > 0 ? account : expense, amount: Math.abs(diff),
    description: `Schlussabrechnung ${year} ${ins.name}: Differenz zu den Lohnabrechnungen`, by: { kind: 'code', check: 'payroll' },
  };
}
