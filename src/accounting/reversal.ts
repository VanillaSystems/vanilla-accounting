/**
 * An entry's opposite (a Gegenbuchung: Soll and Haben swapped, the VAT code's sign turned) and the
 * accruals that are reversed on 1 January of the next year (treuhaender-27): the transitory
 * accounts and provisions of the year-end templates (modules/ch/year-end.yaml). Pure: Buchungen
 * opens its new-entry form with these.
 */
import type { JournalEntry } from '../types/index.js';
import { yearEndTemplates } from './year-close.js';

/** The year-end templates whose entry is undone on 1.1.: transitory assets and liabilities, and provisions. */
const ACCRUALS = ['prepaidExpense', 'accruedIncome', 'accruedExpense', 'deferredIncome', 'provision'] as const;
/** Of those, the ones reversed as a rule; a provision usually stays until it is used. */
const REVERSED = ['prepaidExpense', 'accruedIncome', 'accruedExpense', 'deferredIncome'] as const;

export type Sides = Pick<JournalEntry, 'accountDebit' | 'accountCredit'>;

/**
 * Whether an entry builds one of these templates' accruals: its account on the side the template
 * books it (1300 in Soll, 2300 in Haben). The reversal, with the account on the other side, is none.
 */
const builds = (ids: readonly string[], e: Sides) =>
  yearEndTemplates().some((t) => ids.includes(t.id) && ((!!t.accountDebit && t.accountDebit === e.accountDebit) || (!!t.accountCredit && t.accountCredit === e.accountCredit)));

/** Whether an entry books an accrual or a provision, so it may be reversed on 1.1. */
export const isAccrual = (e: Sides): boolean => builds(ACCRUALS, e);

/** Whether such an entry is reversed on 1.1. as a rule (the new-entry form ticks it then). */
export const reversedAsRule = (e: Sides): boolean => builds(REVERSED, e);

/** 1 January after the entry's date. */
export const newYearAfter = (date: string): string => `${Number(date.slice(0, 4)) + 1}-01-01`;

/** A VAT code with its sign turned: a refund's code for a charge, and back. */
export const turned = (code: string | undefined): string | undefined => code && (code.startsWith('-') ? code.slice(1) : `-${code}`);

/** A foreign-currency entry's amount is in its currency; the rate makes it the base-currency figure the books count (chfAmount). */
export type Money = Pick<JournalEntry, 'amount' | 'exchangeCurrency' | 'exchangeRate'>;

export interface Draft extends Money { date: string; accountDebit: string; accountCredit: string; vatCode?: string; description: string }

/** The amount as the entry was booked: the same figure in the same currency at the same rate, so the base-currency value (and the tax on it) is the same (r9c-1). */
export const sameMoney = (e: Money): Money => ({ amount: e.amount, ...(e.exchangeCurrency && e.exchangeRate && { exchangeCurrency: e.exchangeCurrency, exchangeRate: e.exchangeRate }) });

/** The entry booked the other way round, on `date`. */
export function reversalOf(e: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'vatCode'> & Money, date: string, description: string): Draft {
  const vatCode = turned(e.vatCode);
  return { date, accountDebit: e.accountCredit, accountCredit: e.accountDebit, ...sameMoney(e), ...(vatCode && { vatCode }), description };
}

/** The reversal of an accrual already booked: on the next 1.1., the sides swapped, the same amount. */
export function reversalIn(entries: readonly JournalEntry[], e: JournalEntry): JournalEntry | undefined {
  const date = newYearAfter(e.date);
  return entries.find((x) => x.id !== e.id && x.date === date && x.accountDebit === e.accountCredit && x.accountCredit === e.accountDebit && x.amount === e.amount);
}
