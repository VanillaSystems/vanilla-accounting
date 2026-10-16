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
 * none and nothing on the account came before the statement. Not for a year with a closed
 * period, nor one an earlier year of these books opens; not for a foreign account, whose opening
 * also needs its value in the base currency.
 */
export function openingOffer(books: Pick<Index, 'config' | 'transactions' | 'journalEntries'>, s: StatementStart): OpeningOffer | undefined {
  const o = s.opening;
  if (!o || s.currency !== baseCurrency() || toRappen(o.amount) === 0) return undefined;
  const year = addDays(o.date, 1).slice(0, 4);
  const config = books.config;
  if (config?.closedThrough && config.closedThrough >= `${year}-01-01`) return undefined;
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
 * Why `year`'s opening balances cannot be typed by hand: a closed period in it (its openings stay
 * as filed), or it is not the first year of these books (an earlier year's close opens it).
 */
export type OpeningLock = 'closed' | 'notFirstYear';

export function openingLock(books: Pick<Index, 'config' | 'journalEntries'>, year: string): OpeningLock | undefined {
  const config = books.config;
  if (config?.closedThrough && config.closedThrough >= `${year}-01-01`) return 'closed';
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
