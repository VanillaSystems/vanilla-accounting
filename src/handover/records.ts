/**
 * The books as records by id (docs/specs/e2e-and-fiduciary.md B5.1): what a return carries and what
 * the merge compares. A record is one entry, payment, link, receipt, statement, … of the books' parts
 * (src/books/years.ts keyOf), a field of the books' config, or a file of knowledge/ and
 * master-data/accounts.json as a whole («a text file without ids counts as one record»).
 * Two records are the same when their canonical JSON is: the order of their keys does not count.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../books/seal.js';
import { BOOK_FILES, PARTS, fromJsonl, keyOf, type Part } from '../books/years.js';
import { YEAR_FOLDER } from '../workspace/workspace.js';
import type { AccountingConfig, Index } from '../types/index.js';

export type RecordKind = Part | 'config' | 'file';

/** A record's address: its kind and its key in that kind. */
export interface RecordRef { kind: RecordKind; key: string }

/** One record that differs: as it was in the base (absent: added) and as it is now (absent: removed). */
export interface RecordChange extends RecordRef { before?: unknown; after?: unknown }

/** The config fields only the owner's own steps move (the filing line, a held return): never part of a change set. */
export const CONFIG_HELD: ReadonlySet<string> = new Set(['closedThrough', 'approvedReturn']);

const join0 = (kind: RecordKind, key: string) => `${kind}\u0000${key}`;
export const refKey = (r: RecordRef): string => join0(r.kind, r.key);
export const parseRefKey = (k: string): RecordRef => { const [kind, key] = k.split('\u0000'); return { kind: kind as RecordKind, key }; };

/** A part's records by key; a key that repeats gets `#n`, as src/books/record-diff.ts. */
export function keyedPart(part: Part, records: readonly unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Map<string, number>();
  for (const r of records) {
    const key = (keyOf[part] as unknown as (x: unknown) => string)(r);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.set(n ? `${key}#${n}` : key, r);
  }
  return out;
}

export type RecordMap = Map<string, unknown>;

/** Every record of `books` (and of the files `files` names, path → text), keyed by refKey. */
export function recordsOf(books: Pick<Index, 'config'> & Partial<Record<Part, unknown[]>>, files: ReadonlyMap<string, string> = new Map()): RecordMap {
  const out: RecordMap = new Map();
  for (const part of PARTS) for (const [key, r] of keyedPart(part, (books[part] as unknown[] | undefined) ?? [])) out.set(join0(part, key), r);
  for (const [field, value] of Object.entries(books.config ?? {})) if (!CONFIG_HELD.has(field) && value !== undefined) out.set(join0('config', field), value);
  for (const [path, text] of files) out.set(join0('file', path), text);
  return out;
}

const listFiles = (dir: string, prefix: string): string[] => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).flatMap((d) => (d.isDirectory() ? listFiles(join(dir, d.name), `${prefix}/${d.name}`) : [`${prefix}/${d.name}`]))
  : []);

/** The files that count as records: knowledge/ and the chart of accounts, by path → text. */
export function recordFiles(root: string): Map<string, string> {
  const paths = [...listFiles(join(root, 'knowledge'), 'knowledge'), ...(existsSync(join(root, 'master-data/accounts.json')) ? ['master-data/accounts.json'] : [])];
  return new Map(paths.sort().map((p) => [p, readFileSync(join(root, p), 'utf8')]));
}

/** Whether a path is one of the record files (recordFiles). */
export const isRecordFile = (path: string): boolean => path.startsWith('knowledge/') || path === 'master-data/accounts.json';

/**
 * The books as their files in `root` hold them (ledger.json and every year's books/*.jsonl), read
 * without a workspace: the base a recipient got, kept as files, and a package's books.
 */
export function booksInFolder(root: string): Pick<Index, 'config'> & Record<Part, unknown[]> {
  const ledger = existsSync(join(root, 'ledger.json')) ? (JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8')) as { config?: AccountingConfig }) : {};
  const out = { config: ledger.config ?? {} } as Pick<Index, 'config'> & Record<Part, unknown[]>;
  for (const part of PARTS) out[part] = [];
  const td = join(root, 'transactional-data');
  if (!existsSync(td)) return out;
  for (const year of readdirSync(td).filter((y) => YEAR_FOLDER.test(y) && statSync(join(td, y)).isDirectory()).sort()) {
    for (const part of PARTS) {
      const file = join(td, year, 'books', BOOK_FILES[part]);
      if (existsSync(file)) out[part].push(...fromJsonl(readFileSync(file, 'utf8'), file));
    }
  }
  return out;
}

/** The records of the books folder `root`, its record files included. */
export const recordsInFolder = (root: string): RecordMap => recordsOf(booksInFolder(root), recordFiles(root));

export const sameRecord = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : canonical(a) === canonical(b));

/** The records that differ from `base` to `now`. */
export function diffRecords(base: RecordMap, now: RecordMap): RecordChange[] {
  const out: RecordChange[] = [];
  for (const k of new Set([...base.keys(), ...now.keys()])) {
    const before = base.get(k), after = now.get(k);
    if (sameRecord(before, after)) continue;
    out.push({ ...parseRefKey(k), ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  }
  return out.sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1));
}

/**
 * Puts each change's `after` into `books` (absent: the record goes), in place. Records of a part
 * keep their order; new ones come last. Files are not touched: the caller writes them (applyFiles).
 */
export function applyToBooks(books: Pick<Index, 'config'> & Partial<Record<Part, unknown[]>>, changes: ReadonlyArray<RecordRef & { after?: unknown }>): void {
  const target = books as unknown as Record<string, unknown[] | undefined> & { config: Record<string, unknown> };
  for (const part of PARTS) {
    const mine = changes.filter((c) => c.kind === part);
    if (!mine.length) continue;
    const keyed = keyedPart(part, target[part] ?? []);
    for (const c of mine) {
      if (c.after === undefined) keyed.delete(c.key);
      else keyed.set(c.key, structuredClone(c.after));
    }
    target[part] = [...keyed.values()];
  }
  for (const c of changes.filter((x) => x.kind === 'config')) {
    if (CONFIG_HELD.has(c.key)) continue;
    if (c.after === undefined) delete target.config[c.key];
    else target.config[c.key] = structuredClone(c.after);
  }
}

/** The date a record is dated by, when it has one: an entry's or payment's own, a link's payment's. */
export function dateOf(ref: RecordRef, record: unknown, books: Pick<Index, 'transactions'> & { journalEntries?: Array<{ transactionRef: string; date: string }> }): string | undefined {
  const r = record as Record<string, unknown> | undefined;
  if (!r) return undefined;
  if (ref.kind === 'journalEntries' || ref.kind === 'transactions') return typeof r.date === 'string' ? r.date : undefined;
  if (ref.kind === 'mappings') {
    const tx = String(r.transactionRef ?? '');
    return books.transactions.find((t) => t.ref === tx)?.date ?? books.journalEntries?.find((e) => e.transactionRef === tx)?.date;
  }
  return undefined;
}
