/**
 * Payment providers (#203): a shop platform or a card terminal collects the firm's sales and pays
 * them out less its fees. A payout is a settlement, not a sale: each sale raises what the provider
 * holds for the firm (its clearing account, `provider.clearing` in the company's file of it), the
 * payout moves money from there to the bank. So the payout is booked bank / clearing account without
 * VAT, in code; the sales come onto the clearing account from the provider's sales report, each with
 * its own code (src/booking/sales-report.ts); the fees from its fee report. A payout needs no receipt
 * and is never matched to one: its order documents are proof of the sales, not of the payout.
 *
 * The company's file says from which day on (`provider.since`, the cut-over day): a payout dated
 * before it is no settlement to the app, it stays as it was booked and is booked like any other
 * payment; the app never books an existing entry again to switch a provider over.
 *
 * Which business is a provider is said in its file (`provider:`, src/knowledge/provider.ts), never by
 * a name in code (ADR 0015). Pure.
 */
import { identify, signalsOfReceiptRead, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { addDays } from '../accounting/periods.js';

/** A business whose file makes it a payment provider. */
export type Provider = Counterparty & { provider: NonNullable<Counterparty['provider']> };

export const isProvider = (c: Counterparty): c is Provider => !!c.provider;

/** The company's clearing accounts, one per provider whose file names one: a line on one is dated by its order, not by a payment. */
export const clearingAccounts = (counterparties: readonly Counterparty[]): ReadonlySet<string> =>
  new Set(counterparties.flatMap((c) => (c.provider?.clearing ? [c.provider.clearing] : [])));

/** The company's accounts for a foreign VAT on a sale abroad, one per provider whose file names one (`provider.foreignTax`, #206). */
export const foreignTaxAccounts = (counterparties: readonly Counterparty[]): ReadonlySet<string> =>
  new Set(counterparties.flatMap((c) => (c.provider?.foreignTax ? [c.provider.foreignTax] : [])));

/** The days a provider pays a sale out within when its file does not say. */
export const PAYOUT_DAYS = 7;

/** Whether the company's file has the provider go over its clearing account on `date`: on or after its cut-over day, or while it names none yet (then its payouts wait for one). */
export const settlesOn = (p: Provider, date: string): boolean => !p.provider.since || date >= p.provider.since;

/**
 * The provider whose payout `tx` is, whatever its day: money in that routes to a business with a
 * `provider:` section. Money out to the same business (its subscription, a bill) is a purchase like
 * any other. A payout another company makes for the provider may name the provider in its
 * reference only (Shopify's arrive as «Received money from Stripe … with reference
 * Shopify …»): when the payer routes to no business (or to several), the payout is the provider's
 * whose `match.tx` word begins the reference as the bank writes it (referenceOf), when exactly one
 * provider's does and the bank names no payer or a payment processor of its file (`processors`). A payer the books know as a business of its own is never overruled by its reference.
 */
export function providerOfMoneyIn(tx: Pick<BankTransaction, 'date' | 'direction' | 'description' | 'counterparty' | 'counterpartyIban' | 'amount' | 'reference'>, linked: readonly Receipt[], counterparties: readonly Counterparty[]): Provider | undefined {
  if (tx.direction !== 'CRDT' || tx.amount === 0) return undefined;
  const routing = identify(signalsOfTransaction(tx as BankTransaction, [...linked]), counterparties);
  if (routing.kind === 'known') {
    const cp = counterparties.find((c) => c.id === routing.counterparty);
    return cp && isProvider(cp) ? cp : undefined;
  }
  const refs = referenceOf(tx);
  const named = refs.length ? counterparties.filter(isProvider).filter((c) => paidBy(tx, c) && c.match.tx.some((word) => refs.some((r) => beginsWith(r, word)))) : [];
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The order an order document of provider `p` names, without #: its read facts (Receipt.order), or, for a
 * page read before those were read, the first group of the provider's `orderPage` over its text (#249).
 * The pattern counts only on a page that is the provider's: no invoice, payout or report (a supplier's
 * invoice may begin a line with «#2001» too), and named as `p` among `providers` (identify), or, named
 * as none of them, typed a sales record whose text no other provider's `orderPage` matches.
 */
export function orderOf(r: Receipt, p: Provider, providers: readonly Provider[] = [p]): string | undefined {
  if (r.order) return r.order.number.replace(/^#/, '');
  if (r.report || r.payout || r.kind === 'invoice') return undefined;
  const numberOf = (q: Provider) => (q.provider.orderPage ?? []).map((re) => re.exec(r.extractedText ?? '')?.[1]?.replace(/^#/, '')).find((n) => !!n);
  const number = numberOf(p);
  if (!number) return undefined;
  const hit = identify(signalsOfReceiptRead(r), providers);
  if (hit.kind === 'known') return hit.counterparty === p.id ? number : undefined;
  return hit.kind === 'unknown' && r.kind === 'sales-record' && providers.every((q) => q.id === p.id || !numberOf(q)) ? number : undefined;
}

/** Providers whose sales come from their report from a cut-over day on: the provider way (#253). */
export const reportProviders = (providers: readonly Provider[]): Provider[] => providers.filter((p) => !!p.provider.reports.sales && !!p.provider.since);

/**
 * The provider and order of `r` as an order page of the provider way (#253), when it is one: no
 * invoice, payout or report; its order known by orderOf among the report providers, or its read order
 * facts (Receipt.order) of the one such provider, or of the one its file recognises the page by; dated
 * on or after that provider's cut-over day. A page no single provider can be named for is none.
 */
export function orderPageOf(r: Receipt, providers: readonly Provider[]): { provider: Provider; order: string; date: string } | undefined {
  const date = r.order?.date ?? r.date;
  if (!date || r.report || r.payout || r.kind === 'invoice') return undefined;
  const ways = reportProviders(providers);
  const routed = (): Provider | undefined => {
    if (ways.length === 1) return ways[0];
    const hit = identify(signalsOfReceiptRead(r), ways);
    return hit.kind === 'known' ? ways.find((p) => p.id === hit.counterparty) : undefined;
  };
  const provider = r.order ? routed() : ways.find((p) => !!orderOf(r, p, ways));
  const order = provider && orderOf(r, provider, ways);
  return provider && order && date >= provider.provider.since! ? { provider, order, date } : undefined;
}

/**
 * Whether the payer may pay the provider's payouts: none named, or one of the payment processors its
 * file lists (`provider.processors`), each as a whole word. The payer is the bank's counterparty, or,
 * when the bank sets none (Wise's PDF statements), the name in the description («Received money from
 * Hans Muster with reference Shopify Bestellung 1001»). A customer's own transfer names the customer,
 * so it is no payout.
 */
function paidBy(tx: Pick<BankTransaction, 'description' | 'counterparty'>, p: Provider): boolean {
  const name = (tx.counterparty?.trim() || /^Received money from (.+?)(?: with reference .*)?$/i.exec(tx.description.trim())?.[1]?.trim() || '').toLowerCase();
  if (!name) return true;
  return (p.provider.processors ?? []).some((w) => {
    const word = w.trim().toLowerCase();
    if (!word) return false;
    for (let at = name.indexOf(word); at >= 0; at = name.indexOf(word, at + 1)) {
      if (!/[\p{L}\d]/u.test(name.charAt(at - 1)) && !/[\p{L}\d]/u.test(name.charAt(at + word.length))) return true;
    }
    return false;
  });
}

/** The payment's reference as the bank writes it: its remittance field, and the text after «with reference» in its description. */
export function referenceOf(tx: Pick<BankTransaction, 'description' | 'reference'>): string[] {
  const inText = / with reference (.+)$/i.exec(tx.description.trim())?.[1];
  return [tx.reference, inText].filter((r): r is string => !!r?.trim()).map((r) => r.trim());
}

/** Whether `text` begins with `word` as a whole word, in any case. */
function beginsWith(text: string, word: string): boolean {
  const w = word.trim().toLowerCase();
  const t = text.replace(/^[^\p{L}\d]+/u, '').toLowerCase();
  return !!w && t.startsWith(w) && !/[\p{L}\d]/u.test(t.charAt(w.length));
}

/**
 * The provider whose payout `tx` is as a settlement (providerOfMoneyIn), dated on or after its
 * cut-over day (settlesOn). A payout before that day is a payment like any other and stays as it
 * was booked.
 */
export function providerOfPayment(tx: Pick<BankTransaction, 'date' | 'direction' | 'description' | 'counterparty' | 'counterpartyIban' | 'amount' | 'reference'>, linked: readonly Receipt[], counterparties: readonly Counterparty[]): Provider | undefined {
  const cp = providerOfMoneyIn(tx, linked, counterparties);
  return cp && settlesOn(cp, tx.date) ? cp : undefined;
}

/**
 * Why a provider's payout waits for the person instead of being booked: the company's file names no
 * clearing account (`clearing`) or no cut-over day (`since`) yet, so neither a rule nor the model
 * may guess its sales; or (`gap`) it is dated before the cut-over day, within the provider's payout
 * days of it, and a sales report has booked the provider's sales dated before it onto the clearing
 * account already: it may pay those, so booked as sales by a rule or the model they would count
 * twice, and booked from the clearing account it may take sales the report counted but never booked
 * (older than its reach). Only the person can tell; nothing books it meanwhile.
 */
export type PayoutWait = { why: 'clearing' | 'since' | 'gap'; provider: Provider };

/** Whether money in is a provider's payout that waits for the person (PayoutWait), and why. */
export function payoutWaitOf(tx: Pick<BankTransaction, 'date' | 'direction' | 'description' | 'counterparty' | 'counterpartyIban' | 'amount' | 'reference'>, linked: readonly Receipt[], counterparties: readonly Counterparty[], entries: readonly JournalEntry[]): PayoutWait | undefined {
  const provider = providerOfMoneyIn(tx, linked, counterparties);
  if (!provider) return undefined;
  const { clearing, since } = provider.provider;
  if (settlesOn(provider, tx.date)) return !clearing ? { why: 'clearing', provider } : !since ? { why: 'since', provider } : undefined;
  if (!clearing || !since || tx.date < addDays(since, -payoutDaysOf(provider))) return undefined;
  const prefix = `SR-${provider.id}-`;
  return entries.some((e) => e.transactionRef.startsWith(prefix) && e.accountDebit === clearing && e.date < tx.date) ? { why: 'gap', provider } : undefined;
}

/** The ids of the businesses that are payment providers. */
export const providerIds = (counterparties: readonly Counterparty[]): Set<string> => new Set(counterparties.filter(isProvider).map((c) => c.id));

/** The days a provider pays a sale out within: the company's file, else the app's, else PAYOUT_DAYS. */
export const payoutDaysOf = (p: Provider): number => p.provider.payoutDays ?? PAYOUT_DAYS;

/** Whether a payout is booked bank / its clearing account in one line without VAT. */
export const fromClearing = (entries: readonly JournalEntry[], clearing: string): boolean =>
  entries.length === 1 && entries[0].accountCredit === clearing && !entries[0].vatCode;

// ─── The clearing check ──────────────────────────────────────────────────────

/** One month's end and the clearing account's balance then, in the books' currency. */
export interface MonthEnd { date: string; balance: number }

/**
 * What a period's review shows of one provider's clearing account (#203 3): its balance at the
 * period's end, the month ends before it, and what the provider paid out after the end within its
 * payout days (`paidAfter`, absent while the bank's payments of those days are not in the books yet:
 * `known` says through when they are). Those payouts hold what the provider held at the end and the
 * sales it collected after it, so `paidAfter` is the most the balance may be: a balance above it is a
 * difference, found per order and corrected in the open period. A balance below zero is one too,
 * whatever was paid after: the provider paid out more than the books have sales for (a sale not
 * booked yet, such as one of a report not dropped). `currency`: the clearing account's
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
  /** The balance is below zero: the provider paid out more than the account holds sales for, a difference whatever was paid after. */
  below?: true;
  /** The gross of the orders up to `through` a sales report holds (#405): sales the account lacks until they are booked. */
  held?: number;
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
  const balance = balanceAt(books.journalEntries, account, through, opening);
  const currency = books.journalEntries.find((e) => e.exchangeCurrency && e.date <= through && (e.accountDebit === account || e.accountCredit === account))?.exchangeCurrency;
  return {
    provider: p.id, name: p.name, account, through,
    balance,
    months: monthEnds(through, months).map((date) => ({ date, balance: balanceAt(books.journalEntries, account, date, opening) })),
    ...(balance < 0 ? { below: true as const } : {}), ...(paidAfter !== undefined ? { paidAfter } : {}), payoutDays, ...(known ? { known } : {}), ...(currency ? { currency } : {}),
  };
}
