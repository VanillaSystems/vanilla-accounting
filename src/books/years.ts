/**
 * Which fiscal year each record and file of the books lies in (ADR 0013). Pure: the store
 * (src/books/store.ts) writes and moves by these rules.
 *
 * - An entry, a transaction, a balance: the year of its date. A mapping: its transaction's. A
 *   statement's open question (#254): the year of the statement's last day.
 * - A receipt: the year of the first entry that books it (the payment date, since tax is reported
 *   on received payments), else of its own date. A statement: the year of its last day.
 * - A closed year takes nothing new: a receipt or statement whose year is closed, and which does
 *   not lie there already, goes to the earliest open year. A year before the first year of the
 *   books (the earliest year of config.openingBalances) counts as closed: its books were kept elsewhere.
 */
import type { AccountingConfig, BankStatement, Index, JournalEntry, Receipt, StatementAsk, StatementClosingBalance } from '../types/index.js';
import { canonical } from './seal.js';

/** The parts of a year's books/ folder, by the key of the books that holds them. */
export const BOOK_FILES = {
  journalEntries: 'entries.jsonl',
  transactions: 'transactions.jsonl',
  mappings: 'mappings.jsonl',
  receipts: 'receipts.jsonl',
  bankStatements: 'statements.jsonl',
  statementBalances: 'balances.jsonl',
  statementAsks: 'asks.jsonl',
} as const;
export type Part = keyof typeof BOOK_FILES;
export const PARTS = Object.keys(BOOK_FILES) as Part[];

export type Records = Pick<Index, 'transactions' | 'mappings' | 'receipts' | 'bankStatements' | 'statementBalances' | 'statementAsks'> & { journalEntries: JournalEntry[] };
type RecordOf<P extends Part> = NonNullable<Records[P]>[number];

/** The id a record is sorted and found by within its part. */
export const keyOf: { [P in Part]: (r: RecordOf<P>) => string } = {
  journalEntries: (e) => e.id,
  transactions: (t) => t.ref,
  mappings: (m) => `${m.transactionRef} ${m.receiptId}`,
  receipts: (r) => r.id,
  bankStatements: (s) => statementFile(s),
  statementBalances: (b) => `${b.account} ${b.date} ${canonical(b)}`,
  statementAsks: (a) => a.file,
};

/** A statement's file below bank-statements/ of its year. */
export const statementFile = (s: Pick<BankStatement, 'bank' | 'filename'>): string => `${s.bank}/${s.filename}`;

export const yearOfDate = (date: string): string => date.slice(0, 4);

/** A year is closed for good once closedThrough reaches its 31.12. */
export const isClosedYear = (year: string, closedThrough: string | undefined): boolean => !!closedThrough && closedThrough >= `${year}-12-31`;

/** `year` when it is open, else the earliest open year. */
export function openYear(year: string, closedThrough: string | undefined): string {
  if (!isClosedYear(year, closedThrough)) return year;
  const last = +closedThrough!.slice(0, 4) - (closedThrough!.slice(5) === '12-31' ? 0 : 1);
  return String(last + 1);
}

/** What decides which years take new files: closedThrough, and the first year of the books. */
export type Bounds = Pick<AccountingConfig, 'closedThrough' | 'openingBalances'> | undefined;

/** Whether a record lay in a closed year's files when the books were read. */
export type InClosedYear = (year: string, part: Part, key: string) => boolean;

/**
 * The year of every record of the books. `inClosed` keeps a receipt, statement or balance in
 * the closed year it was read from; anything else whose year is closed goes to the earliest
 * open year. Entries, transactions and mappings stay in the year of their date: the write door
 * refuses a new one in a closed period.
 */
export function placement(books: Records, bounds: Bounds, inClosed: InClosedYear) {
  const closedThrough = bounds?.closedThrough;
  const first = Object.keys(bounds?.openingBalances ?? {}).sort()[0];
  const txDate = new Map(books.transactions.map((t) => [t.ref, t.date]));
  const firstEntry = new Map<string, string>();
  for (const e of books.journalEntries) {
    const was = firstEntry.get(e.transactionRef);
    if (!was || e.date < was) firstEntry.set(e.transactionRef, e.date);
  }
  const booked = new Map<string, string>();
  for (const m of books.mappings) {
    const date = firstEntry.get(m.transactionRef);
    const was = booked.get(m.receiptId);
    if (date && (!was || date < was)) booked.set(m.receiptId, date);
  }
  // A receipt with no date at all (none read, none indexed) lies in the earliest open year.
  const undated = closedThrough ? `${openYear(closedThrough.slice(0, 4), closedThrough)}-01-01` : new Date().toISOString().slice(0, 10);
  const receiptDate = (r: Receipt) => booked.get(r.id) || r.date || r.indexedAt?.slice(0, 10) || undated;
  const fileYear = (part: Part, key: string, date: string) => {
    const year = first && yearOfDate(date) < first ? first : yearOfDate(date);
    return inClosed(year, part, key) ? year : openYear(year, closedThrough);
  };
  const receipt = (r: Receipt) => fileYear('receipts', r.id, receiptDate(r));
  const statement = (s: BankStatement) => fileYear('bankStatements', statementFile(s), s.toDate);
  const year: { [P in Part]: (r: RecordOf<P>) => string } = {
    journalEntries: (e) => yearOfDate(e.date),
    transactions: (t) => yearOfDate(t.date),
    mappings: (m) => {
      const date = txDate.get(m.transactionRef) ?? firstEntry.get(m.transactionRef);
      if (date) return yearOfDate(date);
      const r = books.receipts.find((x) => x.id === m.receiptId);
      if (r) return receipt(r);
      throw new Error(`mapping ${m.transactionRef} ↔ ${m.receiptId}: neither its transaction, an entry nor its receipt gives it a year`);
    },
    receipts: receipt,
    bankStatements: statement,
    statementBalances: (b: StatementClosingBalance) => fileYear('statementBalances', keyOf.statementBalances(b), b.date),
    statementAsks: (a: StatementAsk) => fileYear('statementAsks', a.file, a.date),
  };
  return { year, receipt, statement };
}

/** The books cut into years: for each year and part its records, sorted by key. */
export function splitByYear(books: Records, bounds: Bounds, inClosed: InClosedYear): Map<string, Map<Part, unknown[]>> {
  const { year } = placement(books, bounds, inClosed);
  const out = new Map<string, Map<Part, unknown[]>>();
  for (const part of PARTS) {
    const records = (books[part] ?? []) as RecordOf<typeof part>[];
    const sorted = records.map((r, i) => ({ r, k: (keyOf[part] as (x: unknown) => string)(r), i })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
    for (const { r } of sorted) {
      const y = (year[part] as (x: unknown) => string)(r);
      if (!out.has(y)) out.set(y, new Map());
      const parts = out.get(y)!;
      parts.set(part, [...(parts.get(part) ?? []), r]);
    }
  }
  return out;
}

/** One record per line, as written in a year's books/ (JSON Lines). */
export const toJsonl = (records: readonly unknown[]): string => records.map((r) => JSON.stringify(r) + '\n').join('');
export const fromJsonl = (text: string, file: string): unknown[] => text.split('\n').filter((l) => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`${file}:${i + 1}: ${(e as Error).message}`); }
});
