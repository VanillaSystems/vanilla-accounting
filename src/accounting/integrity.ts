/**
 * The books' referential integrity (#126): every key one record holds that names no record, read
 * from the books and the workspace files beside them (the chart, the manifest's money accounts,
 * the questions, the invoices). `danglingRefs` is pure; `danglingRefsOf` reads the files. Both only
 * report: nothing here repairs. `npm run doctor` lists them, the server logs a line at load.
 * docs/data-model.md draws every reference checked here as a dashed arrow.
 */
import type { LegalForm } from '../workspace/setup.js';
import type { LedgerBankAccount, Workspace } from '../workspace/workspace.js';
import type { InvoiceBook } from '../invoices/model.js';
import type { Question } from '../questions/model.js';
import type { EstvRates } from './fx-conversion.js';
import { closingLedger, foreignAccounts, openingChanges, openingOf, yearEndAccounts } from './year-close.js';
import { accountOf } from '../workspace/money-accounts.js';
import { loadInvoices } from '../invoices/store.js';
import { readQuestions } from '../questions/store.js';
import { chartOf } from '../books/year-close.js';
import type { Books } from '../books/store.js';

export interface IntegrityInput {
  books: Books;
  /** The account numbers of master-data/accounts.json; empty when the workspace has no chart yet. */
  chart: readonly string[];
  bankAccounts: readonly LedgerBankAccount[];
  legalForm?: LegalForm;
  questions: readonly Question[];
  invoices: InvoiceBook;
}

/** One key that names nothing: which record holds it (`record`), and the key (`missing`). */
export interface Dangling { kind: DanglingKind; record: string; missing: string }

type Found = Omit<Dangling, 'kind'>;

/** What every check looks keys up in. */
interface Known {
  input: IntegrityInput;
  transactions: Set<string>;
  /** What a link or a question may name as its payment: a movement, or the ref of a booking without a payment (#89), which its entries carry. */
  payments: Set<string>;
  receipts: Set<string>;
  entries: Set<string>;
  /** Every ref a movement answers to: its own, and the statement row a hand movement was confirmed by (#88). */
  movementRefs: Set<string>;
  /** Every statement row a statement names (BankStatement.refs). */
  statementRows: Set<string>;
}

/** Each kind of reference, what doctor calls it, and how it is found. */
const CHECKS = {
  mappingTransaction: {
    label: 'links to a missing payment',
    find: ({ input, payments }: Known): Found[] => input.books.mappings
      .filter((m) => !payments.has(m.transactionRef))
      .map((m) => ({ record: `mapping ${m.transactionRef} ↔ ${m.receiptId}`, missing: m.transactionRef })),
  },
  mappingReceipt: {
    label: 'links to a missing receipt',
    find: ({ input, receipts }: Known): Found[] => input.books.mappings
      .filter((m) => !receipts.has(m.receiptId))
      .map((m) => ({ record: `mapping ${m.transactionRef} ↔ ${m.receiptId}`, missing: m.receiptId })),
  },
  entryReceipt: {
    label: 'entries naming a missing receipt',
    find: ({ input, receipts }: Known): Found[] => input.books.journalEntries
      .flatMap((e) => (e.receipts ?? []).filter((r) => !receipts.has(r)).map((r) => ({ record: `entry ${e.id}`, missing: r }))),
  },
  entryAccount: {
    label: 'entries on an account not in the chart',
    find: ({ input }: Known): Found[] => {
      const chart = new Set(input.chart);
      // Books without a chart yet have nothing to check against (as the year close's assertInChart).
      if (!chart.size) return [];
      // An empty side is a single-leg correction (an empty Soll with a VAT code), not an account.
      return input.books.journalEntries.flatMap((e) => [...new Set([e.accountDebit, e.accountCredit])]
        .filter((a) => a && !chart.has(a)).map((a) => ({ record: `entry ${e.id}`, missing: a })));
    },
  },
  vatAdjustmentEntry: {
    label: 'VAT adjustments naming a missing entry',
    find: ({ input, entries }: Known): Found[] => (input.books.config.vatAdjustments ?? [])
      .flatMap((a) => a.entryIds.filter((id) => !entries.has(id)).map((id) => ({ record: `vatAdjustment ${a.id}`, missing: id }))),
  },
  correctionCaseEntry: {
    label: 'correction cases naming a missing entry',
    find: ({ input, entries }: Known): Found[] => (input.books.config.correctionCases ?? [])
      .flatMap((c) => [...c.originalEntryIds, ...c.correctionEntryIds].filter((id) => !entries.has(id)).map((id) => ({ record: `correctionCase ${c.id}`, missing: id }))),
  },
  allocationTransaction: {
    label: 'invoice payments of a missing payment',
    find: ({ input, transactions }: Known): Found[] => input.invoices.invoices
      .flatMap((inv) => (inv.deleted || inv.status !== 'issued' ? [] : inv.payments
        .filter((p) => !transactions.has(p.transactionRef))
        .map((p) => ({ record: `invoice ${inv.number}`, missing: p.transactionRef })))),
  },
  statementRef: {
    label: 'statements listing a missing payment',
    find: ({ input, movementRefs }: Known): Found[] => input.books.bankStatements
      .flatMap((s) => (s.refs ?? []).filter((r) => !movementRefs.has(r)).map((r) => ({ record: `statement ${s.filename}`, missing: r }))),
  },
  receiptFiledPayment: {
    label: 'receipts paid by a missing filed payment',
    find: ({ input, transactions }: Known): Found[] => input.books.receipts
      .filter((r) => r.filedPayment !== undefined && !transactions.has(r.filedPayment))
      .map((r) => ({ record: `receipt ${r.id}`, missing: r.filedPayment! })),
  },
  transactionStatement: {
    label: 'hand movements confirmed by a statement row no statement lists',
    find: ({ input, statementRows }: Known): Found[] => input.books.transactions
      .filter((t) => t.statement !== undefined && !statementRows.has(t.statement))
      .map((t) => ({ record: `transaction ${t.ref}`, missing: t.statement! })),
  },
  questionTarget: {
    label: 'open questions about something gone',
    find: ({ input, payments, receipts, entries }: Known): Found[] => {
      const known = { payment: payments, receipt: receipts, entry: entries };
      // An answered or closed question is history; only an open one waits on its target.
      return input.questions.filter((q) => q.status === 'open' && !known[q.on.kind].has(q.on.id))
        .map((q) => ({ record: `question ${q.id}`, missing: `${q.on.kind} ${q.on.id}` }));
    },
  },
  moneyAccount: {
    label: 'movements on a money account the manifest lacks',
    find: ({ input }: Known): Found[] => input.books.transactions
      .filter((t) => !accountOf(t, input.bankAccounts))
      .map((t) => ({ record: `transaction ${t.ref}`, missing: `${t.bank} ${t.currency}` })),
  },
  openingMismatch: {
    label: 'opening balances that differ from the closing of the closed year before',
    find: ({ input }: Known): Found[] => openingMismatches(input),
  },
} satisfies Record<string, { label: string; find: (k: Known) => Found[] }>;

export type DanglingKind = keyof typeof CHECKS;

export const DANGLING_KINDS = Object.keys(CHECKS) as DanglingKind[];

/** The found references by kind, in the order of DANGLING_KINDS, kinds with none left out. */
export function byKind(found: readonly Dangling[]): Array<{ kind: DanglingKind; label: string; found: Dangling[] }> {
  return DANGLING_KINDS.flatMap((kind) => {
    const of = found.filter((d) => d.kind === kind);
    return of.length ? [{ kind, label: CHECKS[kind].label, found: of }] : [];
  });
}

/** Every dangling reference of the books, grouped by kind in the order of DANGLING_KINDS. */
export function danglingRefs(input: IntegrityInput): Dangling[] {
  const { books } = input;
  const transactions = new Set(books.transactions.map((t) => t.ref));
  const known: Known = {
    input,
    transactions,
    payments: new Set([...transactions, ...books.journalEntries.map((e) => e.transactionRef)]),
    receipts: new Set(books.receipts.map((r) => r.id)),
    entries: new Set(books.journalEntries.map((e) => e.id)),
    movementRefs: new Set([...transactions, ...books.transactions.flatMap((t) => (t.statement === undefined ? [] : [t.statement]))]),
    statementRows: new Set(books.bankStatements.flatMap((s) => s.refs ?? [])),
  };
  return DANGLING_KINDS.flatMap((kind) => CHECKS[kind].find(known).map((f) => ({ kind, ...f })));
}

/** The opening in the books' currency ignores the rates: they only explain a foreign account not revalued. */
const NO_RATES: EstvRates = { on: () => undefined, yearEnd: () => undefined };

/**
 * config.openingBalances[Y+1] against the closing of every closed year Y the books hold, as the
 * year opening computes it (src/books/year-close.ts openingFor). The books' first year opens with
 * imported balances, so a year before the books' first record is no closed year of theirs.
 */
function openingMismatches({ books, chart, bankAccounts, legalForm }: IntegrityInput): Found[] {
  const closedThrough = books.config.closedThrough;
  const stored = books.config.openingBalances ?? {};
  const years = [...Object.keys(stored), ...books.journalEntries.map((e) => e.date.slice(0, 4)), ...books.transactions.map((t) => t.date.slice(0, 4))];
  if (!closedThrough || !years.length) return [];
  const first = years.reduce((a, b) => (a < b ? a : b));
  const accounts = yearEndAccounts(chart, legalForm);
  return Object.keys(stored).flatMap((next) => {
    const year = String(+next - 1);
    if (year < first || closedThrough < `${year}-12-31`) return [];
    const opening = openingOf(closingLedger(books, year, chart, accounts), books, foreignAccounts(bankAccounts), NO_RATES, accounts);
    return openingChanges(stored[next], opening.balances).map((c) => ({
      record: `openingBalances ${next} account ${c.account}`,
      missing: `${c.before.toFixed(2)} stored, ${c.after.toFixed(2)} closing ${year}`,
    }));
  });
}

/** The dangling references of a workspace's books, with its chart, manifest, questions and invoices. */
export function danglingRefsOf(ws: Workspace, books: Books): Dangling[] {
  return danglingRefs({
    books,
    chart: chartOf(ws),
    bankAccounts: ws.bankAccounts,
    legalForm: ws.company.legalForm,
    questions: readQuestions(ws),
    invoices: loadInvoices(ws),
  });
}
