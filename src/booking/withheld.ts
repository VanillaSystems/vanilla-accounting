/**
 * What the wages withheld and the firm still owes on their behalf (#426): the credit on the
 * deductions account (setup.yaml `wages.deductions`) at the end of a payment's day. Books that carry
 * wages gross credit it with each payslip's deductions; the payment of the contributions clears it.
 * A contribution bill states its totals by contribution, not by party, so only the books say how much
 * of a payment is the employees' share: the model is told this figure for a payment that pays
 * contributions (`paysContributions`) and the guide says how to use it (booking.guide.yaml
 * cls-social-insurance). Code books nothing by it; it refuses an answer that takes more off the
 * account than it holds (`overWithheld`), and names a booked contribution payment that leaves the
 * account untouched while it held a credit (`unclearedContributions`, a task on Aufgaben).
 * Pure and browser-safe.
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { computeAccountBalance } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { chart, setup } from '../engines/index.js';

type Books = { journalEntries: readonly JournalEntry[]; config?: { openingBalances?: Record<string, Record<string, number>> } };

/**
 * The credit `account` holds at the end of the payment's day: the year's opening (in the account's
 * natural direction, as the year close writes it) and the year's entries up to then, without the
 * payment's own entries (a payment booked again is told what was open before it); undefined for
 * money in, without the account, or when it holds no credit (wages booked net never touch it).
 */
export function withheldFor(books: Books, tx: Pick<BankTransaction, 'ref' | 'date' | 'direction'>, account: string | undefined): number | undefined {
  if (!account || tx.direction !== 'DBIT') return undefined;
  const year = tx.date.slice(0, 4);
  const others = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
  const debitNormal = (a: string) => chart().isDebitNormal(a);
  const { balance } = computeAccountBalance(others, account, `${year}-01-01`, tx.date, books.config?.openingBalances?.[year]?.[account] ?? 0, debitNormal);
  const credit = debitNormal(account) ? -balance : balance;
  return credit > 0 ? credit : undefined;
}

/** The deductions account and the employer's contribution accounts of the jurisdiction (setup.yaml `wages`); undefined without a deductions account. */
export function wageAccounts(): { deductions: string; contributions: ReadonlySet<string>; shared: ReadonlySet<string>; payees: readonly string[] } | undefined {
  const w = setup().wages;
  return w?.deductions ? { deductions: w.deductions, contributions: new Set(w.contributions ?? []), shared: new Set(w.shared ?? []), payees: w.payees ?? [] } : undefined;
}

const fold = (s: string | undefined) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Whether a payment out pays social insurance contributions, by what the books know of its payee:
 * the business it routes to is one the jurisdiction names as collecting them (setup.yaml
 * `wages.payees`, the business files' ids), or an earlier payment to the same business (or the same
 * counterparty name) is booked on the deductions account or an employer's contribution account. A
 * wage itself is none.
 */
export function paysContributions(books: Pick<Books, 'journalEntries'> & { transactions: readonly BankTransaction[] }, tx: BankTransaction, businessOf: (t: BankTransaction) => string | undefined): boolean {
  const w = wageAccounts();
  if (!w || tx.direction !== 'DBIT') return false;
  const business = businessOf(tx);
  if (business && w.payees.includes(business)) return true;
  const payee = fold(tx.counterparty);
  const same = (t: BankTransaction) => t.ref !== tx.ref && t.date <= tx.date && ((!!business && businessOf(t) === business) || (!!payee && fold(t.counterparty) === payee));
  const refs = new Set(books.transactions.filter(same).map((t) => t.ref));
  if (!refs.size) return false;
  const onThem = books.journalEntries.filter((e) => refs.has(e.transactionRef));
  // An earlier wage to the same person is no contribution: its lines are on the wage account, not on these.
  return onThem.some((e) => w.contributions.has(e.accountDebit) || w.contributions.has(e.accountCredit) || e.accountDebit === w.deductions);
}

/** What an answer takes off the deductions account (its debits there less its credits), in the books' currency. */
export function takenOff(entries: readonly Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'exchangeRate' | 'exchangeCurrency'>[], account: string): number {
  let r = 0;
  for (const e of entries) {
    const chf = e.exchangeCurrency && e.exchangeRate ? e.amount * e.exchangeRate : e.amount;
    if (e.accountDebit === account) r += toRappen(chf);
    if (e.accountCredit === account) r -= toRappen(chf);
  }
  return fromRappen(r);
}

/** An answer that takes more off the deductions account than it held on the payment's day (`open`, absent: nothing): what it takes and what was there. */
export function overWithheld(entries: readonly JournalEntry[], account: string, open: number | undefined): { taken: number; open: number } | undefined {
  const taken = takenOff(entries, account);
  return taken > (open ?? 0) + 0.004 ? { taken, open: open ?? 0 } : undefined;
}

/** A booked contribution payment that takes nothing off the deductions account, which still holds `open` at the end of the period. */
export interface Uncleared { tx: BankTransaction; account: string; open: number }

/**
 * The payments dated `from`–`to` that can carry the employees' share, booked on a contribution
 * account the employees share in (setup.yaml `wages.shared`: not one the employer pays alone, as the
 * family allowances) with no line on the deductions account, while that account still holds a
 * credit at `to`: the employees' share the payslips withheld is still on it, and the staff expense
 * that much too high (#426). A payment can carry the share when its payee is one that collects it
 * (`payees`: the refs of payments to a business of `wages.payees`, which the server routes by the
 * business files, src/intake/pair-chain.ts providerIssuesIn) or an earlier payment to the same
 * counterparty took something off the deductions account. Cleared since, by hand on a ref of its
 * own, the account holds nothing at `to` and the task is gone.
 */
export function unclearedContributions(books: Books & { transactions: readonly BankTransaction[] }, from: string, to: string, payees: ReadonlySet<string> = new Set()): Uncleared[] {
  const w = wageAccounts();
  if (!w) return [];
  const open = withheldFor(books, { ref: '', date: to, direction: 'DBIT' }, w.deductions);
  if (!open) return [];
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  const cleared = new Set(books.transactions.filter((t) => byRef.get(t.ref)?.some((e) => e.accountDebit === w.deductions)).map((t) => t));
  const sharer = (tx: BankTransaction) => payees.has(tx.ref) || (!!tx.counterparty && [...cleared].some((t) => t.ref !== tx.ref && t.date <= tx.date && fold(t.counterparty) === fold(tx.counterparty)));
  return books.transactions.flatMap((tx): Uncleared[] => {
    const lines = tx.date >= from && tx.date <= to ? byRef.get(tx.ref) : undefined;
    if (!lines?.length || tx.direction !== 'DBIT') return [];
    if (!lines.some((e) => w.shared.has(e.accountDebit)) || lines.some((e) => e.accountDebit === w.deductions || e.accountCredit === w.deductions)) return [];
    return sharer(tx) ? [{ tx, account: w.deductions, open }] : [];
  });
}

/** The payments out to a business that collects contributions with the employees' share (setup.yaml `wages.payees`), by ref: what the app's task needs of the business files. */
export function withheldPayeesOf(transactions: readonly BankTransaction[], businessOf: (t: BankTransaction) => string | undefined): string[] {
  const w = wageAccounts();
  if (!w?.payees.length) return [];
  return transactions.filter((t) => t.direction === 'DBIT' && w.payees.includes(businessOf(t) ?? '')).map((t) => t.ref);
}
