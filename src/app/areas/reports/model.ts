/**
 * Bilanz & ER: the three reports as lists of accounts in blocks, and one account's ledger. Every
 * figure comes from src/accounting (computeIncomeStatement, computeBalanceSheet, computeTrialBalance,
 * computeAccountLedger, openingBalancesAt); this file arranges them and filters what is shown.
 */
import type { Index, JournalEntry } from '../../../types/index.js';
import {
  computeAccountLedger, computeBalanceSheet, computeIncomeStatement, computeTrialBalance, openingBalancesAt,
  type AccountLedgerRow, type IncomeStatementSection,
} from '../../../accounting/index.js';
import type { Period } from '../../../accounting/periods.js';
import type { Report } from '../../shell/route.js';

/** The account of entries booked on one side only (a code that books the VAT itself, M81-2): no number. */
export const NO_ACCOUNT = '';
/** Its slug in a link: urls.md has no empty segment. */
export const NO_ACCOUNT_SLUG = 'none';

export interface AccountRow {
  account: string;
  value: number;
  /** Saldobilanz only: the balance when the period begins, and the period's debits and credits. */
  open?: number;
  debit?: number;
  credit?: number;
}

export type Block =
  | { kind: 'head'; title: string }
  /** `title` is the app's German section name (accountingName translates it) or a class digit. */
  | { kind: 'group'; title: string; rows: AccountRow[]; total?: number; plain?: { name: string; value: number } }
  | { kind: 'sum'; title: SumTitle; value: number; strong?: boolean };

export type SumTitle = 'grossProfit' | 'operatingResult' | 'netResult' | 'totalAssets' | 'totalLiabilities';

export interface ReportView {
  blocks: Block[];
  headline: { label: 'result' | 'balanceTotal' | 'balanced' | 'difference'; value: number };
  /** Bilanz: the day it shows, and the gap when assets and liabilities differ. */
  asOf?: string;
  gap?: { value: number; liabilities: number; oneSided: number };
  balanced?: boolean;
}

/** An account of the Bilanz (1xxx, 2xxx) or of the Erfolgsrechnung (3xxx–8xxx); 9xxx and none only in the Saldobilanz. */
export const reportOfAccount = (a: string): Report => (a >= '1' && a < '3' ? 'balance' : a >= '3' && a < '9' ? 'income' : 'trial');

const entriesOf = (books: Index) => books.journalEntries ?? [];

export function reportView(report: Report, books: Index, period: Period, names: Record<string, string>, all: boolean): ReportView {
  const entries = entriesOf(books);
  const keep = (r: AccountRow) => all || r.value !== 0 || !!r.open || !!r.debit || !!r.credit;
  if (report === 'income') {
    const s = computeIncomeStatement(entries, period.from, period.to, names);
    const group = (sec: IncomeStatementSection): Block => ({ kind: 'group', title: sec.title, rows: sec.rows.map((r) => ({ account: r.account, value: r.amount })).filter(keep), total: sec.total });
    return {
      blocks: [
        group(s.revenue), group(s.costOfGoods), { kind: 'sum', title: 'grossProfit', value: s.grossProfit },
        group(s.operatingExpenses), { kind: 'sum', title: 'operatingResult', value: s.operatingResult },
        group(s.otherIncome), group(s.otherExpenses), { kind: 'sum', title: 'netResult', value: s.netResult, strong: true },
      ],
      headline: { label: 'result', value: s.netResult },
    };
  }
  if (report === 'balance') {
    const year = period.to.slice(0, 4);
    const b = computeBalanceSheet(entries, period.to, books.config?.openingBalances?.[year] ?? {}, names);
    const groups = (secs: typeof b.assets): Block[] => secs.map((sec) => {
      const result = sec.rows.find((r) => r.account === '');
      return {
        kind: 'group', title: sec.title, total: sec.total,
        rows: sec.rows.filter((r) => r.account !== '').map((r) => ({ account: r.account, value: r.balance })).filter(keep),
        ...(result && { plain: { name: result.name, value: result.balance } }),
      };
    });
    const oneSided = entries.filter((e) => e.date >= `${year}-01-01` && e.date <= period.to && (!e.accountDebit || !e.accountCredit)).length;
    return {
      blocks: [
        { kind: 'head', title: 'assets' }, ...groups(b.assets), { kind: 'sum', title: 'totalAssets', value: b.totalAssets, strong: true },
        { kind: 'head', title: 'liabilities' }, ...groups(b.liabilities), { kind: 'sum', title: 'totalLiabilities', value: b.totalLiabilities, strong: true },
      ],
      headline: { label: 'balanceTotal', value: b.totalAssets },
      asOf: period.to,
      gap: b.isBalanced ? undefined : { value: round(b.totalAssets - b.totalLiabilities), liabilities: b.totalLiabilities, oneSided },
    };
  }
  const opening = openingBalancesAt(entries, period.from, books.config?.openingBalances);
  const tb = computeTrialBalance(entries, period.from, period.to, opening, names);
  const rows: AccountRow[] = tb.rows.map((r) => ({ account: r.account, value: r.balance, open: opening[r.account] ?? 0, debit: r.debitTotal, credit: r.creditTotal }));
  if (all) for (const a of Object.keys(names)) if (!rows.some((r) => r.account === a)) rows.push({ account: a, value: 0, open: 0, debit: 0, credit: 0 });
  rows.sort((x, y) => Number(x.account === NO_ACCOUNT) - Number(y.account === NO_ACCOUNT) || x.account.localeCompare(y.account));
  const classes: Block[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', NO_ACCOUNT]
    .map((k): Block => ({ kind: 'group', title: k, rows: rows.filter((r) => (k === NO_ACCOUNT ? r.account === NO_ACCOUNT : r.account[0] === k)).filter(keep) }))
    .filter((b) => b.kind === 'group' && b.rows.length > 0);
  return {
    blocks: classes,
    headline: tb.isBalanced ? { label: 'balanced', value: tb.totalDebits } : { label: 'difference', value: round(tb.totalDebits - tb.totalCredits) },
    balanced: tb.isBalanced,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The accounts a search finds: number and name contain every word. */
export function matches(q: string, account: string, names: Record<string, string>, none: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${account} ${account === NO_ACCOUNT ? none : names[account] ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * A search narrows the report to the accounts it finds, all of them, with or without an amount.
 * It finds an account in the report that holds it: when none in the shown report matches, the
 * other one of Bilanz and Erfolgsrechnung is returned to switch to.
 */
export function searchReport(report: Report, q: string, names: Record<string, string>, none: string): Report {
  if (!q.trim() || report === 'trial') return report;
  const found = Object.keys(names).filter((a) => matches(q, a, names, none));
  if (!found.length || found.some((a) => reportOfAccount(a) === report)) return report;
  const other = report === 'balance' ? 'income' : 'balance';
  return found.some((a) => reportOfAccount(a) === other) ? other : report;
}

export function filterBlocks(view: ReportView, q: string, names: Record<string, string>, none: string): ReportView {
  if (!q.trim()) return view;
  const blocks = view.blocks
    .flatMap((b): Block[] => (b.kind === 'group' ? [{ ...b, plain: undefined, rows: b.rows.filter((r) => matches(q, r.account, names, none)) }] : []))
    .filter((b) => b.kind === 'group' && b.rows.length > 0);
  return { ...view, blocks };
}

/** The accounts of a view in list order: ↑↓ walk them. */
export const accountsOf = (view: ReportView) => view.blocks.flatMap((b) => (b.kind === 'group' ? b.rows.map((r) => r.account) : []));

export interface Ledger {
  opening: number;
  /** Newest first, each with its counter account. */
  rows: Array<AccountLedgerRow & { other: string; entry?: JournalEntry }>;
  debit: number;
  credit: number;
  closing: number;
}

export function ledgerOf(books: Index, account: string, period: Period): Ledger {
  const entries = entriesOf(books);
  const opening = openingBalancesAt(entries, period.from, books.config?.openingBalances)[account] ?? 0;
  const { rows } = computeAccountLedger(entries, account, period.from, period.to, opening);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = rows.map((r) => {
    const entry = byId.get(r.entryId);
    return { ...r, entry, other: (r.debit != null ? entry?.accountCredit : entry?.accountDebit) ?? '' };
  });
  return {
    opening,
    rows: out.reverse(),
    debit: round(rows.reduce((s, r) => s + (r.debit ?? 0), 0)),
    credit: round(rows.reduce((s, r) => s + (r.credit ?? 0), 0)),
    closing: rows.length ? rows[rows.length - 1].balance : opening,
  };
}
