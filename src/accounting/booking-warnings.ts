/**
 * What code can say about a booking that looks wrong without refusing it (r8k-8): a cash account
 * (Kasse, 1000–1009 of the KMU chart: the chart's assets whose number starts with 100) cannot hold
 * less than nothing, and a sale is booked cash or bank / revenue, so revenue in the debit against
 * cash or bank on a positive amount is a swapped sale unless it is a refund to the customer, which
 * says so with the minus code (-V81). Browser-safe: the detail shows the warnings of a booking,
 * the API returns them with a saved booking, `npm run doctor` and the year-close checklist name
 * them for the whole year.
 */
import type { Index, JournalEntry } from '../types/index.js';
import { chart } from '../engines/index.js';
import { chfAmount } from './ledger.js';
import { fromRappen, toRappen } from './rappen.js';

export type Plausibility =
  /** The cash account's balance at the end of `date`, after `entry`, is below zero. */
  | { code: 'cashNegative'; entry: string; account: string; date: string; balance: number }
  /** Revenue debited against cash or bank on a positive amount without a minus code. */
  | { code: 'swappedSale'; entry: string; date: string; accountDebit: string; accountCredit: string };

type Books = Pick<Index, 'journalEntries'> & { config?: Pick<NonNullable<Index['config']>, 'openingBalances'> };

/** Kasse: an asset account of the 1000–1009 range (the KMU chart's cash accounts). */
export const isCashAccount = (account: string): boolean => account.startsWith('100') && chart().typeOf(account) === 'asset';

/** Flüssige Mittel: cash or a bank account (1000–1099). */
const isLiquid = (account: string): boolean => account.startsWith('10') && chart().typeOf(account) === 'asset';

const swapped = (e: JournalEntry): boolean =>
  !!e.accountDebit && !!e.accountCredit && e.amount > 0 && !e.vatCode?.startsWith('-') && chart().typeOf(e.accountDebit) === 'revenue' && isLiquid(e.accountCredit);

/** The entries of `year` in the order the balances run: by date, then as the journal holds them. */
const inOrder = (books: Books, year: string): JournalEntry[] =>
  (books.journalEntries ?? []).filter((e) => e.date.startsWith(year)).map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => a.date.localeCompare(b.date) || i - j).map(([e]) => e);

/** Each cash account's balance in Rappen after every entry of the year that touches it, in order. */
function cashRun(books: Books, year: string): Array<{ entry: JournalEntry; account: string; balance: number }> {
  const opening = books.config?.openingBalances?.[year] ?? {};
  const balances = new Map<string, number>();
  const out: Array<{ entry: JournalEntry; account: string; balance: number }> = [];
  for (const e of inOrder(books, year)) {
    const amount = toRappen(chfAmount(e));
    for (const [account, sign] of [[e.accountDebit, 1], [e.accountCredit, -1]] as const) {
      if (!account || !isCashAccount(account)) continue;
      const balance = (balances.get(account) ?? toRappen(opening[account] ?? 0)) + sign * amount;
      balances.set(account, balance);
      out.push({ entry: e, account, balance });
    }
  }
  return out;
}

/** The warnings of one booking as the books stand: a cash balance below zero at the end of its day, a swapped sale. */
export function bookingWarnings(books: Books, entry: JournalEntry): Plausibility[] {
  const out: Plausibility[] = [];
  if (swapped(entry)) out.push({ code: 'swappedSale', entry: entry.id, date: entry.date, accountDebit: entry.accountDebit, accountCredit: entry.accountCredit });
  const run = cashRun(books, entry.date.slice(0, 4));
  for (const account of [entry.accountDebit, entry.accountCredit].filter((a) => a && isCashAccount(a))) {
    const atDay = run.filter((p) => p.account === account && p.entry.date <= entry.date).at(-1);
    if (atDay && atDay.balance < 0) out.push({ code: 'cashNegative', entry: entry.id, account, date: entry.date, balance: fromRappen(atDay.balance) });
  }
  return out;
}

/** The year's implausible bookings: every swapped-looking sale, and each cash account at the entry that first takes it below zero; in date order. */
export function plausibility(books: Books, year: string): Plausibility[] {
  const out: Plausibility[] = [];
  const below = new Set<string>();
  for (const p of cashRun(books, year)) {
    if (p.balance >= 0) { below.delete(p.account); continue; }
    if (below.has(p.account)) continue;
    below.add(p.account);
    out.push({ code: 'cashNegative', entry: p.entry.id, account: p.account, date: p.entry.date, balance: fromRappen(p.balance) });
  }
  for (const e of inOrder(books, year)) if (swapped(e)) out.push({ code: 'swappedSale', entry: e.id, date: e.date, accountDebit: e.accountDebit, accountCredit: e.accountCredit });
  const order = inOrder(books, year).map((e) => e.id);
  const rank = (p: Plausibility) => order.indexOf(p.entry) * 2 + (p.code === 'swappedSale' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}
