/**
 * The one owner of the workspace's books.json: load, save, and golden rule 1 (AGENTS.md),
 * nothing dated on or before config.closedThrough ever changes.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AccountingConfig, Index, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import type { ClosedReason } from '../types/api-error.js';

export type Books = Index & { journalEntries: JournalEntry[]; config: AccountingConfig };

export class ClosedPeriodError extends Error {
  /** `reason` names which refusal (src/types/api-error.ts) when the API's assertOpen threw it. */
  constructor(message: string, readonly closedThrough?: string, readonly reason?: ClosedReason) { super(message); }
}

/** Keys loadBooks filled in, so saveBooks leaves them off the disk again while still empty. */
const filledDefaults = new WeakMap<Books, Array<'journalEntries' | 'config'>>();

export function loadBooks(ws: Workspace): Books {
  const path = ws.paths.books;
  if (!existsSync(path)) throw new Error(`No ${path} found. Run \`npm run extract\` first.`);
  return withDefaults(JSON.parse(readFileSync(path, 'utf8')));
}

/** The books before the first `npm run extract`. */
export const emptyBooks = (): Books => withDefaults({ receipts: [], transactions: [], mappings: [], bankStatements: [] });

function withDefaults(index: Index): Books {
  const filled: Array<'journalEntries' | 'config'> = [];
  if (!index.journalEntries) { index.journalEntries = []; filled.push('journalEntries'); }
  if (!index.config) { index.config = {}; filled.push('config'); }
  const books = index as Books;
  filledDefaults.set(books, filled);
  return books;
}

export function saveBooks(ws: Workspace, books: Books): void {
  guards.get(books)?.();
  const filled = filledDefaults.get(books) ?? [];
  const onDisk: Index = { ...books };
  if (filled.includes('journalEntries') && books.journalEntries.length === 0) delete onDisk.journalEntries;
  if (filled.includes('config') && Object.keys(books.config).length === 0) delete onDisk.config;
  const path = ws.paths.books;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
  renameSync(tmp, path);
}

export interface PeriodLock {
  closedThrough: string | undefined;
  isClosed(date: string | undefined): boolean;
  assertOpen(date: string | undefined, what: string): void;
}

export function periodLock(books: Pick<Index, 'config'>): PeriodLock {
  const closedThrough = books.config?.closedThrough;
  const isClosed = (date: string | undefined) => !!closedThrough && !!date && date <= closedThrough;
  return {
    closedThrough,
    isClosed,
    assertOpen(date, what) {
      if (isClosed(date)) throw new ClosedPeriodError(`Periode geschlossen bis ${closedThrough}. ${what}`, closedThrough);
    },
  };
}

/** The checks of the mutateJournal calls in flight, run again by every saveBooks inside them. */
const guards = new WeakMap<Books, () => void>();

/**
 * Golden rule 1 as a structural check. Runs `fn`, then throws ClosedPeriodError if any
 * closed-period journal entry, closed transaction, or mapping to a closed transaction was
 * changed, added or removed. A saveBooks inside `fn` runs the same check before it writes.
 */
export function mutateJournal<T>(books: Books, fn: (books: Books) => Promise<T>): Promise<T>;
export function mutateJournal<T>(books: Books, fn: (books: Books) => T): T;
export function mutateJournal<T>(books: Books, fn: (books: Books) => T | Promise<T>): T | Promise<T> {
  const before = closedPart(books, periodLock(books));
  const check = () => {
    const lock = periodLock(books);
    if (lock.closedThrough !== before.closedThrough) {
      throw new ClosedPeriodError(`config.closedThrough changed from ${before.closedThrough} to ${lock.closedThrough}.`, before.closedThrough);
    }
    const after = closedPart(books, lock);
    const changed = (['entries', 'transactions', 'mappings'] as const).flatMap((k) => diff(k, before[k], after[k]));
    if (changed.length) {
      throw new ClosedPeriodError(`Periode geschlossen bis ${lock.closedThrough}: ${changed.join('; ')}`, lock.closedThrough);
    }
  };
  const outer = guards.get(books);
  guards.set(books, outer ? () => { outer(); check(); } : check);
  const done = () => { if (outer) guards.set(books, outer); else guards.delete(books); };
  let result: T | Promise<T>;
  try {
    result = fn(books);
  } catch (e) {
    done();
    throw e;
  }
  if (result instanceof Promise) {
    return result.then((r) => { check(); return r; }).finally(done);
  }
  try {
    check();
  } finally {
    done();
  }
  return result;
}

interface ClosedPart {
  closedThrough: string | undefined;
  entries: Map<string, string[]>;
  transactions: Map<string, string[]>;
  mappings: Map<string, string[]>;
}

/** The closed records, each grouped under its id and serialized, so a reorder is not a change. */
function closedPart(books: Books, lock: PeriodLock): ClosedPart {
  const group = <X>(xs: X[], key: (x: X) => string) => {
    const m = new Map<string, string[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), JSON.stringify(x)].sort());
    return m;
  };
  const transactions = books.transactions.filter((t) => lock.isClosed(t.date));
  const entries = books.journalEntries.filter((e) => lock.isClosed(e.date));
  const closedRefs = new Set([...transactions.map((t) => t.ref), ...entries.map((e) => e.transactionRef)]);
  return {
    closedThrough: lock.closedThrough,
    entries: group(entries, (e) => e.id),
    transactions: group(transactions, (t) => t.ref),
    mappings: group(books.mappings.filter((m) => closedRefs.has(m.transactionRef)), (m) => `${m.transactionRef} ↔ ${m.receiptId}`),
  };
}

function diff(kind: string, before: Map<string, string[]>, after: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [k, v] of before) {
    const w = after.get(k);
    if (!w) out.push(`${kind} ${k} removed`);
    else if (w.join('\n') !== v.join('\n')) out.push(`${kind} ${k} changed`);
  }
  for (const k of after.keys()) if (!before.has(k)) out.push(`${kind} ${k} added`);
  return out;
}
