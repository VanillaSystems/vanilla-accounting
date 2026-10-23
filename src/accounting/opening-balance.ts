/**
 * A bank account's opening balance taken from its first statement. A camt export names the bank's
 * balance before its first day (OPBD); books that start with that statement have no opening for
 * the account yet, so the check of the statement's closing balance against the books is off by
 * exactly that amount. Taken, it is the account's opening of the year (config.openingBalances,
 * keyed by year): nothing moved on the account before the statement in these books, so the
 * balance on 1 January of them is the bank's balance before the statement. The other side is
 * retained earnings, where npm run import-opening carries the difference too, so the year opens
 * balanced. Pure: the statement route writes it, the runs table offers it.
 */
import type { AccountingConfig, Index } from '../types/index.js';
import { addDays, type IsoDate } from './periods.js';
import { fromRappen, toRappen } from './rappen.js';
import { baseCurrency } from '../engines/index.js';

export interface OpeningOffer {
  account: string;
  year: string;
  /** The day the bank's balance is for. */
  date: IsoDate;
  amount: number;
}

/** What an imported statement says about its account: its first day and the bank's balance before it. */
export interface StatementStart {
  account: string;
  bank: string;
  currency: string;
  from?: string;
  opening?: { date: string; amount: number };
}

/**
 * The statement's opening balance as the account's opening of the books, when the books have
 * none and nothing on the account came before the statement. Not for a year closed through its
 * last day, nor one an earlier year of these books opens; not for a foreign account, whose opening
 * also needs its value in the base currency.
 */
export function openingOffer(books: Pick<Index, 'config' | 'transactions' | 'journalEntries'>, s: StatementStart): OpeningOffer | undefined {
  const o = s.opening;
  if (!o || s.currency !== baseCurrency() || toRappen(o.amount) === 0) return undefined;
  const year = addDays(o.date, 1).slice(0, 4);
  const config = books.config;
  if (config?.closedThrough && config.closedThrough >= `${year}-12-31`) return undefined;
  if (Object.keys(config?.openingBalances ?? {}).some((y) => y < year)) return undefined;
  if (config?.openingBalances?.[year]?.[s.account] !== undefined || config?.openingBalancesNative?.[year]?.[s.account]) return undefined;
  const first = [s.from, addDays(o.date, 1)].filter((d): d is string => !!d).sort()[0];
  const before = (d: string | undefined) => !!d && d >= `${year}-01-01` && d < first;
  if (books.transactions.some((t) => t.bank === s.bank && t.currency === s.currency && before(t.date))) return undefined;
  if ((books.journalEntries ?? []).some((e) => before(e.date) && (e.accountDebit === s.account || e.accountCredit === s.account))) return undefined;
  return { account: s.account, year, date: o.date, amount: o.amount };
}

type Openings = AccountingConfig['openingBalances'];

/**
 * Why `year`'s opening balances cannot be typed by hand: the year is closed through its last day
 * (its balance sheet is final, the next year opens from it), or it is not the first year of these
 * books (an earlier year's close opens it). A filed quarter does not lock them (r5h-30): an opening
 * balance is balance-sheet only, in no VAT return, and no seal covers it (src/books/seal.ts hashes
 * entries, payments and links), so typing it changes nothing that was filed.
 */
export type OpeningLock = 'closed' | 'notFirstYear';

export function openingLock(books: Pick<Index, 'config' | 'journalEntries'>, year: string): OpeningLock | undefined {
  const config = books.config;
  if (config?.closedThrough && config.closedThrough >= `${year}-12-31`) return 'closed';
  const earlier = Object.keys(config?.openingBalances ?? {}).some((y) => y < year) || (books.journalEntries ?? []).some((e) => e.date < `${year}-01-01`);
  return earlier ? 'notFirstYear' : undefined;
}

/**
 * The opening balances with `account` opening `year` at `amount` (null: without it), the
 * difference carried to `equity` so the year stays balanced: an asset's on the same side, a
 * liability's (`liability`) against it. A year left empty is dropped, so taking an opening back
 * leaves the books as they were.
 */
export function withOpening(openings: Openings, year: string, account: string, amount: number | null, equity: string, liability = false): Openings {
  const balances = { ...openings?.[year] };
  const delta = toRappen(amount ?? 0) - toRappen(balances[account] ?? 0);
  if (amount === null) delete balances[account];
  else balances[account] = amount;
  const plug = toRappen(balances[equity] ?? 0) + (liability ? -delta : delta);
  if (plug === 0) delete balances[equity];
  else balances[equity] = fromRappen(plug);
  const out = { ...openings };
  if (Object.keys(balances).length) out[year] = balances;
  else delete out[year];
  return Object.keys(out).length ? out : undefined;
}

/** A bank account the books open at nothing while its statements say it held money (corner-25). */
export interface MissingOpening {
  account: string;
  label: string;
  year: string;
  /** The bank's balance before the year's first payment, as its statements imply it. */
  amount: number;
  /** Whether Firma › Eröffnung takes it: not once the year is closed through 31.12., so no link leads into a refusal. */
  canType: boolean;
}

/**
 * The first year's bank accounts without an opening balance whose statements disagree: the
 * first closing balance of the year less the payments up to it is what the account held on
 * 1 January. Without that opening the Bilanz shows the account wrong (often below zero). Base
 * currency accounts only, as the opening form takes them; a later year opens from the year before.
 */
export function missingOpenings(
  books: Pick<Index, 'config' | 'transactions' | 'journalEntries' | 'statementBalances'>,
  accounts: ReadonlyArray<{ bank: string; currency: string; account: string; label: string }>,
  year: string,
): MissingOpening[] {
  const lock = openingLock({ config: books.config, journalEntries: books.journalEntries }, year);
  if (lock === 'notFirstYear') return [];
  return accounts.flatMap((a): MissingOpening[] => {
    if (a.currency !== baseCurrency() || books.config?.openingBalances?.[year]?.[a.account] !== undefined) return [];
    const first = (books.statementBalances ?? []).filter((b) => b.account === a.account && b.date.startsWith(year)).sort((x, y) => x.date.localeCompare(y.date))[0];
    if (!first) return [];
    const moved = books.transactions.filter((t) => t.bank === a.bank && t.currency === a.currency && t.date >= `${year}-01-01` && t.date <= first.date)
      .reduce((sum, t) => sum + (t.direction === 'DBIT' ? -1 : 1) * toRappen(Math.abs(t.amount)), 0);
    const held = toRappen(first.amount) - moved;
    return held === 0 ? [] : [{ account: a.account, label: a.label, year, amount: fromRappen(held), canType: !lock }];
  });
}

/**
 * How far the books are off a bank account's closing balance (`diff`, books less bank), split into
 * the missing opening balance and the rest, which a payment not or wrongly booked explains (r4c-33).
 */
export function bookDiffParts(diff: number, missing: MissingOpening | undefined): { opening?: MissingOpening; rest: number } {
  if (!missing) return { rest: diff };
  return { opening: missing, rest: fromRappen(toRappen(diff) + toRappen(missing.amount)) };
}
