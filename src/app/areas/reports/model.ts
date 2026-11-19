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
import { booksFirstDay, yearBefore, type Period } from '../../../accounting/periods.js';
import { computeBalances } from '../../../accounting/ledger.js';
import { differenceCauses, type DifferenceCause } from '../../../accounting/year-close.js';
import { vatInFigures, type VatInFigures } from '../../../accounting/vat-in-figures.js';

/** The export's tables (src/export/tables.ts) name the VAT parts through the reports they print. */
export { vatParts } from '../../../accounting/vat-in-figures.js';
import type { Report } from '../../shell/route.js';
import { chart, statements } from '../../../engines/index.js';
import type { IncomeSection, StageResult } from '../../../core/modules/schema.js';
import { roundCHF } from '../../../accounting/rappen.js';
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
  /** Bilanz and Erfolgsrechnung with prior-year figures (`ReportView.prior` has `source`): the prior year's. */
  prior?: number;
}

export type Block =
  | { kind: 'head'; title: string }
  /** `title` is the app's German section name (accountingName translates it) or a class digit. */
  | { kind: 'group'; title: string; rows: AccountRow[]; total?: number; priorTotal?: number; plain?: { name: string; value: number; prior?: number } }
  | { kind: 'sum'; title: SumTitle; value: number; prior?: number; strong?: boolean };

/**
 * The prior year beside the Bilanz and the Erfolgsrechnung (OR 958d Abs. 2 in Switzerland): the
 * Bilanz of the last day of the year before, the Erfolgsrechnung of the same days a year earlier.
 * `books`: read from the books, which reach back to it (`since`: they begin only then, inside the
 * prior period); `opening`: the Bilanz from the opening balances of the shown year, all there is
 * of a year kept elsewhere. Without either the figures are `missing`, never zeros: `noBooks` (the
 * books begin on `first`, or hold nothing dated), `overlap` (a period over a year long, or all).
 */
export type Prior =
  | { from: string; to: string; source: 'books' | 'opening'; since?: string }
  | { from: string; to: string; missing: 'noBooks' | 'overlap'; first?: string };

export type SumTitle = 'grossProfit' | StageResult | 'operatingResult' | 'netResult' | 'totalAssets' | 'totalLiabilities';

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
  /** Bilanz and Erfolgsrechnung: where the prior-year figures come from, or why there are none. */
  prior?: Prior;
}

/** An account of the Bilanz (1xxx, 2xxx) or of the Erfolgsrechnung (3xxx–8xxx); 9xxx and none only in the Saldobilanz. */
export const reportOfAccount = (a: string): Report => (a >= '1' && a < '3' ? 'balance' : a >= '3' && a < '9' ? 'income' : 'trial');

const entriesOf = (books: Index) => books.journalEntries ?? [];
/** What the reports read: the journal, net of VAT where the jurisdiction says so; `names` is the chart. */
export const reportPostings = (books: Index, names: Record<string, string>): Postings => statementPostings(entriesOf(books), Object.keys(names));

export function reportView(report: Report, books: Index, period: Period, names: Record<string, string>, all: boolean, withPrior = true): ReportView {
  const entries = entriesOf(books);
  const postings = reportPostings(books, names);
  const chartAccounts = Object.keys(names);
  const keep = (r: AccountRow) => all || r.value !== 0 || !!r.prior || !!r.open || !!r.debit || !!r.credit;
  if (report === 'income' || report === 'balance') {
    const prior = withPrior ? priorOf(report, books, period) : undefined;
    const view = report === 'income' ? incomeView(postings, period.from, period.to, names) : balanceView(books, postings, period.to, names);
    const before = prior && 'source' in prior ? priorView(report, books, postings, prior, names) : undefined;
    const blocks = (before ? besidePrior(view.blocks, before.blocks) : view.blocks)
      .map((b) => (b.kind === 'group' ? { ...b, rows: b.rows.filter(keep) } : b));
    if (report === 'income') {
      return { blocks, headline: { label: 'result', value: view.result }, vat: vatNote(entries, period.from, period.to, chartAccounts), ...(prior && { prior }) };
    }
    const year = period.to.slice(0, 4);
    const opening = openingOfYear(books, year);
    const booked = postings.filter((e) => e.date >= `${year}-01-01` && e.date <= period.to);
    const balances = Object.fromEntries(computeBalances(booked, `${year}-01-01`, period.to, opening, chart().isDebitNormal).map((r) => [r.account, r.balance]));
    return {
      blocks,
      headline: { label: 'balanceTotal', value: view.result },
      vat: vatNote(entries, `${year}-01-01`, period.to, chartAccounts),
      asOf: period.to,
      gap: view.balanced ? undefined : { value: round(view.result - view.liabilities), liabilities: view.liabilities, causes: differenceCauses(opening, booked, balances, chartAccounts) },
      ...(prior && { prior }),
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

/** The opening balances the books hold for `year`. */
const openingOfYear = (books: Index, year: string): Record<string, number> => books.config?.openingBalances?.[year] ?? {};

/** The Erfolgsrechnung of `from`..`to` as blocks with every account, in the jurisdiction's stages; `result` the net result. */
function incomeView(postings: Postings, from: string, to: string, names: Record<string, string>) {
  const s = computeIncomeStatement(postings, from, to, names);
  const blocks: Block[] = [
    ...staged('revenue', s.revenue, 0), ...staged('costOfGoods', s.costOfGoods, s.revenue.total), { kind: 'sum', title: 'grossProfit', value: s.grossProfit },
    ...staged('operatingExpenses', s.operatingExpenses, s.grossProfit), { kind: 'sum', title: 'operatingResult', value: s.operatingResult },
    ...staged('otherIncome', s.otherIncome, s.operatingResult), ...staged('otherExpenses', s.otherExpenses, s.operatingResult + s.otherIncome.total),
    { kind: 'sum', title: 'netResult', value: s.netResult, strong: true },
  ];
  return { blocks, result: s.netResult, liabilities: 0, balanced: true };
}

/** The sections that add to the result; every other one takes from it. */
const ADDS: readonly IncomeSection[] = ['revenue', 'otherIncome'];

/**
 * A section of the Erfolgsrechnung as its stages (statements.yaml `incomeStages`, OR 959b in
 * Switzerland), each followed by the result it leaves when it names one, counted on from `before`;
 * what no stage takes stays under the section's own title, last. Without stages the section as it
 * is. Each account is in exactly one block, so the stages add up to the section's total.
 */
function staged(key: IncomeSection, sec: IncomeStatementSection, before: number): Block[] {
  const stages = statements().incomeStages?.[key];
  const rows = sec.rows.map((r) => ({ account: r.account, value: r.amount }));
  if (!stages?.length) return [{ kind: 'group', title: sec.title, rows, total: sec.total }];
  const stageOf = (a: string) => {
    const listed = stages.findIndex((st) => st.accounts?.includes(a));
    return listed >= 0 ? listed : stages.findIndex((st) => st.from !== undefined && st.to !== undefined && a >= st.from && a < st.to);
  };
  const sign = ADDS.includes(key) ? 1 : -1;
  const out: Block[] = [];
  let result = before;
  stages.forEach((st, i) => {
    const own = rows.filter((r) => stageOf(r.account) === i);
    const total = roundCHF(own.reduce((n, r) => n + r.value, 0));
    out.push({ kind: 'group', title: st.title, rows: own, total });
    result = roundCHF(result + sign * total);
    if (st.then) out.push({ kind: 'sum', title: st.then, value: result });
  });
  const rest = rows.filter((r) => stageOf(r.account) < 0);
  if (rest.length) out.push({ kind: 'group', title: sec.title, rows: rest, total: roundCHF(rest.reduce((n, r) => n + r.value, 0)) });
  return out;
}

/** The Bilanz at `asOf` as blocks with every account, from the books' opening of its year or `opening`; `result` the total assets. */
function balanceView(books: Index, postings: Postings, asOf: string, names: Record<string, string>, opening = openingOfYear(books, asOf.slice(0, 4))) {
  const b = computeBalanceSheet(postings, asOf, opening, names);
  const groups = (secs: typeof b.assets): Block[] => secs.map((sec) => {
    const result = sec.rows.find((r) => r.account === '');
    return {
      kind: 'group', title: sec.title, total: sec.total,
      rows: sec.rows.filter((r) => r.account !== '').map((r) => ({ account: r.account, value: r.balance })),
      ...(result && { plain: { name: result.name, value: result.balance } }),
    };
  });
  const blocks: Block[] = [
    { kind: 'head', title: 'assets' }, ...groups(b.assets), { kind: 'sum', title: 'totalAssets', value: b.totalAssets, strong: true },
    { kind: 'head', title: 'liabilities' }, ...groups(b.liabilities), { kind: 'sum', title: 'totalLiabilities', value: b.totalLiabilities, strong: true },
  ];
  return { blocks, result: b.totalAssets, liabilities: b.totalLiabilities, balanced: b.isBalanced };
}

/** The day the books begin: 1 January of their first year with opening balances, else their first dated day. */
function booksStart(books: Index): string | undefined {
  const year = Object.keys(books.config?.openingBalances ?? {}).sort()[0];
  return year ? `${year}-01-01` : booksFirstDay({ ...books, transactions: books.transactions ?? [] });
}

/**
 * Where the prior-year figures of a Bilanz or an Erfolgsrechnung of `period` come from (Prior).
 * The books hold the prior period when they begin on or before its last day.
 */
export function priorOf(report: 'income' | 'balance', books: Index, period: Period): Prior {
  const first = booksStart(books);
  if (report === 'balance') {
    const year = Number(period.to.slice(0, 4)) - 1;
    const from = `${year}-01-01`, to = `${year}-12-31`;
    if (period.kind === 'all') return { from, to, missing: 'overlap' };
    if (first && first <= to) return { from, to, source: 'books' };
    if (Object.values(openingOfYear(books, String(year + 1))).some((v) => v !== 0)) return { from, to, source: 'opening' };
    return { from, to, missing: 'noBooks', ...(first && { first }) };
  }
  const from = yearBefore(period.from), to = yearBefore(period.to);
  if (period.kind === 'all' || to >= period.from) return { from, to, missing: 'overlap' };
  if (first && first <= to) return { from, to, source: 'books', ...(first > from && { since: first }) };
  return { from, to, missing: 'noBooks', ...(first && { first }) };
}

/** The prior year's report: from the books, or the Bilanz the opening balances of the year after it make. */
function priorView(report: 'income' | 'balance', books: Index, postings: Postings, prior: Extract<Prior, { source: unknown }>, names: Record<string, string>) {
  if (report === 'income') return incomeView(postings, prior.from, prior.to, names);
  if (prior.source === 'books') return balanceView(books, postings, prior.to, names);
  const nextYear = String(Number(prior.to.slice(0, 4)) + 1);
  return balanceView(books, [] as unknown as Postings, prior.to, names, openingOfYear(books, nextYear));
}

/** The blocks with each figure of the same blocks of the prior year beside it (same accounts, groups and sums). */
function besidePrior(blocks: Block[], prior: Block[]): Block[] {
  const groups = new Map(prior.flatMap((b) => (b.kind === 'group' ? [[b.title, b] as const] : [])));
  const sums = new Map(prior.flatMap((b) => (b.kind === 'sum' ? [[b.title, b.value] as const] : [])));
  return blocks.map((b): Block => {
    if (b.kind === 'sum') return { ...b, prior: sums.get(b.title) ?? 0 };
    if (b.kind !== 'group') return b;
    const p = groups.get(b.title);
    const byAccount = new Map(p?.rows.map((r) => [r.account, r.value]));
    return {
      ...b,
      rows: b.rows.map((r) => ({ ...r, prior: byAccount.get(r.account) ?? 0 })),
      priorTotal: p?.total ?? 0,
      ...((b.plain || p?.plain) && { plain: { name: (b.plain ?? p!.plain)!.name, value: b.plain?.value ?? 0, prior: p?.plain?.value ?? 0 } }),
    };
  });
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
  return values.map((value) => ({ value, view: reportView('income', { ...books, journalEntries: entriesOf(books).filter((e) => valueOf(e, by) === value) }, period, names, true, false) }));
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
