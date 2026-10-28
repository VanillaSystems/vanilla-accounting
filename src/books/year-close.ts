/**
 * The year-end close and the next year's opening on a workspace: gathers what
 * src/accounting/year-close.ts computes from (books, chart, bank balances, filed returns, seals,
 * doctor, ESTV rates, the close record), and writes what it decides. `npm run year:close`,
 * `npm run year:open` and the API's Jahresabschluss routes all go through here.
 *
 * The close record is filings/<year>/year-close.json: which guided entries were done or are not
 * needed, and when the year closed and opened. It sits next to the year's returns and seals.
 */
import { Refused } from '../types/refusal.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { JournalEntry, QuarterKey, StatementClosingBalance } from '../types/index.js';
import { commitExactly, repositoryAt } from '../workspace/git.js';
import { yearPaths, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import { accountsOf, filedReturnsOf } from '../workspace/reads.js';
import { readBankStatements } from '../workspace/bank-statements.js';
import { parseStatementBalances } from '../providers/camt053/statement-balances.js';
import { estvRates, type EstvRates } from '../accounting/fx-conversion.js';
import { readEstvRateTable } from '../accounting/fx-rates.js';
import {
  applyRevaluation, bookedFor, closingLedger, emptyState, foreignAccounts, openingChanges, openingOf, proofOf, revaluationEntries,
  yearClose, yearEndAccounts, yearEndTemplates, PROFIT_ALLOCATION_ID, RECEIVABLES_ID, receivablesEntryId, receivablesReversal,
  type BankBalance, type Opening, type Receivables, type TemplateState, type YearClose, type YearCloseState, type YearEndProof,
} from '../accounting/year-close.js';
import { roundCHF } from '../accounting/rappen.js';
import { filingKeyOf } from '../accounting/periods.js';
import { loadInvoices } from '../invoices/store.js';
import { liveInvoices, openOn, paymentsNamingOpen } from '../invoices/rules.js';
import { hasEvent } from './refs.js';
import { workspaceChecks } from '../workspace/checks.js';
import { closeThrough, loadBooks, moduleActor, periodLock, PERSON, saveBooks, sealsOf, update, type Books } from './store.js';
import { reconcilePendingThrough } from './reconcile.js';
import { writeSeal } from './seal.js';
import { nextManualRef } from './next-ref.js';

export const stateFile = (ws: Workspace, year: string): string => join(yearPaths(ws.paths, year).filings, 'year-close.json');

export function readState(ws: Workspace, year: string): YearCloseState {
  const file = stateFile(ws, year);
  if (!existsSync(file)) return emptyState(year);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<YearCloseState>;
  return { year, templates: raw.templates ?? {}, closedAt: raw.closedAt, openedAt: raw.openedAt, ...(raw.cashCounts && { cashCounts: raw.cashCounts }) };
}

function writeState(ws: Workspace, state: YearCloseState): void {
  const file = stateFile(ws, state.year);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** The bank's own balances: the month-end balances read off statement PDFs, every camt.053 closing balance, and the year-end confirmations a person attached (`document`, #119). */
export function bankBalances(ws: Workspace, books: Books): BankBalance[] {
  const fromPdf = (books.statementBalances ?? []).filter((b) => b.source !== 'camt').map((b) => ({ account: b.account, date: b.date, amount: b.amount, source: b.sourceFile, ...(fromYearEndDocument(b) && { document: true as const }) }));
  const fromCamt = readBankStatements(ws).flatMap((f) => f.status !== 'read' ? [] : parseStatementBalances(f.statement, f.account.bank, f.file)
    .filter((s) => s.type === 'CLBD' && s.currency === f.account.currency)
    .map((s) => ({ account: f.account.account, date: s.date, amount: s.amount, source: s.sourceFile })));
  return [...fromPdf, ...fromCamt];
}

/**
 * A bank's year-end confirmation the person attached (#119) lies in filings/<year>/year-end/; its
 * balance is a StatementClosingBalance read off a PDF like a statement's, whose `sourceFile` names
 * it under that folder. `npm run extract-balances` reads statements only and keeps these.
 */
const YEAR_END_DOCUMENTS = 'year-end';
export const fromYearEndDocument = (b: Pick<StatementClosingBalance, 'sourceFile'>): boolean => b.sourceFile.startsWith(`${YEAR_END_DOCUMENTS}/`);
const DOCUMENT_TYPES = /\.(pdf|png|jpe?g)$/i;

/** The money account of the manifest `account` books on, if 31.12. needs `proof` from it. */
function accountNeeding(ws: Workspace, account: string, proof: YearEndProof): LedgerBankAccount {
  const found = ws.bankAccounts.find((a) => a.account === account && proofOf(a.role) === proof);
  if (!found) throw new YearCloseRefused({ code: 'yearEndAccountUnknown', params: { account } }, `Account ${account} is no ${proof === 'bank' ? 'bank or card' : 'cash'} account of bankAccounts in belege.workspace.yaml.`);
  return found;
}

/** The year-end confirmation's file of a hand balance, if the year's books hold one for `account`. */
export function yearEndDocumentOf(ws: Workspace, year: string, account: string, books: Books = loadBooks(ws)): string | undefined {
  const b = (books.statementBalances ?? []).find((x) => x.account === account && x.date === `${year}-12-31` && fromYearEndDocument(x));
  return b && join(yearPaths(ws.paths, year).filings, b.sourceFile);
}

/**
 * A bank or card account's balance on 31.12. from the bank's year-end confirmation the person
 * attached (#119), for books without a statement covering the day. Replaces the account's hand
 * balance of the year and its document; refused while a statement states the day's balance (the
 * bank's own statement is the proof then) and once the year is closed.
 */
export function setYearEndBalance(ws: Workspace, year: string, account: string, amount: number, document: { name: string; body: Buffer }): StatementClosingBalance {
  const money = accountNeeding(ws, account, 'bank');
  const name = basename(document.name).trim();
  if (!DOCUMENT_TYPES.test(name)) throw new YearCloseRefused({ code: 'yearEndDocumentType', params: { name } }, `${name}: the confirmation must be a PDF or an image (PNG, JPG).`);
  const books = loadBooks(ws);
  assertYearOpen(books, year, 'its balances of 31.12. stay.');
  const date = `${year}-12-31`;
  const statement = bankBalances(ws, books).find((b) => b.account === account && b.date === date && !b.document);
  if (statement) throw new YearCloseRefused({ code: 'yearEndBalanceStated', params: { account, source: statement.source } }, `${statement.source} states the balance of ${account} on ${date} already: the statement is the proof.`);
  const before = yearEndDocumentOf(ws, year, account, books);
  const sourceFile = `${YEAR_END_DOCUMENTS}/${account}-${date}${extname(name).toLowerCase()}`;
  const path = join(yearPaths(ws.paths, year).filings, sourceFile);
  const balance: StatementClosingBalance = { account, bank: money.bank, currency: money.currency, date, amount, source: 'pdf', sourceFile };
  update(books, PERSON, (b) => {
    b.statementBalances = [...(b.statementBalances ?? []).filter((x) => !(x.account === account && x.date === date)), balance]
      .sort((x, y) => x.date.localeCompare(y.date) || x.account.localeCompare(y.account));
  });
  // The proof it replaces goes only once the new one and the books are saved.
  mkdirSync(dirname(path), { recursive: true });
  const fresh = `${path}.new`;
  writeFileSync(fresh, document.body);
  try {
    saveBooks(ws, books);
  } catch (e) {
    rmSync(fresh, { force: true });
    throw e;
  }
  renameSync(fresh, path);
  if (before && before !== path) rmSync(before, { force: true });
  return balance;
}

/** Takes back a hand balance of 31.12. and its document. */
export function removeYearEndBalance(ws: Workspace, year: string, account: string): void {
  accountNeeding(ws, account, 'bank');
  const books = loadBooks(ws);
  assertYearOpen(books, year, 'its balances of 31.12. stay.');
  const file = yearEndDocumentOf(ws, year, account, books);
  if (!file) return;
  update(books, PERSON, (b) => { b.statementBalances = (b.statementBalances ?? []).filter((x) => !(x.account === account && x.date === `${year}-12-31` && fromYearEndDocument(x))); });
  saveBooks(ws, books);
  rmSync(file, { force: true });
}

/**
 * The cash counted on 31.12. on a cash account (#119), kept in the year's close record; null takes
 * it back. A difference to the books is shown by the checklist, never booked here.
 */
export function setCashCount(ws: Workspace, year: string, account: string, amount: number | null): YearCloseState {
  accountNeeding(ws, account, 'count');
  assertYearOpen(loadBooks(ws), year, 'its cash count stays.');
  const current = readState(ws, year);
  if (current.closedAt) throw new YearCloseRefused({ code: 'yearChecklistClosed', params: { year } }, `${year} is closed: its checklist no longer changes.`);
  const cashCounts = { ...current.cashCounts };
  if (amount === null) delete cashCounts[account]; else cashCounts[account] = amount;
  const { cashCounts: _, ...rest } = current;
  const next: YearCloseState = { ...rest, ...(Object.keys(cashCounts).length && { cashCounts }) };
  writeState(ws, next);
  return next;
}

/** The account numbers of the workspace's chart. */
export const chartOf = (ws: Workspace): string[] => (accountsOf(ws) as Array<{ number?: string }>).flatMap((a) => (a.number ? [String(a.number)] : []));

/** The year end's exchange-difference account when the chart of `ws` has it: proposed for the difference of a reconciled pair (#254). */
export function differenceAccountOf(ws: Workspace): string | undefined {
  const chart = chartOf(ws);
  const fx = yearEndAccounts(chart, ws.company.legalForm).fxDifference;
  return chart.includes(fx) ? fx : undefined;
}

/**
 * The invoices open on 31.12. of `year`, in CHF at the ESTV rate of that day (or the latest before
 * it), and the payments of the books that name one of them without being linked to it (r9c-3).
 * An invoice whose VAT event the books carry (the agreed basis, src/invoices/events.ts) is on the
 * receivable already and is not proposed again.
 */
export function receivablesOf(ws: Workspace, year: string, rates: EstvRates, books: Books): Receivables {
  const end = `${year}-12-31`;
  const book = loadInvoices(ws);
  const invoices = liveInvoices(book);
  const open = invoices.flatMap((inv) => {
    const amount = inv.status === 'issued' ? openOn(inv, invoices, end) : 0;
    if (inv.status !== 'issued' || amount === 0 || hasEvent(books, inv)) return [];
    const rate = inv.currency === 'CHF' ? 1 : rates.on(inv.currency, end)?.rate ?? 0;
    return [{ number: inv.number, customer: inv.customer.name, date: inv.date, currency: inv.currency, open: amount, chf: roundCHF(amount * rate) }];
  });
  const unlinked = paymentsNamingOpen(books.transactions, invoices, end);
  return { invoices: open, total: roundCHF(open.reduce((s, i) => s + i.chf, 0)), revenueAccount: ws.invoicing?.revenueAccount, ...(unlinked.length && { unlinked }) };
}

/** `ratesDir`, else VANILLA_RATES_DIR, points at another reference/ (a test, a rehearsal with a stand-in 31.12. rate). */
export function ratesOf(ratesDir: string | undefined = process.env.VANILLA_RATES_DIR): EstvRates {
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
    legalForm: ws.company.legalForm,
    // A failure with a code is said by the checklist in the person's words (bankNotInChart, r9k-1), not as doctor's English line.
    doctor: workspaceChecks(ws).flatMap((r) => (r.status === 'fail' && !r.code ? [r.label] : [])),
    rates,
    state: readState(ws, year),
    receivables: receivablesOf(ws, year, rates, books),
  });
}

/** A refusal of the year close: `why` for the screens (src/types/refusal.ts), the message for the CLI. */
export class YearCloseRefused extends Refused {}

/** The year end books only on accounts of the chart (r9c-2): a booking on 1100 with no 1100 in the chart drops out of the Bilanz. */
const assertInChart = (ws: Workspace, ...accounts: string[]) => {
  const chart = new Set(chartOf(ws));
  // Books without a chart yet (no accounts.json) have nothing to check against, as differenceCauses reads it.
  if (!chart.size) return;
  const missing = accounts.find((a) => a && !chart.has(a));
  if (missing) throw new YearCloseRefused({ code: 'accountNotInChart', params: { account: missing } }, `Account ${missing} is not in the chart of accounts: add it first (Firma › Kontenplan), or book on another.`);
};

const assertYearOpen = (books: Books, year: string, what: string) => {
  const closedThrough = books.config.closedThrough;
  if (closedThrough && closedThrough >= `${year}-12-31`) throw new YearCloseRefused({ code: 'yearClosedAlready', params: { year, through: closedThrough } }, `${year} is closed through ${closedThrough}: ${what}`);
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
  if (missing.length) throw new YearCloseRefused({ code: 'rateNotPublished', params: { year, currencies: [...new Set(missing)].join(', ') } }, `The ESTV rate of 31.12.${year} is not published yet for ${[...new Set(missing)].join(', ')}: npm run fetch-rates -- --year ${year} once it is.`);
  const entries = revaluationEntries(year, rows, yearEndAccounts(chartOf(ws), ws.company.legalForm).fxDifference);
  assertInChart(ws, ...entries.flatMap((e) => [e.accountDebit, e.accountCredit]));
  update(books, moduleActor('year-close'), (b) => applyRevaluation(b, year, entries));
  saveBooks(ws, books);
  return entries;
}

export function markTemplate(ws: Workspace, year: string, id: string, state: TemplateState | null): YearCloseState {
  const known = [...yearEndTemplates().map((t) => t.id), RECEIVABLES_ID];
  if (!known.includes(id)) throw new YearCloseRefused({ code: 'yearEndEntryUnknown', params: { id } }, `Unknown year-end entry "${id}". Known: ${known.join(', ')}`);
  const current = readState(ws, year);
  if (current.closedAt) throw new YearCloseRefused({ code: 'yearChecklistClosed', params: { year } }, `${year} is closed: its checklist no longer changes.`);
  const templates = { ...current.templates };
  if (state) templates[id] = state; else delete templates[id];
  const next = { ...current, templates };
  writeState(ws, next);
  return next;
}

/**
 * «zurück» on a step: the step is open again, and the booking the step made on 31.12. goes with it
 * (r9c-16): a person's entry on the template's accounts, the receivables entry by its id. An entry
 * the year close itself wrote (origin year-close) is not a step's booking and stays.
 */
export function reopenTemplate(ws: Workspace, year: string, id: string): { state: YearCloseState; removed: JournalEntry[] } {
  const books = loadBooks(ws);
  const removed = stepBookings(books, year, id);
  if (removed.length) {
    assertYearOpen(books, year, 'its bookings of 31.12. stay.');
    update(books, PERSON, (b) => { b.journalEntries = b.journalEntries.filter((e) => !removed.includes(e)); });
    saveBooks(ws, books);
  }
  return { state: markTemplate(ws, year, id, null), removed };
}

/** The person's entries that book step `id` (the receivables entry by its id, the others on their accounts): what «zurück» and «Neu buchen» replace. */
function stepBookings(books: Books, year: string, id: string): JournalEntry[] {
  const template = yearEndTemplates().find((t) => t.id === id) ?? (id === RECEIVABLES_ID ? { id, accountDebit: '', accountCredit: '' } : undefined);
  const ids = new Set(template ? bookedFor(books.journalEntries, year, template).map((b) => b.id) : []);
  return books.journalEntries.filter((e) => ids.has(e.id) && e.origin === 'manual');
}

/**
 * «Neu buchen» on a step whose figure changed since it was booked (r10c-1): its bookings go, and
 * today's figure is booked on the accounts of the booking it replaces, with the person's text.
 * A figure of 0 (every invoice paid or cancelled since) books nothing, and the step is open again.
 */
export function rebookTemplate(ws: Workspace, year: string, id: string, description: string, rates: EstvRates = ratesOf()): { removed: JournalEntry[]; entry?: JournalEntry } {
  const books = loadBooks(ws);
  assertYearOpen(books, year, 'its bookings of 31.12. stay.');
  const close = yearCloseOf(ws, year, rates, books);
  const step = close.templates.find((t) => t.id === id);
  if (!step) throw new YearCloseRefused({ code: 'yearEndEntryUnknown', params: { id } }, `Unknown year-end entry "${id}".`);
  if (!step.stale) throw new YearCloseRefused({ code: 'entryNotStale', params: { id } }, `The booking of "${id}" holds today's figure already: nothing to book again.`);
  if (id === RECEIVABLES_ID) assertLinked(close.receivables);
  const removed = stepBookings(books, year, id);
  const was = removed[0];
  const entry = step.stale.now > 0
    ? newEntry(books, year, id, { date: `${year}-12-31`, accountDebit: was?.accountDebit ?? step.accountDebit, accountCredit: was?.accountCredit ?? step.accountCredit, amount: step.stale.now, vatCode: was?.vatCode ?? step.vatCode, description })
    : undefined;
  if (entry) assertInChart(ws, entry.accountDebit, entry.accountCredit);
  update(books, PERSON, (b) => {
    b.journalEntries = b.journalEntries.filter((e) => !removed.includes(e));
    if (entry) b.journalEntries.push(entry);
  });
  saveBooks(ws, books);
  markTemplate(ws, year, id, entry ? 'done' : null);
  return { removed, ...(entry && { entry }) };
}

/** The Debitoren are booked only once every payment naming an open invoice is linked to it (r9c-3): else the entry counts their revenue twice. */
function assertLinked(receivables: Receivables): void {
  const unlinked = receivables.unlinked ?? [];
  if (!unlinked.length) return;
  const list = unlinked.map((p) => `${p.transactionRef} → ${p.number}`).join(', ');
  throw new YearCloseRefused({ code: 'paymentsUnlinked', params: { payments: list } }, `Payments name open invoices without being linked to them (${list}): link them first, or the Debitoren count their revenue twice.`);
}

/** A person's entry of the close under the step's id (the receivables keep the year's id, src/accounting/year-close.ts) and the next free M<year>-NNN ref. */
function newEntry(b: Books, year: string, template: string | undefined, input: EntryInput): JournalEntry {
  return {
    id: template === RECEIVABLES_ID ? receivablesEntryId(year) : randomBytes(8).toString('hex'),
    transactionRef: nextManualRef(b, year),
    date: input.date,
    accountDebit: input.accountDebit,
    accountCredit: input.accountCredit,
    amount: input.amount,
    ...(input.vatCode ? { vatCode: input.vatCode } : {}),
    description: input.description,
    origin: 'manual',
    // A person booked it on the close's form: Änderungen lists it with its «Rückgängig» (r9c-6).
    by: { kind: 'person', at: new Date().toISOString() },
  };
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
  // An Einzelfirma's profit is the owner's without a resolution (r10f-28): the legal form offers no allocation.
  if (template === PROFIT_ALLOCATION_ID && !yearEndAccounts(chartOf(ws), ws.company.legalForm).allocation) {
    throw new YearCloseRefused({ code: 'noProfitAllocation', params: { legalForm: ws.company.legalForm ?? '' } }, `A ${ws.company.legalForm ?? 'firm of this legal form'} allocates no profit: the result is the owner's.`);
  }
  assertInChart(ws, input.accountDebit, input.accountCredit);
  const books = loadBooks(ws);
  if (template === RECEIVABLES_ID) assertLinked(receivablesOf(ws, input.date.slice(0, 4), ratesOf(), books));
  const entry = update(books, PERSON, (b) => {
    const year = input.date.slice(0, 4);
    if (template === RECEIVABLES_ID && b.journalEntries.some((x) => x.id === receivablesEntryId(year))) {
      throw new YearCloseRefused({ code: 'receivablesBooked', params: { year } }, `The receivables of ${year} are booked already.`);
    }
    const entry = newEntry(b, year, template, input);
    b.journalEntries.push(entry);
    return entry;
  });
  saveBooks(ws, books);
  if (template && template !== PROFIT_ALLOCATION_ID) markTemplate(ws, input.date.slice(0, 4), template, 'done');
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
  if (close.blockers.length) throw new YearCloseRefused({ code: 'yearItemsOpen', params: { year, n: String(close.blockers.length) } }, `${year} cannot close yet: ${close.blockers.length} item(s) open.`);
  const end = `${year}-12-31`;
  if (!books.config.closedThrough || books.config.closedThrough < end) {
    const reconcile = reconcilePendingThrough(books, end);
    if (reconcile) throw new YearCloseRefused(reconcile.why, `${year} cannot close yet: ${reconcile.message}.`);
    closeThrough(books, end);
    saveBooks(ws, books);
  }
  const q4 = filingKeyOf(end, ws.filingLength) as QuarterKey;
  const seal = writeSeal(ws, books, q4, today);
  const state = readState(ws, year);
  if (!state.closedAt) writeState(ws, { ...state, closedAt: today });
  const committed = await commit(ws, `Jahresabschluss ${year}: closed through ${end}, ${q4} sealed`, [ws.paths.ledger, ws.paths.transactional]);
  return { closedThrough: end, seal: seal.file, committed };
}

/** The next year's opening balances from the closed year: what `openYear` writes. */
export function openingFor(ws: Workspace, year: string, rates: EstvRates = ratesOf(), books: Books = loadBooks(ws)): Opening {
  const chart = chartOf(ws);
  const accounts = yearEndAccounts(chart, ws.company.legalForm);
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
    throw new YearCloseRefused({ code: 'yearNotClosed', params: { year } }, `${year} is not closed yet: npm run year:close -- ${year} first.`);
  }
  const opening = openingFor(ws, year, rates, books);
  if (opening.residual !== 0) throw new YearCloseRefused({ code: 'openingUnbalanced', params: { year: opening.year, residual: opening.residual.toFixed(2) } }, `The opening of ${opening.year} does not balance: Aktiven − Passiven = ${opening.residual.toFixed(2)}.`);
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
  await commit(ws, `Eröffnung ${opening.year}: opening balances from the closed ${year}`, [ws.paths.ledger, ws.paths.transactional]);
  return { opening, changes, ratesReady, ...(reversal ? { reversal } : {}) };
}

/**
 * Commits `paths` when the company's repository is a git repository of its own (a demo inside the
 * app's repository is not); nothing else is committed.
 */
async function commit(ws: Workspace, message: string, paths: string[]): Promise<boolean> {
  const repo = await repositoryAt(ws.paths.repository);
  return repo ? commitExactly(repo, `${message}\n\nVanilla-Kind: books\nVanilla-Lock: year-close`, paths) : false;
}
