/**
 * Bilanz & ER: the three reports as lists of accounts in blocks, and one account's ledger. Every
 * figure comes from src/accounting (computeIncomeStatement, computeBalanceSheet, computeTrialBalance,
 * computeAccountLedger, openingBalancesAt) over the books' `statementPostings`: net of VAT where the
 * jurisdiction says so; this file arranges them and filters what is shown.
 */
import type { Index, JournalEntry } from '../../../types/index.js';
import {
  computeAccountLedger, computeBalanceSheet, computeIncomeStatement, computeTrialBalance, openingBalancesAt,
  isDerived, sourceEntryId, statementPostings, statementVatAccount,
  type AccountLedgerRow, type IncomeStatementSection, type Postings,
} from '../../../accounting/index.js';
import type { Period } from '../../../accounting/periods.js';
import { computeBalances } from '../../../accounting/ledger.js';
import { differenceCauses, type DifferenceCause } from '../../../accounting/year-close.js';
import { vatInFigures, type VatInFigures } from '../../../accounting/vat-in-figures.js';

/** The export's tables (src/export/tables.ts) name the VAT parts through the reports they print. */
export { vatParts } from '../../../accounting/vat-in-figures.js';
import type { Report } from '../../shell/route.js';
import { chart, statements } from '../../../engines/index.js';
import { matchesTags, type Dimension, type TagFilter } from '../../../books/tags.js';

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

/**
 * What Bilanz & ER say about the VAT. `net`: the figures are net, the tax sits on `account` (the
 * jurisdiction's statements are net within the year); `gross`: the figures hold `figures`, settled
 * at the year close (r8c-2). Absent when the entries carry no code (a firm not registered).
 */
export type VatNote = { shown: 'net'; account: string } | { shown: 'gross'; figures: VatInFigures };

function vatNote(entries: readonly JournalEntry[], from: string, to: string, chartAccounts: readonly string[]): VatNote | undefined {
  const figures = vatInFigures(entries, from, to);
  if (!figures) return undefined;
  return statements().vat === 'net' ? { shown: 'net', account: statementVatAccount(chartAccounts) } : { shown: 'gross', figures };
}

export interface ReportView {
  blocks: Block[];
  headline: { label: 'result' | 'balanceTotal' | 'balanced' | 'difference'; value: number };
  /** Erfolgsrechnung: the period's VAT; Bilanz: the year's up to its day. */
  vat?: VatNote;
  /** Bilanz: the day it shows, and the gap when assets and liabilities differ. */
  asOf?: string;
  gap?: { value: number; liabilities: number; causes: DifferenceCause[] };
  balanced?: boolean;
}

/** An account of the Bilanz (1xxx, 2xxx) or of the Erfolgsrechnung (3xxx–8xxx); 9xxx and none only in the Saldobilanz. */
export const reportOfAccount = (a: string): Report => (a >= '1' && a < '3' ? 'balance' : a >= '3' && a < '9' ? 'income' : 'trial');

const entriesOf = (books: Index) => books.journalEntries ?? [];
/** What the reports read: the journal, net of VAT where the jurisdiction says so; `names` is the chart. */
export const reportPostings = (books: Index, names: Record<string, string>): Postings => statementPostings(entriesOf(books), Object.keys(names));

export function reportView(report: Report, books: Index, period: Period, names: Record<string, string>, all: boolean): ReportView {
  const entries = entriesOf(books);
  const postings = reportPostings(books, names);
  const chartAccounts = Object.keys(names);
  const keep = (r: AccountRow) => all || r.value !== 0 || !!r.open || !!r.debit || !!r.credit;
  if (report === 'income') {
    const s = computeIncomeStatement(postings, period.from, period.to, names);
    const group = (sec: IncomeStatementSection): Block => ({ kind: 'group', title: sec.title, rows: sec.rows.map((r) => ({ account: r.account, value: r.amount })).filter(keep), total: sec.total });
    return {
      blocks: [
        group(s.revenue), group(s.costOfGoods), { kind: 'sum', title: 'grossProfit', value: s.grossProfit },
        group(s.operatingExpenses), { kind: 'sum', title: 'operatingResult', value: s.operatingResult },
        group(s.otherIncome), group(s.otherExpenses), { kind: 'sum', title: 'netResult', value: s.netResult, strong: true },
      ],
      headline: { label: 'result', value: s.netResult },
      vat: vatNote(entries, period.from, period.to, chartAccounts),
    };
  }
  if (report === 'balance') {
    const year = period.to.slice(0, 4);
    const b = computeBalanceSheet(postings, period.to, books.config?.openingBalances?.[year] ?? {}, names);
    const groups = (secs: typeof b.assets): Block[] => secs.map((sec) => {
      const result = sec.rows.find((r) => r.account === '');
      return {
        kind: 'group', title: sec.title, total: sec.total,
        rows: sec.rows.filter((r) => r.account !== '').map((r) => ({ account: r.account, value: r.balance })).filter(keep),
        ...(result && { plain: { name: result.name, value: result.balance } }),
      };
    });
    const opening = books.config?.openingBalances?.[year] ?? {};
    const booked = postings.filter((e) => e.date >= `${year}-01-01` && e.date <= period.to);
    const balances = Object.fromEntries(computeBalances(booked, `${year}-01-01`, period.to, opening, chart().isDebitNormal).map((r) => [r.account, r.balance]));
    return {
      blocks: [
        { kind: 'head', title: 'assets' }, ...groups(b.assets), { kind: 'sum', title: 'totalAssets', value: b.totalAssets, strong: true },
        { kind: 'head', title: 'liabilities' }, ...groups(b.liabilities), { kind: 'sum', title: 'totalLiabilities', value: b.totalLiabilities, strong: true },
      ],
      headline: { label: 'balanceTotal', value: b.totalAssets },
      vat: vatNote(entries, `${year}-01-01`, period.to, chartAccounts),
      asOf: period.to,
      gap: b.isBalanced ? undefined : { value: round(b.totalAssets - b.totalLiabilities), liabilities: b.totalLiabilities, causes: differenceCauses(opening, booked, balances, chartAccounts) },
    };
  }
  const opening = openingOf(books, postings, period.from);
  const tb = computeTrialBalance(postings, period.from, period.to, opening, names);
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

/** The books with only the entries that carry the tags the filter asks for (#127): every report and ledger of them reads only those. */
export function slicedBooks(books: Index, filter: TagFilter | undefined): Index {
  if (!filter || !Object.values(filter).some((v) => v.length)) return books;
  return { ...books, journalEntries: entriesOf(books).filter((e) => matchesTags(e.tags, filter)) };
}

/** The value of `by` an entry carries; '' none. */
const valueOf = (e: JournalEntry, by: Dimension) => e.tags?.[by.id] ?? '';

/**
 * The Erfolgsrechnung in columns, one per value of `by` the period's entries carry (the declared
 * values first, in their order, then the others; '' for the entries without one, last): each the
 * report of only those entries, so the columns add up to the report of all of them.
 */
export function incomeColumns(books: Index, period: Period, names: Record<string, string>, by: Dimension): Array<{ value: string; view: ReportView }> {
  const inPeriod = entriesOf(books).filter((e) => e.date >= period.from && e.date <= period.to);
  const used = new Set(inPeriod.map((e) => valueOf(e, by)));
  const declared = by.values.map((v) => v.value).filter((v) => used.has(v));
  const others = [...used].filter((v) => v && !declared.includes(v)).sort((a, b) => a.localeCompare(b));
  const values = [...declared, ...others, ...(used.has('') ? [''] : [])];
  return values.map((value) => ({ value, view: reportView('income', { ...books, journalEntries: entriesOf(books).filter((e) => valueOf(e, by) === value) }, period, names, true) }));
}

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
  /** Newest first, each with its counter account; `derived`: the tax a code split off (statementPostings), `entry` then the entry it comes from. */
  rows: Array<AccountLedgerRow & { other: string; entry?: JournalEntry; derived: boolean }>;
  debit: number;
  credit: number;
  closing: number;
}

/** Each account's balance when `from` begins, its normal side from the workspace's chart. */
export const openingOf = (books: Index, postings: Postings, from: string) =>
  openingBalancesAt(postings, from, books.config?.openingBalances, chart().isDebitNormal);

/**
 * One account's ledger over the reports' postings (`names` is the chart): its balances are the
 * statements'. A tax posting derived from a code names the VAT account or the carrier as its
 * counter account and links to the entry whose code it splits.
 */
export function ledgerOf(books: Index, account: string, period: Period, names: Record<string, string>): Ledger {
  const postings = reportPostings(books, names);
  const opening = openingOf(books, postings, period.from)[account] ?? 0;
  const { rows } = computeAccountLedger(postings, account, period.from, period.to, opening);
  const byId = new Map(postings.map((e) => [e.id, e]));
  const entries = new Map(entriesOf(books).map((e) => [e.id, e]));
  const out = rows.map((r) => {
    const posting = byId.get(r.entryId);
    return {
      ...r,
      entry: entries.get(sourceEntryId({ id: r.entryId })),
      derived: isDerived({ id: r.entryId }),
      other: (r.debit != null ? posting?.accountCredit : posting?.accountDebit) ?? '',
    };
  });
  return {
    opening,
    rows: out.reverse(),
    debit: round(rows.reduce((s, r) => s + (r.debit ?? 0), 0)),
    credit: round(rows.reduce((s, r) => s + (r.credit ?? 0), 0)),
    closing: rows.length ? rows[rows.length - 1].balance : opening,
  };
}
