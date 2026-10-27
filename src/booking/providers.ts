/**
 * Payment providers (#203): a shop platform or a card terminal collects the firm's sales and pays
 * them out less its fees. A payout is a settlement, not a sale: each sale raises what the provider
 * holds for the firm (its clearing account, `provider.clearing` in the company's file of it), the
 * payout moves money from there to the bank. So the payout is booked bank / clearing account without
 * VAT, in code; the sales come onto the clearing account from the provider's sales report, each with
 * its own code (src/booking/sales-report.ts); the fees from its fee report. A payout needs no receipt
 * and is never matched to one: its order documents are proof of the sales, not of the payout.
 *
 * Which business is a provider is said in its file (`provider:`, src/knowledge/provider.ts), never by
 * a name in code (ADR 0015). Pure.
 */
import { identify, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { addDays } from '../accounting/periods.js';

/** A business whose file makes it a payment provider. */
export type Provider = Counterparty & { provider: NonNullable<Counterparty['provider']> };

export const isProvider = (c: Counterparty): c is Provider => !!c.provider;

/** The days a provider pays a sale out within when its file does not say. */
export const PAYOUT_DAYS = 7;

/**
 * The provider whose payout `tx` is: money in that routes to a business with a `provider:` section.
 * Money out to the same business (its subscription, a bill) is a purchase like any other.
 */
export function providerOfPayment(tx: Pick<BankTransaction, 'direction' | 'description' | 'counterparty' | 'counterpartyIban' | 'amount'>, linked: readonly Receipt[], counterparties: readonly Counterparty[]): Provider | undefined {
  if (tx.direction !== 'CRDT' || tx.amount === 0) return undefined;
  const routing = identify(signalsOfTransaction(tx as BankTransaction, [...linked]), counterparties);
  if (routing.kind !== 'known') return undefined;
  const cp = counterparties.find((c) => c.id === routing.counterparty);
  return cp && isProvider(cp) ? cp : undefined;
}

/** The ids of the businesses that are payment providers. */
export const providerIds = (counterparties: readonly Counterparty[]): Set<string> => new Set(counterparties.filter(isProvider).map((c) => c.id));

/** The days a provider pays a sale out within: the company's file, else the app's, else PAYOUT_DAYS. */
export const payoutDaysOf = (p: Provider): number => p.provider.payoutDays ?? PAYOUT_DAYS;

/** How a payout is booked: bank / its clearing account in one line (`clearing`), not yet (`none`), or otherwise (as sales, by a person, …). */
export function payoutBooking(entries: readonly JournalEntry[], clearing: string): 'clearing' | 'none' | 'otherwise' {
  if (!entries.length) return 'none';
  return entries.length === 1 && entries[0].accountCredit === clearing && !entries[0].vatCode ? 'clearing' : 'otherwise';
}

/** A span of days, both ends included. */
export interface Span { from: string; to: string }

/** The spans as few as they go: overlapping and adjacent ones joined, in order. */
export function joinSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].filter((x) => x.from && x.to).sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out.at(-1);
    if (last && s.from <= addDays(last.to, 1)) { if (s.to > last.to) last.to = s.to; } else out.push({ ...s });
  }
  return out;
}

/** Whether the joined spans hold every day from `from` to `to`. */
export const covers = (joined: readonly Span[], from: string, to: string): boolean => joined.some((s) => s.from <= from && to <= s.to);

// ─── The clearing check ──────────────────────────────────────────────────────

/** One month's end and the clearing account's balance then, in the books' currency. */
export interface MonthEnd { date: string; balance: number }

/**
 * What a period's review shows of one provider's clearing account (#203 3): its balance at the
 * period's end, the month ends before it, and what the provider paid out after the end within its
 * payout days (`paidAfter`, absent while the bank's payments of those days are not in the books yet:
 * `known` says through when they are). Those payouts hold what the provider held at the end and the
 * sales it collected after it, so `paidAfter` is the most the balance may be: a balance above it is a
 * difference, found per order and corrected in the open period. `currency`: the clearing account's
 * entries are in a foreign currency, valued at each day's rate, so its balance carries exchange
 * differences until the year end revalues it. A fact, no reminder.
 */
export interface ClearingCheck {
  provider: string;
  name: string;
  account: string;
  through: string;
  balance: number;
  months: MonthEnd[];
  /** Paid out after `through` within `payoutDays`: the most the provider can have held at `through`. */
  paidAfter?: number;
  /** The currency of the account's entries when it is not the books' one. */
  currency?: string;
  payoutDays: number;
  /** The last day the books hold payments of the clearing's bank; before through + payoutDays, `unpaid` is not known yet. */
  known?: string;
}

/** The last day of each of the `n` months up to and including the month of `through`, oldest first; `through` itself for its own month. */
export function monthEnds(through: string, n: number): string[] {
  const out: string[] = [];
  const [y, m] = through.split('-').map(Number);
  for (let k = n - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(y, m - 1 - k + 1, 0));
    const iso = d.toISOString().slice(0, 10);
    out.push(iso > through ? through : iso);
  }
  return out;
}

/** The balance of `account` (debit less credit, in the books' currency) at the end of `date`: the year's opening plus its entries up to then. */
export function balanceAt(entries: readonly JournalEntry[], account: string, date: string, opening: Record<string, Record<string, number>> | undefined): number {
  const year = date.slice(0, 4);
  let r = toRappen(opening?.[year]?.[account] ?? 0);
  for (const e of entries) {
    if (e.date < `${year}-01-01` || e.date > date) continue;
    if (e.accountDebit === account) r += toRappen(chfAmount(e));
    if (e.accountCredit === account) r -= toRappen(chfAmount(e));
  }
  return fromRappen(r);
}

/**
 * The clearing check of one provider at `through`: the balance, the last `months` month ends, and
 * the payouts after `through` within its payout days (the entries that credit the clearing account
 * on a payment of the provider, dated after `through`).
 */
export function clearingCheck(p: Provider, books: { journalEntries: readonly JournalEntry[]; transactions: readonly BankTransaction[]; config?: { openingBalances?: Record<string, Record<string, number>> } }, through: string, months = 6): ClearingCheck | undefined {
  const account = p.provider.clearing;
  if (!account) return undefined;
  const opening = books.config?.openingBalances;
  const payoutDays = payoutDaysOf(p);
  const until = addDays(through, payoutDays);
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const payoutEntries = books.journalEntries.filter((e) => e.accountCredit === account && txByRef.get(e.transactionRef)?.direction === 'CRDT' && e.date > through && e.date <= until);
  const banks = new Set(books.journalEntries.filter((e) => e.accountCredit === account && txByRef.has(e.transactionRef)).map((e) => txByRef.get(e.transactionRef)!.bank));
  const known = books.transactions.filter((t) => banks.has(t.bank)).map((t) => t.date).sort().at(-1);
  const paidAfter = known && known >= until ? fromRappen(payoutEntries.reduce((s, e) => s + toRappen(chfAmount(e)), 0)) : undefined;
  const currency = books.journalEntries.find((e) => e.exchangeCurrency && e.date <= through && (e.accountDebit === account || e.accountCredit === account))?.exchangeCurrency;
  return {
    provider: p.id, name: p.name, account, through,
    balance: balanceAt(books.journalEntries, account, through, opening),
    months: monthEnds(through, months).map((date) => ({ date, balance: balanceAt(books.journalEntries, account, date, opening) })),
    ...(paidAfter !== undefined ? { paidAfter } : {}), payoutDays, ...(known ? { known } : {}), ...(currency ? { currency } : {}),
  };
}
