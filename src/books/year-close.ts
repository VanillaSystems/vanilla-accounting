/**
 * The year-end close and the next year's opening on a workspace: gathers what
 * src/accounting/year-close.ts computes from (books, chart, bank balances, filed returns, seals,
 * doctor, ESTV rates, the close record), and writes what it decides. `npm run year:close`,
 * `npm run year:open` and the API's Jahresabschluss routes all go through here.
 *
 * The close record is filings/<year>/year-close.json: which guided entries were done or are not
 * needed, and when the year closed and opened. It sits next to the year's returns and seals.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalEntry, QuarterKey } from '../types/index.js';
import { commitPaths, repositoryAt } from '../workspace/git.js';
import type { Workspace } from '../workspace/workspace.js';
import { accountsOf, filedReturnsOf } from '../workspace/reads.js';
import { readBankStatements } from '../workspace/bank-statements.js';
import { parseStatementBalances } from '../parsers/statement-balances.js';
import { estvRates, type EstvRates } from '../accounting/fx-conversion.js';
import { readEstvRateTable } from '../accounting/fx-rates.js';
import {
  applyRevaluation, closingLedger, emptyState, foreignAccounts, openingChanges, openingOf, revaluationEntries,
  yearClose, yearEndAccounts, YEAR_END_TEMPLATES, PROFIT_ALLOCATION, RECEIVABLES, receivablesEntryId, receivablesReversal,
  type BankBalance, type Opening, type Receivables, type TemplateState, type YearClose, type YearCloseState,
} from '../accounting/year-close.js';
import { roundCHF } from '../accounting/rappen.js';
import { loadInvoices } from '../invoices/store.js';
import { liveInvoices, openOn } from '../invoices/rules.js';
import { workspaceChecks } from '../workspace/checks.js';
import { loadBooks, moduleActor, PERSON, saveBooks, sealsOf, update, type Books } from './store.js';
import { writeSeal } from './seal.js';
import { nextManualRef } from './refs.js';

export const stateFile = (ws: Workspace, year: string): string => join(ws.paths.filings, year, 'year-close.json');

export function readState(ws: Workspace, year: string): YearCloseState {
  const file = stateFile(ws, year);
  if (!existsSync(file)) return emptyState(year);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<YearCloseState>;
  return { year, templates: raw.templates ?? {}, closedAt: raw.closedAt, openedAt: raw.openedAt };
}

function writeState(ws: Workspace, state: YearCloseState): void {
  const file = stateFile(ws, state.year);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** The bank's own balances: the month-end balances read off statement PDFs, and every camt.053 closing balance. */
export function bankBalances(ws: Workspace, books: Books): BankBalance[] {
  const fromPdf = (books.statementBalances ?? []).map((b) => ({ account: b.account, date: b.date, amount: b.amount, source: b.sourceFile }));
  const fromCamt = readBankStatements(ws).flatMap((f) => f.status !== 'read' ? [] : parseStatementBalances(f.statement, f.account.bank, f.file)
    .filter((s) => s.type === 'CLBD' && s.currency === f.account.currency)
    .map((s) => ({ account: f.account.account, date: s.date, amount: s.amount, source: s.sourceFile })));
  return [...fromPdf, ...fromCamt];
}

const chartOf = (ws: Workspace): string[] => (accountsOf(ws) as Array<{ number?: string }>).flatMap((a) => (a.number ? [String(a.number)] : []));

/** The invoices open on 31.12. of `year`, in CHF at the ESTV rate of that day (or the latest before it). */
export function receivablesOf(ws: Workspace, year: string, rates: EstvRates): Receivables {
  const end = `${year}-12-31`;
  const invoices = liveInvoices(loadInvoices(ws));
  const open = invoices.flatMap((inv) => {
    const amount = inv.status === 'issued' ? openOn(inv, invoices, end) : 0;
    if (inv.status !== 'issued' || amount === 0) return [];
    const rate = inv.currency === 'CHF' ? 1 : rates.on(inv.currency, end)?.rate ?? 0;
    return [{ number: inv.number, customer: inv.customer.name, date: inv.date, currency: inv.currency, open: amount, chf: roundCHF(amount * rate) }];
  });
  return { invoices: open, total: roundCHF(open.reduce((s, i) => s + i.chf, 0)), revenueAccount: ws.invoicing?.revenueAccount };
}

/** `ratesDir` points at another reference/ (a test, a rehearsal with a stand-in 31.12. rate). */
export function ratesOf(ratesDir?: string): EstvRates {
  return estvRates(ratesDir ? readEstvRateTable(ratesDir) : readEstvRateTable());
}

/** Everything the close of `year` shows, computed from the workspace as it is now. */
export function yearCloseOf(ws: Workspace, year: string, rates: EstvRates = ratesOf(), books: Books = loadBooks(ws)): YearClose {
  return yearClose({
    year,
    books,
    chart: chartOf(ws),
    bankAccounts: ws.bankAccounts,
    bankBalances: bankBalances(ws, books),
    filed: filedReturnsOf(ws, year),
    seals: sealsOf(books),
    doctor: workspaceChecks(ws).flatMap((r) => (r.status === 'fail' ? [r.label] : [])),
    rates,
    state: readState(ws, year),
    receivables: receivablesOf(ws, year, rates),
  });
}

export class YearCloseRefused extends Error {}

const assertYearOpen = (books: Books, year: string, what: string) => {
  const closedThrough = books.config.closedThrough;
  if (closedThrough && closedThrough >= `${year}-12-31`) throw new YearCloseRefused(`${year} is closed through ${closedThrough}: ${what}`);
};

/**
 * Books (or rebooks) the Kursdifferenz of every foreign account on 31.12.: the year's own
 * revaluation entries are replaced, never added to. Returns the entries now booked.
 */
export function bookRevaluation(ws: Workspace, year: string, rates: EstvRates = ratesOf()): JournalEntry[] {
  const books = loadBooks(ws);
  assertYearOpen(books, year, 'the Kursdifferenz can no longer be dated 31.12.');
  const rows = yearCloseOf(ws, year, rates, books).revaluations;
  const missing = rows.filter((r) => r.status === 'no-rate').map((r) => r.currency);
  if (missing.length) throw new YearCloseRefused(`The ESTV rate of 31.12.${year} is not published yet for ${[...new Set(missing)].join(', ')}: npm run fetch-rates -- --year ${year} once it is.`);
  const entries = revaluationEntries(year, rows, yearEndAccounts(chartOf(ws)).fxDifference);
  update(books, moduleActor('year-close'), (b) => applyRevaluation(b, year, entries));
  saveBooks(ws, books);
  return entries;
}

export function markTemplate(ws: Workspace, year: string, id: string, state: TemplateState | null): YearCloseState {
  const known = [...YEAR_END_TEMPLATES, RECEIVABLES].map((t) => t.id);
  if (!known.includes(id)) throw new YearCloseRefused(`Unknown year-end entry "${id}". Known: ${known.join(', ')}`);
  const current = readState(ws, year);
  if (current.closedAt) throw new YearCloseRefused(`${year} is closed: its checklist no longer changes.`);
  const templates = { ...current.templates };
  if (state) templates[id] = state; else delete templates[id];
  const next = { ...current, templates };
  writeState(ws, next);
  return next;
}

export interface EntryInput {
  date: string;
  accountDebit: string;
  accountCredit: string;
  amount: number;
  vatCode?: string;
  description: string;
}

/**
 * A manual entry with no bank transaction behind it (an accrual, a depreciation, a profit
 * allocation): its ref is the next free M<year>-NNN, like an Eigenverbrauch rebooking. Booking
 * one from a year-end template marks the template done.
 */
export function bookEntry(ws: Workspace, input: EntryInput, template?: string): JournalEntry {
  const books = loadBooks(ws);
  const entry = update(books, PERSON, (b) => {
    const year = input.date.slice(0, 4);
    if (template === RECEIVABLES.id && b.journalEntries.some((x) => x.id === receivablesEntryId(year))) {
      throw new YearCloseRefused(`The receivables of ${year} are booked already.`);
    }
    const entry: JournalEntry = {
      id: template === RECEIVABLES.id ? receivablesEntryId(year) : randomBytes(8).toString('hex'),
      transactionRef: nextManualRef(b, year),
      date: input.date,
      accountDebit: input.accountDebit,
      accountCredit: input.accountCredit,
      amount: input.amount,
      ...(input.vatCode ? { vatCode: input.vatCode } : {}),
      description: input.description,
      origin: 'manual',
    };
    b.journalEntries.push(entry);
    return entry;
  });
  saveBooks(ws, books);
  if (template && template !== PROFIT_ALLOCATION.id) markTemplate(ws, input.date.slice(0, 4), template, 'done');
  return entry;
}

export interface CloseResult { closedThrough: string; seal: string; committed: boolean }

/**
 * "Jahr abschliessen": refuses while anything blocks; else moves config.closedThrough to 31.12.,
 * seals the fourth quarter (the others are sealed already), records the close and commits the
 * workspace when it is a git repository. Running it on a closed year only checks and records.
 */
export async function closeYear(ws: Workspace, year: string, rates: EstvRates = ratesOf(), today = new Date().toISOString().slice(0, 10)): Promise<CloseResult> {
  const books = loadBooks(ws);
  const close = yearCloseOf(ws, year, rates, books);
  if (close.blockers.length) throw new YearCloseRefused(`${year} cannot close yet: ${close.blockers.length} item(s) open.`);
  const end = `${year}-12-31`;
  if (!books.config.closedThrough || books.config.closedThrough < end) {
    books.config.closedThrough = end;
    saveBooks(ws, books);
  }
  const q4 = `${year}-Q4` as QuarterKey;
  const seal = writeSeal(ws, books, q4, today);
  const state = readState(ws, year);
  if (!state.closedAt) writeState(ws, { ...state, closedAt: today });
  const committed = await commit(ws, `Jahresabschluss ${year}: closed through ${end}, ${q4} sealed`, [ws.paths.books, join(ws.paths.filings, year)]);
  return { closedThrough: end, seal: seal.file, committed };
}

/** The next year's opening balances from the closed year: what `openYear` writes. */
export function openingFor(ws: Workspace, year: string, rates: EstvRates = ratesOf(), books: Books = loadBooks(ws)): Opening {
  const chart = chartOf(ws);
  const accounts = yearEndAccounts(chart);
  return openingOf(closingLedger(books, year, chart, accounts), books, foreignAccounts(ws.bankAccounts), rates, accounts);
}

export interface OpenResult {
  opening: Opening;
  /** What changed against opening balances already there (an update after a correction). */
  changes: Array<{ account: string; before: number; after: number }>;
  /** False when the ESTV rates do not reach into the new year yet: npm run fetch-rates -- --year <new>. */
  ratesReady: boolean;
  /** The receivables of the closed year, reversed on 1.1. (booked again on a rerun, never twice). */
  reversal?: JournalEntry;
}

/**
 * Writes the opening balances of `year`+1 from the closed `year` and reverses its receivables
 * entry on 1.1. Idempotent: a rerun after
 * the old year changed (only through corrections, its quarters are sealed) updates them.
 * Refuses an open year, and an opening whose Aktiven and Passiven differ.
 */
export async function openYear(ws: Workspace, year: string, rates: EstvRates = ratesOf(), today = new Date().toISOString().slice(0, 10)): Promise<OpenResult> {
  const state = readState(ws, year);
  const books = loadBooks(ws);
  if (!state.closedAt || !books.config.closedThrough || books.config.closedThrough < `${year}-12-31`) {
    throw new YearCloseRefused(`${year} is not closed yet: npm run year:close -- ${year} first.`);
  }
  const opening = openingFor(ws, year, rates, books);
  if (opening.residual !== 0) throw new YearCloseRefused(`The opening of ${opening.year} does not balance: Aktiven − Passiven = ${opening.residual.toFixed(2)}.`);
  const changes = openingChanges(books.config.openingBalances?.[opening.year], opening.balances);
  const reversal = receivablesReversal(books.journalEntries, year);
  update(books, moduleActor('year-close'), (b) => {
    const { config } = b;
    if (reversal) b.journalEntries = [...b.journalEntries.filter((x) => x.id !== reversal.id), reversal];
    config.openingBalances = { ...config.openingBalances, [opening.year]: opening.balances };
    const previous = config.openingBalancesNative?.[opening.year] ?? {};
    config.openingBalancesNative = { ...config.openingBalancesNative, [opening.year]: { ...previous, ...opening.native } };
  });
  saveBooks(ws, books);
  if (!state.openedAt) writeState(ws, { ...state, openedAt: today });
  const firstDay = `${opening.year}-01-01`;
  const ratesReady = foreignAccounts(ws.bankAccounts).every((f) => (rates.on(f.currency, `${opening.year}-12-31`)?.validOn ?? '') >= firstDay);
  await commit(ws, `Eröffnung ${opening.year}: opening balances from the closed ${year}`, [ws.paths.books, join(ws.paths.filings, year)]);
  return { opening, changes, ratesReady, ...(reversal ? { reversal } : {}) };
}

/**
 * Commits `paths` when the workspace is a git repository of its own (a demo inside the app's
 * repository is not); nothing else is staged or committed.
 */
async function commit(ws: Workspace, message: string, paths: string[]): Promise<boolean> {
  const repo = await repositoryAt(ws.paths.root);
  return repo ? commitPaths(repo, message, paths) : false;
}
