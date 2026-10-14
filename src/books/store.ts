/**
 * The one owner of the workspace's books.json: load, save, its schema (src/workspace/schema.ts),
 * and golden rule 1 (AGENTS.md), nothing dated on or before config.closedThrough ever changes:
 * `update` while the app runs, the seals of the filed quarters (src/books/seal.ts) on load.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AccountingConfig, Index, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, climb, schemaOf } from '../workspace/schema.js';
import type { ClosedReason } from '../types/api-error.js';
import { checkSeals, closedPart, type SealReport } from './seal.js';

export type Books = Index & { journalEntries: JournalEntry[]; config: AccountingConfig };

export class ClosedPeriodError extends Error {
  /** `reason` names which refusal (src/types/api-error.ts) when the API's assertOpen threw it. */
  constructor(message: string, readonly closedThrough?: string, readonly reason?: ClosedReason) { super(message); }
}
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

export function saveBooks(ws: Workspace, books: Books): void {
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

/**
 * Who changes the books: a person (the UI, a command they run), a module that writes on its own
 * (intake, year close, a collector), or a workflow run. The actor decides what may be replaced.
 */
export type Actor =
  | { kind: 'person' }
  | { kind: 'module'; id: string }
  | { kind: 'run'; id: string; workflow: string };

export const PERSON: Actor = { kind: 'person' };
export const moduleActor = (id: string): Actor => ({ kind: 'module', id });

/**
 * Who owns an entry, by its origin. A person's own entries change only by a person; an entry
 * without an origin (booked before origins existed) is anyone's, as it was.
 */
const OWNER: Record<NonNullable<JournalEntry['origin']>, 'person' | 'module'> = {
  manual: 'person',
  classify: 'module',
  invoice: 'module',
  'year-close': 'module',
};

export class OwnershipError extends Error {}

/** The checks of the `update` calls in flight, run again by every saveBooks inside them. */
const guards = new WeakMap<Books, () => void>();

/**
 * The one write door. Runs `fn` as `actor`, then throws ClosedPeriodError if any closed-period
 * journal entry, closed transaction, or mapping to a closed transaction was changed, added or
 * removed (golden rule 1), and OwnershipError if an actor other than a person changed or removed
 * a person's entry. A saveBooks inside `fn` runs the same checks before it writes.
 */
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => Promise<T>): Promise<T>;
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => T): T;
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => T | Promise<T>): T | Promise<T> {
  const before = { closedThrough: periodLock(books).closedThrough, ...closedPart(books, periodLock(books).closedThrough) };
  const persons = actor.kind === 'person' ? undefined : personsEntries(books);
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
    if (persons) {
      const touched = diff('entry', persons, personsEntries(books)).filter((d) => !d.endsWith(' added'));
      if (touched.length) throw new OwnershipError(`${describe(actor)} ändert keine Buchung einer Person: ${touched.join('; ')}`);
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

const describe = (a: Actor) => (a.kind === 'person' ? 'Eine Person' : a.kind === 'module' ? `Modul ${a.id}` : `Lauf ${a.id} (${a.workflow})`);

function personsEntries(books: Books): Map<string, string[]> {
  return new Map(books.journalEntries.filter((e) => e.origin && OWNER[e.origin] === 'person').map((e) => [e.id, [JSON.stringify(e)]]));
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
