/**
 * The one owner of the workspace's books.json: load, save, its schema (src/workspace/schema.ts),
 * and golden rule 1 (AGENTS.md), nothing dated on or before config.closedThrough ever changes:
 * mutateJournal while the app runs, the seals of the filed quarters (src/books/seal.ts) on load.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Index } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, climb, schemaOf } from '../workspace/schema.js';
import { checkSeals, closedPart, type SealReport } from './seal.js';
import { ClosedPeriodError, periodLock, type Books } from './lock.js';
import { commitBooks, defaultAction } from './history.js';

export { ClosedPeriodError, periodLock, type Books, type PeriodLock } from './lock.js';
/** A filed quarter's seal no longer matches the books: they read, but are never written. */
export class SealBrokenError extends ClosedPeriodError {}

/** Keys loadBooks filled in, so saveBooks leaves them off the disk again while still empty. */
const filledDefaults = new WeakMap<Books, Array<'journalEntries' | 'config'>>();
const seals = new WeakMap<Books, SealReport>();
const warned = new Set<string>();

/**
 * The books at the current schema (older ones are migrated in memory, a newer one is refused),
 * with every seal checked. A broken seal is printed once per process, and saveBooks refuses them.
 */
export function loadBooks(ws: Workspace): Books {
  const path = ws.paths.books;
  if (!existsSync(path)) throw new Error(`No ${path} found. Run \`npm run extract\` first.`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const current = climb<Record<string, unknown>>(raw, schemaOf(raw.schema, path), BOOKS_SCHEMA, BOOKS_MIGRATIONS, path, (d) => structuredClone(d));
  const books = withDefaults({ ...current, schema: BOOKS_SCHEMA } as unknown as Index);
  const report = checkSeals(ws, books);
  seals.set(books, report);
  for (const c of report.checks) {
    if (c.status !== 'broken' || warned.has(c.file)) continue;
    warned.add(c.file);
    console.error(`\n!!! SEAL BROKEN: ${c.quarter} is filed, but ${c.problem}.\n!!! ${c.file}\n!!! The books open read-only. Restore books.json from git; npm run check-closed shows what changed.\n`);
  }
  return books;
}

/** The seal check loadBooks ran on these books. */
export function sealsOf(books: Books): SealReport {
  return seals.get(books) ?? { checks: [], unsealed: [] };
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

/**
 * Writes books.json atomically, then commits it in the workspace's git repository as the writer
 * (src/books/history.ts), with `action` as the message. `commit: false` leaves the commit to the
 * caller (a review merge makes its own merge commit).
 */
export function saveBooks(ws: Workspace, books: Books, action: string = defaultAction(), opts: { commit?: boolean } = {}): void {
  const broken = sealsOf(books).checks.find((c) => c.status === 'broken');
  if (broken) throw new SealBrokenError(`Siegel ${broken.quarter} gebrochen, nichts gespeichert: ${broken.problem}. Restore books.json from git.`);
  guards.get(books)?.();
  const filled = filledDefaults.get(books) ?? [];
  const { schema: _, ...rest } = books;
  const onDisk: Index = { schema: BOOKS_SCHEMA, ...rest };
  if (filled.includes('journalEntries') && books.journalEntries.length === 0) delete onDisk.journalEntries;
  if (filled.includes('config') && Object.keys(books.config).length === 0) delete onDisk.config;
  const path = ws.paths.books;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
  renameSync(tmp, path);
  if (opts.commit !== false) commitBooks(ws, action);
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
  const before = { closedThrough: periodLock(books).closedThrough, ...closedPart(books, periodLock(books).closedThrough) };
  const check = () => {
    const lock = periodLock(books);
    if (lock.closedThrough !== before.closedThrough) {
      throw new ClosedPeriodError(`config.closedThrough changed from ${before.closedThrough} to ${lock.closedThrough}.`, before.closedThrough);
    }
    const after = closedPart(books, lock.closedThrough);
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
