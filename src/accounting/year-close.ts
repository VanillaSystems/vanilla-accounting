/**
 * The year-end close and the opening of the next year, computed from the books alone: every
 * checklist item `npm run year:close` and the Jahresabschluss view show, the exchange-difference
 * entries, and the next year's opening balances. Pure, so the CLI, the API and the tests read it
 * the same way; src/books/year-close.ts gathers the inputs and writes the results.
 *
 * The journal holds entries gross, with a VAT code, as Banana imports them: the tax is never an
 * entry of its own. Banana splits it off when it books; so does the closing ledger here
 * (`vatPostings`), so the closing balances, the year's result and the next year's opening are
 * the ones Banana's own close would carry: revenue and expense net, the tax on the VAT account.
 */
import type { Index, JournalEntry, QuarterKey } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { SealReport } from '../books/seal.js';
import type { EstvRate, EstvRates } from './fx-conversion.js';
import { chfAmount, computeBalances } from './ledger.js';
import { bookBalanceNative, nativeOpening } from './reconcile-bank.js';
import { fromRappen, roundCHF, toRappen } from './rappen.js';
import { derivePeriod } from './periods.js';
import { chart, vat } from '../engines/index.js';
import type { ReturnFigures } from '../engines/return.js';

export type Books = Pick<Index, 'transactions' | 'bankStatements' | 'statementBalances'> & {
  journalEntries: JournalEntry[];
  config: NonNullable<Index['config']>;
};

const yearEnd = (year: string) => `${year}-12-31`;
const inYear = (year: string) => (date: string | undefined) => !!date && date >= `${year}-01-01` && date <= yearEnd(year);
const quartersOf = (year: string): QuarterKey[] => [1, 2, 3, 4].map((n) => `${year}-Q${n}` as QuarterKey);

// ─── Accounts by role ────────────────────────────────────────────────────────

/** The accounts the year-end books on, each the first of its candidates the chart has. */
export interface YearEndAccounts {
  /** Gewinnvortrag: the year's result is carried here when the next year opens. */
  retainedEarnings: string;
  /** Kursdifferenzen: the exchange difference of the foreign-currency accounts. */
  fxDifference: string;
  /** Abrechnungskonto MWST: the tax the VAT codes split off is posted here. */
  vatSettlement: string;
  /** Every VAT account: owed (2200, 2201) and input tax (1170, 1171). */
  vatAccounts: string[];
}

const ROLES = {
  retainedEarnings: ['2970'],
  fxDifference: ['6960', '6950'],
  vatSettlement: ['2201', '2200'],
} as const;
const VAT_ACCOUNTS = ['1170', '1171', '2200', '2201'];

export function yearEndAccounts(chart: readonly string[]): YearEndAccounts {
  const has = new Set(chart);
  const pick = (candidates: readonly string[]) => candidates.find((a) => has.has(a)) ?? candidates[0];
  const vatSettlement = pick(ROLES.vatSettlement);
  return {
    retainedEarnings: pick(ROLES.retainedEarnings),
    fxDifference: pick(ROLES.fxDifference),
    vatSettlement,
    vatAccounts: [...new Set([...VAT_ACCOUNTS.filter((a) => has.has(a)), vatSettlement])].sort(),
  };
}

// ─── The closing ledger: the journal plus the tax its VAT codes split off ───

/**
 * The tax each entry's VAT code splits off, as the entry Banana books for it: the tax moves
 * from the account that carries it (revenue on a sale, expense on a purchase) to the VAT
 * account. A sale's tax sits on the credit side, a purchase's input tax on the debit side; a
 * minus code (refund, storno) on the other one. Bezugsteuer is owed and deducted on the same
 * account, so it posts nothing. A single-leg tax correction (`-2`, empty Soll) posts against
 * its empty side and so balances it.
 */
export function vatPostings(entries: readonly JournalEntry[], vatAccount: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of entries) {
    const info = e.vatCode ? vat().codes.parse(e.vatCode) : null;
    const line = vat().vatLine(e);
    if (!info || !line || line.tax === 0 || info.acquisitionZiffer) continue;
    const owed = !!(info.revenueZiffer || info.correctionZiffer);
    if (!owed && !info.inputTaxZiffer) continue;
    const amount = Math.abs(line.tax);
    // The side that carries the tax: credit for a sale, debit for a purchase; a minus code swaps it.
    const onCredit = owed !== info.isNegative;
    const carrier = onCredit ? e.accountCredit : e.accountDebit;
    // Tax leaves the carrier: a credit carrier is debited, a debit carrier credited.
    const [accountDebit, accountCredit] = onCredit ? [carrier, vatAccount] : [vatAccount, carrier];
    out.push({
      id: `vat:${e.id}`,
      transactionRef: e.transactionRef,
      date: e.date,
      accountDebit,
      accountCredit,
      amount,
      description: `MWST ${e.vatCode} ${e.id}`,
    });
  }
  return out;
}

export interface ClosingLedger {
  year: string;
  /** Each account's balance on 31.12. in its natural direction (assets and expenses debit, the rest credit). */
  balances: Record<string, number>;
  /** Revenue minus expense of classes 3 to 8: profit positive. */
  result: number;
  totalAssets: number;
  /** Liabilities and equity, the result not yet included. */
  totalLiabilities: number;
  /** totalAssets − totalLiabilities − result: zero when the books balance. */
  residual: number;
  causes: DifferenceCause[];
}

/**
 * Why Aktiven and Passiven differ (Banana: "Differenzen in der Eröffnung", doc node 7219).
 * Each names the entries or accounts to look at; none is absorbed into a rounding account.
 */
export type DifferenceCause =
  | { code: 'openingUnbalanced'; amount: number }
  /** `amount` is what they put between Aktiven and Passiven + result. */
  | { code: 'oneLeg'; entryIds: string[]; amount: number }
  | { code: 'outsideStatements'; account: string; amount: number }
  | { code: 'notInChart'; account: string; amount: number };

const side = (account: string) => chart().sideOf(account);
const isDebitNormal = (account: string) => chart().isDebitNormal(account);
const isBalanceSheet = (account: string) => side(account) === 'assets' || side(account) === 'liabilities';
const isProfitAndLoss = (account: string) => side(account) === 'result';

/** The year's ledger as Banana would close it: opening + the year's entries + their VAT postings. */
export function closingLedger(books: Books, year: string, chart: readonly string[], accounts: YearEndAccounts): ClosingLedger {
  const opening = books.config.openingBalances?.[year] ?? {};
  const entries = books.journalEntries.filter((e) => inYear(year)(e.date));
  const vat = vatPostings(entries, accounts.vatSettlement);
  const rows = computeBalances([...entries, ...vat], `${year}-01-01`, yearEnd(year), opening, isDebitNormal);
  const balances: Record<string, number> = {};
  for (const r of rows) if (toRappen(r.balance) !== 0) balances[r.account] = r.balance;

  let assets = 0, liabilities = 0, result = 0;
  for (const [account, balance] of Object.entries(balances)) {
    const rappen = toRappen(balance);
    if (side(account) === 'assets') assets += rappen;
    else if (side(account) === 'liabilities') liabilities += rappen;
    else if (isProfitAndLoss(account)) result += isDebitNormal(account) ? -rappen : rappen;
  }
  const residual = assets - liabilities - result;

  const causes: DifferenceCause[] = [];
  let openAssets = 0, openLiabilities = 0;
  for (const [account, value] of Object.entries(opening)) {
    if (side(account) === 'assets') openAssets += toRappen(value);
    else if (side(account) === 'liabilities') openLiabilities += toRappen(value);
  }
  if (openAssets !== openLiabilities) causes.push({ code: 'openingUnbalanced', amount: fromRappen(openAssets - openLiabilities) });
  // A booking of several lines (Banana's split entry) has one-leg lines that balance under its ref.
  const oneLeg = new Map<string, { effect: number; ids: string[] }>();
  for (const p of [...entries, ...vat]) {
    const chf = toRappen(chfAmount(p));
    const effect = (p.accountDebit === '' ? chf : 0) - (p.accountCredit === '' ? chf : 0);
    if (!effect) continue;
    const ref = oneLeg.get(p.transactionRef) ?? { effect: 0, ids: [] };
    ref.effect += effect;
    ref.ids.push(p.id.replace(/^vat:/, ''));
    oneLeg.set(p.transactionRef, ref);
  }
  // Lines that balance across refs (a payout booked over several refs) leave no difference.
  const unbalanced = [...oneLeg.values()].filter((r) => r.effect !== 0);
  if (unbalanced.reduce((s, r) => s + r.effect, 0) !== 0) causes.push({ code: 'oneLeg', entryIds: [...new Set(unbalanced.flatMap((r) => r.ids))], amount: fromRappen(-unbalanced.reduce((s, r) => s + r.effect, 0)) });
  const inChart = new Set(chart);
  for (const [account, balance] of Object.entries(balances)) {
    if (account === '') continue;
    if (!isBalanceSheet(account) && !isProfitAndLoss(account)) causes.push({ code: 'outsideStatements', account, amount: balance });
    else if (chart.length && !inChart.has(account)) causes.push({ code: 'notInChart', account, amount: balance });
  }
  return {
    year,
    balances,
    result: fromRappen(result),
    totalAssets: fromRappen(assets),
    totalLiabilities: fromRappen(liabilities),
    residual: fromRappen(residual),
    causes,
  };
}

// ─── Exchange difference (Kursdifferenz) ─────────────────────────────────────

/** A foreign-currency account the year-end revalues: a bank account of the manifest not in CHF. */
export type ForeignAccount = Pick<LedgerBankAccount, 'account' | 'currency' | 'label'>;

/**
 * An account that books in one currency, not CHF. An account the manifest names in several
 * currencies (a shareholder's current account paid in CHF, EUR and USD) holds CHF: its entries
 * are converted when booked, and it has no single native balance to revalue.
 */
export function foreignAccounts(bankAccounts: readonly LedgerBankAccount[]): ForeignAccount[] {
  const byAccount = new Map<string, LedgerBankAccount[]>();
  for (const b of bankAccounts) byAccount.set(b.account, [...(byAccount.get(b.account) ?? []), b]);
  return [...byAccount.values()]
    .filter((bs) => bs[0].currency !== 'CHF' && bs.every((b) => b.currency === bs[0].currency))
    .map(([b]) => ({ account: b.account, currency: b.currency, label: b.label }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

/** The id (and ref) of the year-end's own revaluation entry of one account: rerunning replaces it. */
export const revaluationId = (year: string, account: string) => `yc-${year}-fx-${account}`;
const isRevaluationOf = (year: string) => (e: JournalEntry) => e.origin === 'year-close' && e.id.startsWith(`yc-${year}-fx-`);

export type Revaluation = ForeignAccount & {
  /** The balance on 31.12. in the account's own currency. */
  native: number;
  /** The CHF balance before this year's revaluation entry. */
  bookChf: number;
  /** The CHF of this year's revaluation entry already booked, signed as it adds to the account. */
  booked: number;
} & (
  | { status: 'no-rate' }
  /** `difference` = target − bookChf: positive a gain, negative a loss. */
  | { status: 'to-book' | 'booked'; rate: EstvRate; targetChf: number; difference: number }
);

/**
 * Each foreign account's native balance on 31.12. × the ESTV sell rate of 31.12., against its
 * CHF book value. The year's own revaluation entries are left out of the book value, so the
 * preview is the same before and after booking, and a rerun after a change books the new
 * difference in their place.
 */
export function revaluations(books: Books, year: string, foreign: readonly ForeignAccount[], rates: EstvRates): Revaluation[] {
  const own = isRevaluationOf(year);
  const others = books.journalEntries.filter((e) => !own(e));
  const ownEntries = books.journalEntries.filter(own);
  const opening = books.config.openingBalances?.[year] ?? {};
  return foreign.map((f) => {
    const native = bookBalanceNative(others, f.account, f.currency, year, yearEnd(year), nativeOpening(books, f.account, f.currency, year));
    const chf = computeBalances(others, `${year}-01-01`, yearEnd(year), { [f.account]: opening[f.account] ?? 0 }, isDebitNormal).find((b) => b.account === f.account)?.balance ?? (opening[f.account] ?? 0);
    const bookChf = roundCHF(chf);
    const booked = fromRappen(ownEntries.filter((e) => e.id === revaluationId(year, f.account))
      .reduce((s, e) => s + (e.accountDebit === f.account ? toRappen(e.amount) : -toRappen(e.amount)), 0));
    const base = { ...f, native, bookChf, booked };
    const rate = rates.yearEnd(f.currency, year);
    if (!rate) return { ...base, status: 'no-rate' as const };
    const targetChf = roundCHF(native * rate.rate);
    const difference = roundCHF(targetChf - bookChf);
    return { ...base, rate, targetChf, difference, status: toRappen(difference) === toRappen(booked) ? 'booked' as const : 'to-book' as const };
  });
}

/** The revaluation entries for these rows: one per account with a difference, dated 31.12., no VAT. */
export function revaluationEntries(year: string, rows: readonly Revaluation[], fxAccount: string): JournalEntry[] {
  return rows.flatMap((r) => {
    if (r.status === 'no-rate' || toRappen(r.difference) === 0) return [];
    const gain = r.difference > 0;
    const id = revaluationId(year, r.account);
    return [{
      id,
      transactionRef: id,
      date: yearEnd(year),
      accountDebit: gain ? r.account : fxAccount,
      accountCredit: gain ? fxAccount : r.account,
      amount: Math.abs(r.difference),
      description: `Kursdifferenz ${r.label} per 31.12.${year}: ${r.currency} ${r.native.toFixed(2)} × ${r.rate.rate} = CHF ${r.targetChf.toFixed(2)} (Buchwert ${r.bookChf.toFixed(2)})`,
      origin: 'year-close' as const,
    }];
  });
}

/** Replaces the year's revaluation entries with `entries`: running it twice changes nothing. */
export function applyRevaluation(books: Books, year: string, entries: readonly JournalEntry[]): void {
  const own = isRevaluationOf(year);
  books.journalEntries = [...books.journalEntries.filter((e) => !own(e)), ...entries];
}

// ─── VAT closing check ───────────────────────────────────────────────────────

export interface VatQuarter {
  quarter: QuarterKey;
  /** The payable tax of the return as filed (Ziffer 500 − 510); undefined when it is not filed. */
  filed?: number;
  /** The payable tax today's books declare for it, corrections included (form 0535 when filed). */
  books: number;
  /** books − filed: what a Korrekturabrechnung (0535) still has to declare. */
  correction: number;
}

export interface VatCheck {
  quarters: VatQuarter[];
  /** VAT owed at 1.1. (owed accounts minus input-tax accounts), from the opening balances. */
  opening: number;
  /** The tax of the year's entries, as their codes post it to the VAT account. */
  booked: number;
  /** Paid to (positive) or refunded by the ESTV: the year's entries on the VAT accounts. */
  paid: number;
  /** Owed at 31.12.: opening + booked − paid. */
  owed: number;
  /** What should still be owed at 31.12.: the fourth quarter (as the books declare it) and any quarter not filed yet. */
  expected: number;
  /** booked minus the returns' payable tax: Rappen rounding per entry, and corrections of earlier years. */
  rounding: number;
  /** owed − expected − rounding: a payment too much or missing, or a correction (0535) not paid in the year. */
  unexplained: number;
}

export function vatCheck(books: Books, year: string, filed: readonly ReturnFigures[], accounts: YearEndAccounts): VatCheck {
  const owedSign = (account: string) => (side(account) === 'liabilities' ? 1 : -1);
  const group = new Set(accounts.vatAccounts);
  const opening = fromRappen(accounts.vatAccounts.reduce((s, a) => s + owedSign(a) * toRappen(books.config.openingBalances?.[year]?.[a] ?? 0), 0));
  const entries = books.journalEntries.filter((e) => inYear(year)(e.date));
  // Effect on the amount owed: a credit to a VAT account raises it, a debit lowers it.
  const effect = (es: readonly JournalEntry[]) => fromRappen(es.reduce((s, e) =>
    s + (group.has(e.accountCredit) ? toRappen(e.amount) : 0) - (group.has(e.accountDebit) ? toRappen(e.amount) : 0), 0));
  const booked = effect(vatPostings(entries, accounts.vatSettlement));
  const paid = -effect(entries);
  const owed = roundCHF(opening + booked - paid);
  const adjustments = books.config.vatAdjustments ?? [];
  const quarters = quartersOf(year).map((quarter): VatQuarter => {
    const fromBooks = vat().figures(books.journalEntries, quarter, adjustments).payable;
    const asFiled = filed.find((f) => f.period === quarter);
    const filedPayable = asFiled ? roundCHF((asFiled.ziffern['500'] ?? 0) - (asFiled.ziffern['510'] ?? 0)) : undefined;
    return { quarter, filed: filedPayable, books: fromBooks, correction: roundCHF(fromBooks - (filedPayable ?? 0)) };
  });
  // Every return filed in the year is paid in the year; the fourth quarter, and any quarter not filed yet, is still owed.
  const expected = roundCHF(quarters.reduce((s, q, i) => s + (i === 3 || q.filed === undefined ? q.books : 0), 0));
  const rounding = roundCHF(booked - quarters.reduce((s, q) => s + q.books, 0));
  return { quarters, opening, booked, paid, owed, expected, rounding, unexplained: roundCHF(owed - expected - rounding) };
}

// ─── Guided year-end entries ─────────────────────────────────────────────────

/** An entry the owner or the accountant may need at the year-end, as a prefilled form. Blank accounts are the user's pick. */
export interface EntryTemplate {
  id: string;
  accountDebit: string;
  accountCredit: string;
  vatCode?: string;
  /** Dated in the next year (after the shareholders' resolution), not on 31.12. */
  nextYear?: boolean;
  /** A proposed amount the books computed (open invoices); absent: the user's figure. */
  amount?: number;
}

export const YEAR_END_TEMPLATES: readonly EntryTemplate[] = [
  { id: 'depreciation', accountDebit: '6800', accountCredit: '' },
  { id: 'accruedExpense', accountDebit: '', accountCredit: '2300' },
  { id: 'prepaidExpense', accountDebit: '1300', accountCredit: '' },
  { id: 'accruedIncome', accountDebit: '1301', accountCredit: '' },
  { id: 'deferredIncome', accountDebit: '', accountCredit: '2301' },
  { id: 'provision', accountDebit: '', accountCredit: '2330' },
  { id: 'taxProvision', accountDebit: '8900', accountCredit: '2208' },
  { id: 'privateUse', accountDebit: '2451', accountCredit: '', vatCode: 'K81-B' },
  { id: 'inventoryChange', accountDebit: '', accountCredit: '' },
  { id: 'socialInsurance', accountDebit: '5700', accountCredit: '2270' },
  { id: 'doubtfulAccounts', accountDebit: '3805', accountCredit: '1109' },
];

/**
 * The profit allocation after the shareholders' resolution, dated in the new year: reserves,
 * and a dividend with the 35% Verrechnungssteuer the company owes on it. Guided, never automatic.
 */
export const PROFIT_ALLOCATION: EntryTemplate = { id: 'profitAllocation', accountDebit: '2970', accountCredit: '2950', nextYear: true };

export const WITHHOLDING_TAX_RATE = 0.35;

export interface DividendSplit { net: number; withholdingTax: number }

/** A gross dividend split into what the shareholders are paid and the 35% Verrechnungssteuer (2206). */
export function dividendSplit(gross: number): DividendSplit {
  const withholdingTax = roundCHF(gross * WITHHOLDING_TAX_RATE);
  return { net: roundCHF(gross - withholdingTax), withholdingTax };
}

/**
 * Invoices still open on 31.12. as receivables (Debitoren, ADR 0010): proposed only when the
 * year has open invoices, credited to the revenue account, without a VAT code. On the cash
 * basis their VAT is declared when the customer pays; the next year reverses the entry.
 */
export const RECEIVABLES: EntryTemplate = { id: 'receivables', accountDebit: '1100', accountCredit: '' };

/** The receivables entry of `year` carries this id, so the opening of the next year finds it. */
export const receivablesEntryId = (year: string) => `yc-${year}-receivables`;

/**
 * The entry that reverses `year`'s receivables on 1.1. of the next year (ADR 0010): the revenue
 * is booked again, with its VAT, when the customer pays. Undefined when no receivables entry was booked.
 */
export function receivablesReversal(entries: readonly JournalEntry[], year: string): JournalEntry | undefined {
  const booked = entries.find((x) => x.id === receivablesEntryId(year));
  if (!booked) return undefined;
  const next = String(Number(year) + 1);
  const id = `yc-${next}-receivables-reversal`;
  return {
    id,
    transactionRef: id,
    date: `${next}-01-01`,
    accountDebit: booked.accountCredit,
    accountCredit: booked.accountDebit,
    amount: booked.amount,
    description: `Auflösung Debitoren per 31.12.${year} (${booked.transactionRef})`,
    origin: 'year-close',
  };
}

/** An invoice the customer still owed on 31.12.: issued by then, not cancelled by then, less what was paid and credited by then. */
export interface OpenInvoice {
  number: string;
  customer: string;
  date: string;
  currency: string;
  open: number;
  /** In CHF at the ESTV rate of 31.12. (the latest one published before, while 31.12. has none yet). */
  chf: number;
}

export interface Receivables {
  invoices: OpenInvoice[];
  /** Sum of the CHF amounts. */
  total: number;
  /** The revenue account the entry credits: invoicing.revenueAccount. */
  revenueAccount?: string;
}

export type TemplateState = 'done' | 'na';

/** year-close/<YYYY>.json in the workspace: what the user marked, and when the year closed and opened. */
export interface YearCloseState {
  year: string;
  templates: Record<string, TemplateState>;
  closedAt?: string;
  openedAt?: string;
}

export const emptyState = (year: string): YearCloseState => ({ year, templates: {} });

// ─── The checklist ───────────────────────────────────────────────────────────

/** One reason an item is not done, with what to show: the UI says it in the user's language, the CLI in English. */
export type Problem =
  | { code: 'q4NotFiled'; quarter: QuarterKey }
  | { code: 'notClosed'; quarter: QuarterKey }
  | { code: 'unsealed'; quarter: QuarterKey }
  | { code: 'sealBroken'; quarter: QuarterKey; problem: string }
  | { code: 'noYearEndBalance'; account: string; label: string }
  | { code: 'balanceDiffers'; account: string; label: string; currency: string; bank: number; book: number; date: string }
  | { code: 'statementGap'; account: string; label: string; from: string; to: string }
  | { code: 'unbooked'; count: number; refs: string[] }
  | { code: 'doctor'; label: string }
  | { code: 'noRate'; currency: string }
  | { code: 'fxToBook'; account: string; difference: number }
  | { code: 'yearLocked' }
  | { code: 'undecided'; templates: string[] }
  | { code: 'unbalanced'; residual: number };

export type CheckStatus = 'ok' | 'fail' | 'warn';

export interface Check {
  id: 'q4Filed' | 'quartersSealed' | 'bankReconciled' | 'statementsComplete' | 'allBooked' | 'doctor';
  status: CheckStatus;
  problems: Problem[];
}

/** A bank's balance at a date, in the account's own currency, as its statement shows it. */
export interface BankBalance { account: string; date: string; amount: number; source: string }

export interface YearCloseInput {
  year: string;
  books: Books;
  chart: readonly string[];
  bankAccounts: readonly LedgerBankAccount[];
  /** Bank-side balances: statement PDFs and camt.053 closing balances. */
  bankBalances: readonly BankBalance[];
  filed: readonly ReturnFigures[];
  seals: SealReport;
  /** The failed checks of `npm run doctor` for the workspace. */
  doctor: readonly string[];
  rates: EstvRates;
  state: YearCloseState;
  /** Absent or empty: no invoice was open on 31.12. (or the company writes none). */
  receivables?: Receivables;
}

export interface YearClose {
  year: string;
  accounts: YearEndAccounts;
  closedThrough?: string;
  /** Closed: config.closedThrough reaches 31.12. and the close is recorded. */
  closed: boolean;
  opened: boolean;
  checks: Check[];
  revaluations: Revaluation[];
  vat: VatCheck;
  templates: Array<EntryTemplate & { state?: TemplateState }>;
  receivables: Receivables;
  ledger: ClosingLedger;
  /** Why "Jahr abschliessen" refuses; empty when it may run. */
  blockers: Problem[];
  state: YearCloseState;
}

const status = (problems: readonly Problem[], failing: CheckStatus = 'fail'): CheckStatus => (problems.length ? failing : 'ok');

function preconditions(input: YearCloseInput): Check[] {
  const { year, books, seals } = input;
  const closedThrough = books.config.closedThrough;
  const [q1, q2, q3, q4] = quartersOf(year);

  const filed = input.filed.some((f) => f.period === q4) ? [] : [{ code: 'q4NotFiled' as const, quarter: q4 }];

  const sealProblems: Problem[] = [];
  for (const c of seals.checks) if (c.status === 'broken') sealProblems.push({ code: 'sealBroken', quarter: c.quarter, problem: c.problem });
  const sealed = new Set(seals.checks.filter((c) => c.status === 'intact').map((c) => c.quarter));
  const dates = [...books.transactions.map((t) => t.date), ...books.journalEntries.map((e) => e.date)];
  for (const q of [q1, q2, q3]) {
    const { from, to } = derivePeriod(q)!;
    if (!closedThrough || closedThrough < to) sealProblems.push({ code: 'notClosed', quarter: q });
    else if (!sealed.has(q) && dates.some((d) => d >= from && d <= to)) sealProblems.push({ code: 'unsealed', quarter: q });
  }

  const rows = reconciliationAtYearEnd(input);
  const bankProblems: Problem[] = rows.flatMap((r): Problem[] => r.bank === undefined
    ? [{ code: 'noYearEndBalance', account: r.account, label: r.label }]
    : toRappen(r.bank) === toRappen(r.book) ? [] : [{ code: 'balanceDiffers', account: r.account, label: r.label, currency: r.currency, bank: r.bank, book: r.book, date: yearEnd(year) }]);

  const gaps = statementGaps(input);

  const booked = new Set(books.journalEntries.map((e) => e.transactionRef.split('~')[0]));
  const unbookedRefs = books.transactions.filter((t) => inYear(year)(t.date) && !booked.has(t.ref) && !booked.has(t.ref.split('~')[0])).map((t) => t.ref);
  const unbooked: Problem[] = unbookedRefs.length ? [{ code: 'unbooked', count: unbookedRefs.length, refs: unbookedRefs.slice(0, 8) }] : [];

  const doctor = input.doctor.map((label): Problem => ({ code: 'doctor', label }));

  return [
    { id: 'q4Filed', status: status(filed), problems: filed },
    { id: 'quartersSealed', status: status(sealProblems), problems: sealProblems },
    { id: 'bankReconciled', status: status(bankProblems), problems: bankProblems },
    { id: 'statementsComplete', status: status(gaps), problems: gaps },
    { id: 'allBooked', status: status(unbooked), problems: unbooked },
    { id: 'doctor', status: status(doctor), problems: doctor },
  ];
}

interface YearEndRow { account: string; label: string; currency: string; book: number; bank?: number }

/** Every account with bank statements: its book balance on 31.12. in its own currency, and the bank's. */
function reconciliationAtYearEnd({ year, books, bankAccounts, bankBalances }: YearCloseInput): YearEndRow[] {
  const own = isRevaluationOf(year);
  const entries = books.journalEntries.filter((e) => !own(e));
  const seen = new Set<string>();
  return bankAccounts.filter((b) => b.statements && !seen.has(b.account) && seen.add(b.account)).map((b) => {
    const book = bookBalanceNative(entries, b.account, b.currency, year, yearEnd(year), nativeOpening(books, b.account, b.currency, year));
    const bank = bankBalances.find((x) => x.account === b.account && x.date === yearEnd(year))?.amount;
    return { account: b.account, label: b.label, currency: b.currency, book, bank };
  });
}

/** Stretches of the year no statement of an account covers, from 1.1. (or its first statement, for an account opened during the year). */
function statementGaps({ year, books, bankAccounts }: YearCloseInput): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const b of bankAccounts) {
    if (!b.statements || seen.has(b.account)) continue;
    seen.add(b.account);
    const ranges = books.bankStatements
      .filter((s) => s.bank === b.bank && (!s.currency || s.currency === b.currency) && s.toDate >= `${year}-01-01` && s.fromDate <= yearEnd(year))
      .map((s) => [s.fromDate, s.toDate] as const)
      .sort(([a], [c]) => a.localeCompare(c));
    const openedThisYear = !books.config.openingBalances?.[year]?.[b.account] && !books.config.openingBalancesNative?.[year]?.[b.account];
    let covered = openedThisYear && ranges.length ? dayBefore(ranges[0][0]) : dayBefore(`${year}-01-01`);
    for (const [from, to] of ranges) {
      if (from > nextDay(covered)) out.push({ code: 'statementGap', account: b.account, label: b.label, from: nextDay(covered), to: dayBefore(from) });
      if (to > covered) covered = to;
    }
    if (covered < yearEnd(year)) out.push({ code: 'statementGap', account: b.account, label: b.label, from: nextDay(covered), to: yearEnd(year) });
  }
  return out;
}

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nextDay = (date: string) => shift(date, 1);
const dayBefore = (date: string) => shift(date, -1);

/** Every item of the year's close, computed from the books. */
export function yearClose(input: YearCloseInput): YearClose {
  const { year, books, state } = input;
  const accounts = yearEndAccounts(input.chart);
  const closedThrough = books.config.closedThrough;
  const locked = !!closedThrough && closedThrough >= yearEnd(year);
  const checks = preconditions(input);
  const reval = revaluations(books, year, foreignAccounts(input.bankAccounts), input.rates);
  const ledger = closingLedger(books, year, input.chart, accounts);
  const receivables = input.receivables ?? { invoices: [], total: 0 };
  const proposed = receivables.invoices.length
    ? [{ ...RECEIVABLES, accountCredit: receivables.revenueAccount ?? '', amount: receivables.total }]
    : [];
  const templates = [...YEAR_END_TEMPLATES, ...proposed].map((t) => ({ ...t, state: state.templates[t.id] }));

  const blockers: Problem[] = checks.flatMap((c) => c.problems);
  for (const r of reval) {
    if (r.status === 'no-rate') blockers.push({ code: 'noRate', currency: r.currency });
    else if (r.status === 'to-book') blockers.push(locked ? { code: 'yearLocked' } : { code: 'fxToBook', account: r.account, difference: roundCHF(r.difference - r.booked) });
  }
  const undecided = templates.filter((t) => !t.state).map((t) => t.id);
  if (undecided.length) blockers.push({ code: 'undecided', templates: undecided });
  if (toRappen(ledger.residual) !== 0) blockers.push({ code: 'unbalanced', residual: ledger.residual });

  return {
    year,
    accounts,
    closedThrough,
    closed: locked && !!state.closedAt,
    opened: !!state.openedAt,
    checks,
    revaluations: reval,
    vat: vatCheck(books, year, input.filed, accounts),
    templates,
    receivables,
    ledger,
    blockers: dedupe(blockers),
    state,
  };
}

const dedupe = (problems: Problem[]): Problem[] => {
  const seen = new Set<string>();
  return problems.filter((p) => !seen.has(JSON.stringify(p)) && !!seen.add(JSON.stringify(p)));
};

// ─── Opening the next year ───────────────────────────────────────────────────

export interface Opening {
  /** The year that opens. */
  year: string;
  /** config.openingBalances[year]: balance-sheet accounts in their natural direction, CHF. */
  balances: Record<string, number>;
  /** config.openingBalancesNative[year]: the foreign accounts' closing balance in their currency. */
  native: Record<string, { amount: number; currency: string }>;
  /** The closed year's result, carried to retained earnings. */
  result: number;
  retainedEarnings: string;
  totalAssets: number;
  totalLiabilities: number;
  /** totalAssets − totalLiabilities: zero when the opening balances. */
  residual: number;
  /** Why the opening does not balance, or why a foreign account's CHF is not its native × the 31.12. rate. */
  causes: Array<DifferenceCause | { code: 'notRevalued'; account: string; currency: string; expected: number; actual: number }>;
}

/**
 * The next year's opening from the closed year's closing ledger: the balance-sheet accounts
 * carried, profit and loss reset, the result added to retained earnings (profit allocation is a
 * later entry of its own). The closing exchange rates become the opening rates: a foreign
 * account opens with its native closing balance, and its CHF is native × the 31.12. rate once
 * the Kursdifferenz is booked.
 */
export function openingOf(closing: ClosingLedger, books: Books, foreign: readonly ForeignAccount[], rates: EstvRates, accounts: YearEndAccounts): Opening {
  const year = String(+closing.year + 1);
  const balances: Record<string, number> = {};
  for (const [account, balance] of Object.entries(closing.balances)) if (isBalanceSheet(account)) balances[account] = balance;
  const re = accounts.retainedEarnings;
  const carried = roundCHF((balances[re] ?? 0) + closing.result);
  if (toRappen(carried) === 0) delete balances[re]; else balances[re] = carried;

  const causes: Opening['causes'] = [...closing.causes];
  const native: Opening['native'] = {};
  for (const f of foreign) {
    const amount = bookBalanceNative(books.journalEntries, f.account, f.currency, closing.year, yearEnd(closing.year), nativeOpening(books, f.account, f.currency, closing.year));
    native[f.account] = { amount, currency: f.currency };
    const rate = rates.yearEnd(f.currency, closing.year);
    const actual = balances[f.account] ?? 0;
    if (rate && toRappen(roundCHF(amount * rate.rate)) !== toRappen(actual)) {
      causes.push({ code: 'notRevalued', account: f.account, currency: f.currency, expected: roundCHF(amount * rate.rate), actual });
    }
  }

  let assets = 0, liabilities = 0;
  for (const [account, value] of Object.entries(balances)) {
    if (side(account) === 'assets') assets += toRappen(value);
    else liabilities += toRappen(value);
  }
  const sorted = Object.fromEntries(Object.entries(balances).sort(([a], [b]) => a.localeCompare(b)));
  return {
    year,
    balances: sorted,
    native,
    result: closing.result,
    retainedEarnings: re,
    totalAssets: fromRappen(assets),
    totalLiabilities: fromRappen(liabilities),
    residual: fromRappen(assets - liabilities),
    causes,
  };
}

/** What changes in config.openingBalances[year] against what is there: for "update opening balances". */
export function openingChanges(before: Record<string, number> | undefined, after: Record<string, number>): Array<{ account: string; before: number; after: number }> {
  const accounts = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  return accounts
    .map((account) => ({ account, before: before?.[account] ?? 0, after: after[account] ?? 0 }))
    .filter((c) => toRappen(c.before) !== toRappen(c.after));
}
