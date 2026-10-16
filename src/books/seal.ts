/**
 * Seals of the filed quarters: golden rule 1 (AGENTS.md) made checkable after the fact. When a
 * quarter is closed, transactional-data/<year>/filings/seal-<Qn>.json records a SHA-256 of every journal entry,
 * bank transaction and receipt mapping dated on or before the quarter's last day. loadBooks
 * checks every seal; books whose sealed part changed still open, so the change can be looked at,
 * but saveBooks refuses to write them until they are restored from git.
 *
 * The write door, update (src/books/store.ts), stops a change while the app runs; a seal also catches one
 * made by a hand edit, an ad-hoc script or a bad merge, and still holds after a git commit.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addDays, derivePeriod, filingKeyOf, isFilingKey, type FilingLength } from '../accounting/periods.js';
import type { Index, QuarterKey } from '../types/index.js';
import { yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';

type Records = Pick<Index, 'transactions' | 'mappings' | 'journalEntries'>;

export interface Seal {
  quarter: QuarterKey;
  /** The quarter's last day: the seal covers every record dated on or before it. */
  through: string;
  sha256: string;
  records: { entries: number; transactions: number; mappings: number };
  sealedAt: string;
  rule: string;
}

export type SealCheck =
  | { quarter: QuarterKey; file: string; status: 'intact' }
  | { quarter: QuarterKey; file: string; status: 'broken'; problem: string };

export interface SealReport {
  checks: SealCheck[];
  /** Closed quarters that hold records but have no seal yet: `npm run seal -- <quarter>`. */
  unsealed: QuarterKey[];
}

const RULE = 'SHA-256 of the canonical JSON of the journal entries, bank transactions and their receipt mappings dated on or before `through` (src/books/seal.ts closedPart)';

/** JSON with the keys of every object sorted, so a reordered key is not a change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface ClosedPart {
  entries: Map<string, string[]>;
  transactions: Map<string, string[]>;
  mappings: Map<string, string[]>;
}

/**
 * The records golden rule 1 freezes on or before `through`, each grouped under its id and
 * serialized canonically, so neither a reorder of records nor of keys is a change. A mapping
 * belongs to the closed part when its transaction does, or a closed entry books that ref.
 */
export function closedPart(books: Records, through: string | undefined): ClosedPart {
  const isClosed = (date: string | undefined) => !!through && !!date && date <= through;
  const group = <X>(xs: X[], key: (x: X) => string) => {
    const m = new Map<string, string[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), canonical(x)].sort());
    return m;
  };
  const transactions = books.transactions.filter((t) => isClosed(t.date));
  const entries = (books.journalEntries ?? []).filter((e) => isClosed(e.date));
  const closedRefs = new Set([...transactions.map((t) => t.ref), ...entries.map((e) => e.transactionRef)]);
  return {
    entries: group(entries, (e) => e.id),
    transactions: group(transactions, (t) => t.ref),
    mappings: group(books.mappings.filter((m) => closedRefs.has(m.transactionRef)), (m) => `${m.transactionRef} ↔ ${m.receiptId}`),
  };
}

function fingerprint(books: Records, through: string): Pick<Seal, 'sha256' | 'records'> {
  const part = closedPart(books, through);
  const flat = (m: Map<string, string[]>) => [...m.values()].flat().sort();
  const lists = { entries: flat(part.entries), transactions: flat(part.transactions), mappings: flat(part.mappings) };
  return {
    sha256: createHash('sha256').update(JSON.stringify(lists)).digest('hex'),
    records: { entries: lists.entries.length, transactions: lists.transactions.length, mappings: lists.mappings.length },
  };
}

const PERIOD = /^(\d{4})-(Q[1-4]|H[12])$/;

/** `text` as a filing period of `length` (a quarter, or a half year for a firm filing half-yearly). */
export function asQuarter(text: string, length: FilingLength): QuarterKey | undefined {
  return isFilingKey(text, length) ? (text as QuarterKey) : undefined;
}

const quarterEnd = (q: QuarterKey) => derivePeriod(q)!.to;

/** filings/seal-Q3.json, filings/seal-H1.json. */
export function sealFile(ws: Workspace, q: QuarterKey): string {
  const [, year, n] = PERIOD.exec(q)!;
  return join(yearPaths(ws.paths, year).filings, `seal-${n}.json`);
}

/** Pure: the seal of `quarter` for these books. */
export function sealOf(books: Records, quarter: QuarterKey, sealedAt: string): Seal {
  const through = quarterEnd(quarter);
  return { quarter, through, ...fingerprint(books, through), sealedAt, rule: RULE };
}

/** Every seal file of the workspace, by quarter. */
function sealFiles(ws: Workspace): { quarter: QuarterKey; file: string }[] {
  return yearsOf(ws.paths)
    .flatMap((year) => {
      const { filings } = yearPaths(ws.paths, year);
      return existsSync(filings) ? readdirSync(filings)
        .map((f) => /^seal-(Q[1-4]|H[12])\.json$/.exec(f))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ quarter: `${year}-${m[1]}` as QuarterKey, file: join(filings, m[0]) })) : [];
    })
    .sort((a, b) => a.quarter.localeCompare(b.quarter));
}

function check(books: Records, closedThrough: string | undefined, quarter: QuarterKey, file: string): SealCheck {
  const broken = (problem: string): SealCheck => ({ quarter, file, status: 'broken', problem });
  let seal: Partial<Seal>;
  try { seal = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return broken(`the seal file does not read (${(e as Error).message})`); }
  if (seal.quarter !== quarter || seal.through !== quarterEnd(quarter) || typeof seal.sha256 !== 'string' || !seal.records) {
    return broken('the seal file is not a seal of this quarter');
  }
  if (!closedThrough || closedThrough < seal.through) {
    return broken(`config.closedThrough is ${closedThrough ?? 'missing'}, before the sealed ${seal.through}: a filed quarter was opened again`);
  }
  const now = fingerprint(books, seal.through);
  if (now.sha256 === seal.sha256) return { quarter, file, status: 'intact' };
  const was = seal.records;
  const count = (k: keyof Seal['records']) => (now.records[k] === was[k] ? `${was[k]} ${k}` : `${k} ${was[k]} → ${now.records[k]}`);
  return broken(`records dated on or before ${seal.through} changed since it was sealed on ${seal.sealedAt} (${(['entries', 'transactions', 'mappings'] as const).map(count).join(', ')})`);
}

/** Every seal checked against the books, and the closed quarters with records but no seal. */
export function checkSeals(ws: Workspace, books: Records & Pick<Index, 'config'>): SealReport {
  const closedThrough = books.config?.closedThrough;
  const files = sealFiles(ws);
  const checks = files.map(({ quarter, file }) => check(books, closedThrough, quarter, file));
  const sealed = new Set(files.map((f) => f.quarter));
  const dates = [...books.transactions.map((t) => t.date), ...(books.journalEntries ?? []).map((e) => e.date)].filter(Boolean).sort();
  const unsealed: QuarterKey[] = [];
  if (closedThrough && dates.length) {
    for (let q = periodKeyOf(dates[0], ws.filingLength); quarterEnd(q) <= closedThrough; q = nextQuarter(q)) {
      const { from, to } = derivePeriod(q)!;
      if (!sealed.has(q) && dates.some((d) => d >= from && d <= to)) unsealed.push(q);
    }
  }
  return { checks, unsealed };
}

/** The filing period of `length` that holds `date`. */
export const periodKeyOf = (date: string, length: FilingLength): QuarterKey => filingKeyOf(date, length) as QuarterKey;

/** The filing period after `q`, of the same length. */
export function nextQuarter(q: QuarterKey): QuarterKey {
  return filingKeyOf(addDays(quarterEnd(q), 1), derivePeriod(q)!.kind) as QuarterKey;
}

/** Whether `q` is the last filing period of its year: it closes with the year, not on its own. */
export const closesTheYear = (q: QuarterKey): boolean => quarterEnd(q).endsWith('-12-31');

export type SealResult = { status: 'written' | 'intact'; file: string; seal?: Seal };

/**
 * Writes the seal of a closed quarter. Idempotent: an intact seal is left as it is. Throws for a
 * quarter that is not closed, and for a broken seal, which is never overwritten.
 */
export function writeSeal(ws: Workspace, books: Records & Pick<Index, 'config'>, quarter: QuarterKey, sealedAt: string): SealResult {
  const closedThrough = books.config?.closedThrough;
  const through = quarterEnd(quarter);
  if (!closedThrough || closedThrough < through) {
    throw new Error(`${quarter} is not closed (config.closedThrough ${closedThrough ?? 'not set'}). Close it with npm run seal -- ${quarter} --close, once its return is filed.`);
  }
  const file = sealFile(ws, quarter);
  if (existsSync(file)) {
    const c = check(books, closedThrough, quarter, file);
    if (c.status === 'broken') throw new Error(`${file} is broken: ${c.problem}. A seal is never rewritten; restore the books from git (npm run check-closed shows what changed).`);
    return { status: 'intact', file };
  }
  const seal = sealOf(books, quarter, sealedAt);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(seal, null, 2) + '\n', { flag: 'wx' });
  return { status: 'written', file, seal };
}
