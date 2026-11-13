/**
 * A bank account's opening balance taken from its first statement. A camt export names the bank's
 * balance before its first day (OPBD); books that start with that statement have no opening for
 * the account yet, so the check of the statement's closing balance against the books is off by
 * exactly that amount. Taken, it is the account's opening of the year (config.openingBalances,
 * keyed by year), offered only when the statement starts on 1 January: the bank's balance before a
 * later statement is not the balance of 1 January (#487). The other side is
 * retained earnings, where the import of a closed year carries the difference too, so the year opens
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
 * The year whose first day a statement's opening balance (OPBD) is the balance of: one dated
 * 31 December the next year's, one dated 1 January that year's. The balance of any other day says
 * nothing about 1 January (#487).
 */
function yearOpenedBy(date: string): string | undefined {
  if (date.endsWith('-12-31')) return addDays(date, 1).slice(0, 4);
  return date.endsWith('-01-01') ? date.slice(0, 4) : undefined;
}

/**
 * The statement's opening balance as the account's opening of the books, when it is the balance of
 * the books' first day and the books have none. The balance before a statement that starts later in
 * the year is never offered (#487): the books open on 1 January, and taking it would leave out what
 * the account moved before the statement on every balance sheet. Not for a year closed through its
 * last day, nor one an earlier year of these books opens (openingLock); not for a foreign account,
 * whose opening also needs its value in the base currency.
 */
export function openingOffer(books: Pick<Index, 'config' | 'journalEntries'>, s: StatementStart): OpeningOffer | undefined {
  const o = s.opening;
  const year = o && yearOpenedBy(o.date);
  if (!o || !year || s.currency !== baseCurrency() || toRappen(o.amount) === 0) return undefined;
  if (openingLock(books, year)) return undefined;
  const config = books.config;
  if (config?.openingBalances?.[year]?.[s.account] !== undefined || config?.openingBalancesNative?.[year]?.[s.account]) return undefined;
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

type NativeOpenings = AccountingConfig['openingBalancesNative'];

/** The native opening balances with `account` opening `year` at `value` in its currency (null: without it); an emptied year is dropped. */
export function withNativeOpening(openings: NativeOpenings, year: string, account: string, value: { amount: number; currency: string } | null): NativeOpenings {
  const balances = { ...openings?.[year] };
  if (value) balances[account] = value;
  else delete balances[account];
  const out = { ...openings };
  if (Object.keys(balances).length) out[year] = balances;
  else delete out[year];
  return Object.keys(out).length ? out : undefined;
}

type BankAccount = { bank: string; currency: string; account: string; label: string };
type StartBooks = Pick<Index, 'config' | 'transactions' | 'journalEntries' | 'statementBalances'> & Partial<Pick<Index, 'bankStatements'>>;

/** A bank account the books open at nothing while its statements say it held money (corner-25). */
export interface MissingOpening {
  account: string;
  label: string;
  year: string;
  /** The account's currency: a foreign-currency account's opening is named in it, as Firma › Eröffnung takes it (#427). */
  currency: string;
  /** The bank's balance before the year's first payment, as its statements imply it, in `currency`. */
  amount: number;
  /**
   * The day of the year's first imported payment: `amount` is the balance before it, which is the balance of
   * 1 January only when nothing moved before it; books whose statements begin in July never say 1.1. of it (#459).
   */
  from: string;
  /**
   * The first day the account's statements cover, from the statements themselves: the earliest statement's first day (#459).
   * Only when it is 1 January or before is `amount` the balance of 1.1.; absent when no statement says it.
   */
  statementsFrom?: string;
  /** Whether Firma › Eröffnung takes it: not once the year is closed through 31.12., so no link leads into a refusal. */
  canType: boolean;
}

/** The account's opening of `year` in its own currency, when one is entered: a foreign account's is its native balance. */
const openingIn = (books: Pick<Index, 'config'>, a: BankAccount, year: string): number | undefined =>
  a.currency === baseCurrency() ? books.config?.openingBalances?.[year]?.[a.account] : books.config?.openingBalancesNative?.[year]?.[a.account]?.amount;

/**
 * What the statements say about the start of the year: the day of the year's first imported payment
 * and the bank's balance before it (in hundredths), the first closing balance of the year less the payments up to it.
 */
function bankStart(books: StartBooks, a: BankAccount, year: string): { from: string; held: number } | undefined {
  const first = (books.statementBalances ?? []).filter((b) => b.account === a.account && b.date.startsWith(year)).sort((x, y) => x.date.localeCompare(y.date))[0];
  if (!first) return undefined;
  const paid = books.transactions.filter((t) => t.bank === a.bank && t.currency === a.currency && t.date >= `${year}-01-01` && t.date <= first.date);
  const moved = paid.reduce((sum, t) => sum + (t.direction === 'DBIT' ? -1 : 1) * toRappen(Math.abs(t.amount)), 0);
  return { from: paid.map((t) => t.date).sort()[0] ?? first.date, held: toRappen(first.amount) - moved };
}

/** The first day the account's statements cover (#459): the earliest statement's first day (a bank export's is the day after its opening balance, src/books/bank-import.ts). */
function statementsFrom(books: StartBooks, a: BankAccount): string | undefined {
  return (books.bankStatements ?? []).filter((s) => s.bank === a.bank && (!s.currency || s.currency === a.currency)).map((s) => s.fromDate).filter(Boolean).sort()[0];
}

/**
 * The first year's bank accounts without an opening balance whose statements disagree: the
 * first closing balance of the year less the payments up to it is what the account held on
 * 1 January. Without that opening the Bilanz shows the account wrong (often below zero). A
 * foreign-currency account's in its currency; a later year opens from the year before.
 */
export function missingOpenings(books: StartBooks, accounts: ReadonlyArray<BankAccount>, year: string): MissingOpening[] {
  const lock = openingLock({ config: books.config, journalEntries: books.journalEntries }, year);
  if (lock === 'notFirstYear') return [];
  return accounts.flatMap((a): MissingOpening[] => {
    if (openingIn(books, a, year) !== undefined) return [];
    const start = bankStart(books, a, year);
    if (!start || start.held === 0) return [];
    const covered = statementsFrom(books, a);
    return [{ account: a.account, label: a.label, year, currency: a.currency, amount: fromRappen(start.held), from: start.from, ...(covered ? { statementsFrom: covered } : {}), canType: !lock }];
  });
}

/**
 * A bank account whose opening is entered but whose books, before the year's first imported payment,
 * hold another balance than the bank did then (r2-28): books that start in July with the opening of
 * the balance sheet of 31 December lack what the bank moved from January to June.
 */
export interface StartGap {
  account: string;
  label: string;
  year: string;
  currency: string;
  /** The day of the year's first imported payment. */
  from: string;
  /** The bank's balance before it, as the statements imply it. */
  bank: number;
  /** The books' balance before it: the opening and what is booked on the account before that day. */
  books: number;
  /** Books less bank, the sign of a statement's difference. */
  diff: number;
  canType: boolean;
}

export function startGaps(books: StartBooks, accounts: ReadonlyArray<BankAccount>, year: string): StartGap[] {
  const lock = openingLock({ config: books.config, journalEntries: books.journalEntries }, year);
  if (lock === 'notFirstYear') return [];
  return accounts.flatMap((a): StartGap[] => {
    const opening = openingIn(books, a, year);
    const start = opening === undefined ? undefined : bankStart(books, a, year);
    if (opening === undefined || !start) return [];
    const before = (books.journalEntries ?? []).filter((e) => e.date >= `${year}-01-01` && e.date < start.from && e.origin !== 'year-close')
      .reduce((sum, e) => sum + (e.accountDebit === a.account ? toRappen(e.amount) : 0) - (e.accountCredit === a.account ? toRappen(e.amount) : 0), toRappen(opening));
    const diff = before - start.held;
    return diff === 0 ? [] : [{ account: a.account, label: a.label, year, currency: a.currency, from: start.from, bank: fromRappen(start.held), books: fromRappen(before), diff: fromRappen(diff), canType: !lock }];
  });
}

/**
 * How far the books are off a bank account's closing balance (`diff`, books less bank), split into
 * the missing opening balance, or the gap before the year's first payment (`before`), and the rest,
 * which a payment not or wrongly booked explains (r4c-33, r2-28).
 */
export function bookDiffParts(diff: number, missing: MissingOpening | undefined, gap?: StartGap): { opening?: MissingOpening; before?: StartGap; rest: number } {
  if (missing) return { opening: missing, rest: fromRappen(toRappen(diff) + toRappen(missing.amount)) };
  if (gap) return { before: gap, rest: fromRappen(toRappen(diff) - toRappen(gap.diff)) };
  return { rest: diff };
}
