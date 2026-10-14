/**
 * Kontoauszüge as the list and detail show them, derived from the books and never stored: each
 * bank account's monthly statements in a period, a month that ended without one as missing, the
 * payments of a statement (a Wise fee folded into its payment), and the balance checks. Pure, so
 * the list, the keys, the dock badge and the tests read the same statements.
 */
import type { BankStatement, BankTransaction, Index, JournalEntry } from '../../../types/index.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { addDays, type IsoDate } from '../../../accounting/periods.js';
import { bookBalanceNative, nativeOpening } from '../../../accounting/reconcile-bank.js';
import { fromRappen, toRappen } from '../../../accounting/rappen.js';
import { splitTitle } from '../receipts/model.js';
import { baseCurrency } from '../../../engines/index.js';

export type Account = Pick<LedgerBankAccount, 'bank' | 'currency' | 'account' | 'label' | 'statements'>;

export interface Statement {
  /** `<account>-<yyyy-mm>` of its first day: the statement's id in a link (docs/urls.md). */
  key: string;
  account: Account;
  from: IsoDate;
  to: IsoDate;
  /** The PDF; absent when the month ended without a statement, or has not ended yet. */
  file?: BankStatement;
  /** The month has not ended: its payments are there, its statement is still to come. */
  running?: boolean;
}

export interface Check {
  /** The bank's balance the day before the statement starts (the previous statement's end, or the year's opening). */
  open: number | null;
  /** The bank's balance on its last day. */
  close: number | null;
  inc: number;
  out: number;
  /** Payments booked by the bank in it, fees included. */
  n: number;
  /** open + inc − out − close: not 0 when a payment is missing or counted twice. Null without both balances. */
  diff: number | null;
  ok: boolean;
  /** The ledger's balance of the account on the last day, in its currency (src/accounting/reconcile-bank.ts). */
  book: number;
  /** book − close: not 0 when a payment is not booked, or booked wrong. */
  bookDiff: number | null;
}

/** A payment's amount with its direction: money out is negative. */
export const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -1 : 1) * Math.abs(t.amount);

const round = (n: number) => fromRappen(toRappen(n));
const monthEnd = (d: IsoDate) => addDays(`${monthAdd(d.slice(0, 7), 1)}-01`, -1);
function monthAdd(ym: string, n: number): string {
  const m = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
}

export const statementKey = (account: string, from: IsoDate) => `${account}-${from.slice(0, 7)}`;

/** A statement key's account and month: "1021-2026-09" → ["1021", "2026-09"]. */
export function parseStatementKey(key: string): { account: string; month: string } | undefined {
  const m = /^(.+)-(\d{4}-\d{2})$/.exec(key);
  return m ? { account: m[1], month: m[2] } : undefined;
}

/** A Wise fee is folded into its payment when that payment is there ("FEE-CARD-1" belongs to "CARD-1"). */
const baseRef = (fee: BankTransaction) => fee.ref.replace(/^FEE-/, '');

export interface Bank {
  /** The accounts statements come for, in the manifest's order (not the private `manual` one). */
  accounts: Account[];
  closedThrough?: string;
  /** Statements and missing months of every account overlapping [from, to], newest last day first. */
  statements(from: IsoDate, to: IsoDate): Statement[];
  /** Any statement by key, missing ones of the account's months included. */
  byKey(key: string): Statement | undefined;
  /** The statement a payment is on; none for a private one. */
  statementOf(t: BankTransaction): Statement | undefined;
  /** Its payments, newest first; a Wise fee folded into its payment is left out. */
  payments(s: Statement): BankTransaction[];
  /** The fee folded into a payment. */
  feeOf(ref: string): BankTransaction | undefined;
  check(s: Statement): Check;
  receiptsOf(ref: string): string[];
  /** A receipt's vendor (its description up to the first comma or dash) and date. */
  receiptOf(id: string): { name: string; date?: string } | undefined;
  entriesOf(ref: string): JournalEntry[];
  txByRef: Map<string, BankTransaction>;
  /** A payment still waiting for its receipt: not a fee, not 0, not marked as needing none, nothing linked. */
  needsReceipt(t: BankTransaction): boolean;
}

export function bankOf(books: Index, accounts: readonly Account[], today: IsoDate): Bank {
  const banked = accounts.filter((a) => a.statements);
  const accountOf = (bank: string, currency: string) => banked.find((a) => a.bank === bank && a.currency === currency);
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const byAccount = new Map<string, BankTransaction[]>(banked.map((a) => [a.account, []]));
  for (const t of books.transactions) {
    const a = accountOf(t.bank, t.currency);
    if (a) byAccount.get(a.account)!.push(t);
  }
  const fees = new Map<string, BankTransaction>();
  for (const t of books.transactions) if (t.type === 'wise-fee' && txByRef.has(baseRef(t))) fees.set(baseRef(t), t);
  const folded = (t: BankTransaction) => t.type === 'wise-fee' && txByRef.has(baseRef(t));

  const receiptById = new Map(books.receipts.map((r) => [r.id, r]));
  const receipts = new Map<string, string[]>();
  for (const m of books.mappings) (receipts.get(m.transactionRef) ?? receipts.set(m.transactionRef, []).get(m.transactionRef)!).push(m.receiptId);
  const entries = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) (entries.get(e.transactionRef) ?? entries.set(e.transactionRef, []).get(e.transactionRef)!).push(e);

  const files = new Map<string, Statement[]>(banked.map((a) => [a.account, []]));
  for (const f of books.bankStatements) {
    const a = accountOf(f.bank, f.currency ?? baseCurrency());
    if (a) files.get(a.account)!.push({ key: statementKey(a.account, f.fromDate), account: a, from: f.fromDate, to: f.toDate, file: f });
  }

  // An account's months start with its first statement or payment, or the year its books open.
  const opens = Object.keys(books.config?.openingBalances ?? {}).sort()[0];
  const startOf = new Map(banked.map((a) => {
    const firsts = [...files.get(a.account)!.map((s) => s.from), ...byAccount.get(a.account)!.map((t) => t.date)].sort();
    const first = opens && firsts[0] && `${opens}-01-01` < firsts[0] ? `${opens}-01-01` : firsts[0];
    return [a.account, first] as const;
  }));

  function forAccount(a: Account, from: IsoDate, to: IsoDate): Statement[] {
    const have = files.get(a.account)!.filter((s) => s.to >= from && s.from <= to);
    const start = startOf.get(a.account);
    const missing: Statement[] = [];
    if (start) {
      for (let m = (from > start ? from : start).slice(0, 7); `${m}-01` <= to && `${m}-01` <= today; m = monthAdd(m, 1)) {
        const first = `${m}-01`, last = monthEnd(first);
        if (files.get(a.account)!.some((s) => s.from <= first && s.to >= last)) continue;
        const running = last >= today;
        if (running && !byAccount.get(a.account)!.some((t) => t.date >= first)) continue;
        missing.push({ key: statementKey(a.account, first), account: a, from: first, to: last, ...(running && { running }) });
      }
    }
    return [...have, ...missing];
  }

  const balanceOn = (account: string, date: IsoDate) => books.statementBalances?.find((b) => b.account === account && b.date === date)?.amount ?? null;

  const checks = new Map<string, Check>();
  function check(s: Statement): Check {
    const hit = checks.get(s.key);
    if (hit) return hit;
    const { account, currency } = s.account;
    const year = s.from.slice(0, 4);
    const open = balanceOn(account, addDays(s.from, -1))
      ?? (s.from.slice(5) === '01-01' && books.config?.openingBalances?.[year] ? nativeOpening(books, account, currency, year) : null);
    const close = balanceOn(account, s.to);
    const xs = byAccount.get(account)!.filter((t) => t.date >= s.from && t.date <= s.to);
    const inc = round(xs.filter((t) => signed(t) > 0).reduce((a, t) => a + signed(t), 0));
    const out = round(xs.filter((t) => signed(t) < 0).reduce((a, t) => a - signed(t), 0));
    const diff = open == null || close == null ? null : round(open + inc - out - close);
    const book = bookBalanceNative(books.journalEntries ?? [], account, currency, s.to.slice(0, 4), s.to, nativeOpening(books, account, currency, s.to.slice(0, 4)));
    const c: Check = { open, close, inc, out, n: xs.length, diff, ok: diff === 0, book, bookDiff: close == null ? null : round(book - close) };
    checks.set(s.key, c);
    return c;
  }

  const desc = (x: Statement, y: Statement) => y.to.localeCompare(x.to) || banked.indexOf(x.account) - banked.indexOf(y.account);

  return {
    accounts: banked,
    closedThrough: books.config?.closedThrough,
    statements: (from, to) => banked.flatMap((a) => forAccount(a, from, to)).sort(desc),
    byKey(key) {
      const k = parseStatementKey(key);
      const a = k && banked.find((x) => x.account === k.account);
      if (!a || !k) return undefined;
      return files.get(a.account)!.find((s) => s.key === key) ?? forAccount(a, `${k.month}-01`, monthEnd(`${k.month}-01`)).find((s) => s.key === key);
    },
    statementOf(t) {
      const a = accountOf(t.bank, t.currency);
      if (!a) return undefined;
      return files.get(a.account)!.find((s) => t.date >= s.from && t.date <= s.to) ?? forAccount(a, t.date, t.date)[0];
    },
    payments: (s) => byAccount.get(s.account.account)!
      .filter((t) => t.date >= s.from && t.date <= s.to && !folded(t))
      .sort((x, y) => y.date.localeCompare(x.date) || y.ref.localeCompare(x.ref)),
    feeOf: (ref) => fees.get(ref),
    check,
    receiptsOf: (ref) => receipts.get(ref) ?? [],
    receiptOf(id) {
      const r = receiptById.get(id);
      return r && { name: splitTitle(r.description || r.filename.replace(/\.pdf$/i, ''))[0], date: r.date };
    },
    entriesOf: (ref) => entries.get(ref) ?? [],
    txByRef,
    needsReceipt: (t) => t.type !== 'wise-fee' && t.amount !== 0 && !t.noReceiptNeeded && !(receipts.get(t.ref) ?? []).length,
  };
}

/** A statement with a problem: missing, or its payments do not add up to the bank's balance. */
export const troubled = (b: Bank, s: Statement) => {
  if (!s.file) return !s.running;
  const c = b.check(s);
  return c.diff != null && !c.ok;
};

/** What the dock's badge counts: statements with a problem from the open quarter until today. */
export const badgeCount = (b: Bank, openFrom: IsoDate, today: IsoDate) => b.statements(openFrom, today).filter((s) => troubled(b, s)).length;

/**
 * A bank's text as a name and a note: "Card transaction of 12.00 USD issued by Shop" is the
 * shop with the foreign amount, "Received money from X with reference Y" is X with Y.
 */
export function payText(t: BankTransaction): { name: string; note?: string } {
  const s = t.description;
  let m: RegExpExecArray | null;
  if ((m = /^Card transaction of (-?[\d.,]+) (\w{3}) issued by (.+?)(?:\s*\(fee?:?.*)?$/.exec(s))) {
    return { name: m[3], ...(m[2] !== t.currency ? { note: `${m[2]} ${Math.abs(Number(m[1].replace(/,/g, ''))).toFixed(2)}` } : {}) };
  }
  if ((m = /^Received money from (.+?) with reference (.+)$/.exec(s))) return { name: m[1], note: m[2] };
  if ((m = /^Sent money to (.+?)(?: with reference (.+))?$/.exec(s))) return { name: m[1], ...(m[2] ? { note: m[2] } : {}) };
  if ((m = /^(?:Zahlung|Gutschrift|Belastung)\s+(.+)$/.exec(s))) return { name: m[1].slice(0, 70) };
  return { name: s.slice(0, 70) };
}

/** The text a search looks in for a payment: the bank's text, reference, amount, date, and the linked receipts' words. */
export function payHaystack(t: BankTransaction, receiptWords: string): string {
  return [t.description, t.reference, Math.abs(t.amount).toFixed(2), t.date, t.date.split('-').reverse().join('.'), t.remarks, receiptWords].join(' ').toLowerCase();
}

export const matches = (haystack: string, q: string | undefined) => (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => haystack.includes(w));
