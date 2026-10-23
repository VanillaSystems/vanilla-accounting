/**
 * The one owner of the workspace's books: load, save, their schema (src/workspace/schema.ts),
 * and golden rule 1 (AGENTS.md), nothing dated on or before config.closedThrough ever changes:
 * `update` while the app runs, the seals of the filed quarters (src/books/seal.ts) on load.
 *
 * On disk (ADR 0013) the books are ledger.json (schema and config) and, per fiscal year,
 * transactional-data/<year>/books/*.jsonl, one record per line, sorted by id (src/books/years.ts).
 * A closed year's files are never written; saveBooks refuses books that would change one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AccountingConfig, ApprovedReturn, FiledFigures, Index, JournalEntry, Receipt } from '../types/index.js';
import { vat } from '../engines/index.js';
import { APP_FOLDER, findFile, yearPaths, yearsOf, type Workspace, type WorkspacePaths } from '../workspace/workspace.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, climb, schemaOf } from '../workspace/schema.js';
import type { ClosedReason } from '../types/api-error.js';
import { checkSeals, closedPart, type SealReport } from './seal.js';
import { parseBookedBy } from './booked-by.js';
import { BOOK_FILES, PARTS, fromJsonl, isClosedYear, keyOf, placement, splitByYear, statementFile, toJsonl, type InClosedYear, type Part } from './years.js';

export type Books = Index & { journalEntries: JournalEntry[]; config: AccountingConfig };

export class ClosedPeriodError extends Error {
  /**
   * `reason` names which refusal (src/types/api-error.ts) when the API's assertOpen threw it;
   * `approved` the period whose approved return holds the date, when it is held and not filed;
   * `filed` the period filed with the tax authority and not sealed, whose return the change would move the
   * books away from (r10h-4).
   */
  constructor(message: string, readonly closedThrough?: string, readonly reason?: ClosedReason, readonly approved?: string, readonly filed?: string) { super(message); }
}
/** An entry dated before the books' first day (booksOpen): that year's result is in the opening balances (#39). */
export class BeforeBooksError extends ClosedPeriodError {}
/** A filed quarter's seal no longer matches the books: they read, but are never written. */
export class SealBrokenError extends ClosedPeriodError {}
/** A workspace in the layout before ADR 0013 (books.json beside the manifest): npm run update moves it. */
export class OldLayoutError extends Error {}
/**
 * Another process wrote the books since these were loaded (ADR 0004: the content read is the
 * expected state). Nothing was saved; load the books again and redo the change.
 */
export class StaleBooksError extends Error {
  override name = 'StaleBooksError';
  constructor(readonly files: string[]) {
    super(`Die Bücher wurden seit dem Laden von einem anderen Prozess geändert (${files.join(', ')}), nichts gespeichert. Den Befehl noch einmal ausführen: er liest die Bücher neu.`);
  }
}

/** The books' files and ledger.json as they were read or last written; files by path relative to the workspace. */
interface Snapshot { files: Map<string, string>; ledger: string | undefined }
const onDisk = new WeakMap<Books, Snapshot>();
const seals = new WeakMap<Books, SealReport>();
const warned = new Set<string>();

const fileOf = (year: string, part: Part) => `transactional-data/${year}/books/${BOOK_FILES[part]}`;
const readIfThere = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** The books' files of the workspace, by path relative to it. */
function readFiles(paths: WorkspacePaths): Map<string, string> {
  const files = new Map<string, string>();
  for (const year of yearsOf(paths)) {
    for (const part of PARTS) {
      const rel = fileOf(year, part);
      const full = join(paths.root, rel);
      if (existsSync(full)) files.set(rel, readFileSync(full, 'utf8'));
    }
  }
  return files;
}

/**
 * The books at the current schema (older ones are migrated in memory, a newer one is refused),
 * with every seal checked. A broken seal is printed once per process, and saveBooks refuses them.
 * Files of open years that lie in another year than their record says move there (placeFiles).
 */
export function loadBooks(ws: Workspace): Books {
  const { ledger, root } = ws.paths;
  if (!existsSync(ledger)) {
    if (existsSync(join(root, 'books.json'))) {
      throw new OldLayoutError(`${root} holds the books in the layout before 0.4.0 (books.json). Run npm run update: it moves them into ${APP_FOLDER}/ and splits them by year (ADR 0013).`);
    }
    throw new Error(`No ${ledger} found: set up the books with npm run init.`);
  }
  const ledgerText = readFileSync(ledger, 'utf8');
  const head = JSON.parse(ledgerText) as Record<string, unknown>;
  const files = readFiles(ws.paths);
  const raw: Record<string, unknown> = { schema: head.schema, config: head.config ?? {}, journalEntries: [], receipts: [], transactions: [], mappings: [], bankStatements: [] };
  for (const year of yearsOf(ws.paths)) {
    for (const part of PARTS) {
      const rel = fileOf(year, part);
      const text = files.get(rel);
      if (text !== undefined) raw[part] = [...((raw[part] as unknown[] | undefined) ?? []), ...fromJsonl(text, rel)];
    }
  }
  const current = climb<Record<string, unknown>>(raw, schemaOf(raw.schema, ledger), BOOKS_SCHEMA, BOOKS_MIGRATIONS, ledger, (d) => structuredClone(d));
  const books = { ...current, schema: BOOKS_SCHEMA } as unknown as Books;
  for (const e of books.journalEntries) {
    if (!('by' in e) || parseBookedBy(e.by)) continue;
    console.error(`${e.id}: «by» ${JSON.stringify(e.by)} reads as none of its kinds; the entry shows what its origin says.`);
    delete e.by;
  }
  onDisk.set(books, { files, ledger: ledgerText });
  const report = checkSeals(ws, books);
  seals.set(books, report);
  for (const c of report.checks) {
    if (c.status !== 'broken' || warned.has(c.file)) continue;
    warned.add(c.file);
    console.error(`\n!!! SEAL BROKEN: ${c.quarter} is filed, but ${c.problem}.\n!!! ${c.file}\n!!! The books open read-only. Restore the books from git; npm run check-closed shows what changed.\n`);
  }
  if (!report.checks.some((c) => c.status === 'broken')) placeFiles(ws, books);
  return books;
}

/** Whether the workspace has books yet; true for books in the old layout too, which loadBooks refuses. */
export const hasBooks = (ws: Workspace): boolean => existsSync(ws.paths.ledger) || existsSync(join(ws.paths.root, 'books.json'));

/** The seal check loadBooks ran on these books. */
export function sealsOf(books: Books): SealReport {
  return seals.get(books) ?? { checks: [], unsealed: [] };
}

/** The books before anything is read in. */
export const emptyBooks = (): Books => ({ schema: BOOKS_SCHEMA, receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [], config: {} });

/** Whether a record lay in a closed year's books when they were read. */
function closedRecords(books: Books): InClosedYear {
  const files = onDisk.get(books)?.files ?? new Map<string, string>();
  const keys = new Map<string, Set<string>>();
  return (year, part, key) => {
    if (!isClosedYear(year, books.config.closedThrough)) return false;
    const rel = fileOf(year, part);
    if (!keys.has(rel)) {
      const text = files.get(rel);
      keys.set(rel, new Set(text ? fromJsonl(text, rel).map((r) => (keyOf[part] as (x: unknown) => string)(r)) : []));
    }
    return keys.get(rel)!.has(key);
  };
}

/** The books' files for `books`, by path relative to the workspace, and the ledger. */
function render(books: Books, inClosed: InClosedYear): { files: Map<string, string>; ledger: string } {
  const { schema: _, config, ...records } = books;
  const files = new Map<string, string>();
  for (const [year, parts] of splitByYear(records, config, inClosed)) {
    for (const [part, list] of parts) files.set(fileOf(year, part), toJsonl(list));
  }
  return { files, ledger: JSON.stringify({ schema: BOOKS_SCHEMA, config }, null, 2) + '\n' };
}

const writeAtomic = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

/**
 * Writes the books' files that changed, each atomically, then moves the files of open years to
 * where their records say (placeFiles). Throws, before writing anything, for a broken seal, a
 * check of an `update` in flight, a change to a closed year's files, and StaleBooksError when
 * ledger.json or a file about to change is no longer what these books were read from (#123).
 */
export function saveBooks(ws: Workspace, books: Books): void {
  const broken = sealsOf(books).checks.find((c) => c.status === 'broken');
  if (broken) throw new SealBrokenError(`Siegel ${broken.quarter} gebrochen, nichts gespeichert: ${broken.problem}. Restore the books from git.`);
  guards.get(books)?.();
  const before = onDisk.get(books) ?? { files: readFiles(ws.paths), ledger: readIfThere(ws.paths.ledger) };
  const { files, ledger } = render(books, closedRecords(books));
  const closedThrough = books.config.closedThrough;
  const yearOfFile = (rel: string) => rel.split('/')[1];
  const changed = [...new Set([...before.files.keys(), ...files.keys()])].filter((rel) => before.files.get(rel) !== files.get(rel));
  const closed = changed.filter((rel) => isClosedYear(yearOfFile(rel), closedThrough));
  if (closed.length) throw new ClosedPeriodError(`Das Jahr ${yearOfFile(closed[0])} ist abgeschlossen, nichts gespeichert: ${closed.join(', ')} würde sich ändern.`, closedThrough);
  const stale = changed.filter((rel) => readIfThere(join(ws.paths.root, rel)) !== before.files.get(rel));
  if (readIfThere(ws.paths.ledger) !== before.ledger) stale.push(relative(ws.paths.root, ws.paths.ledger));
  if (stale.length) throw new StaleBooksError(stale);
  for (const rel of changed) {
    const text = files.get(rel);
    if (text === undefined) rmSync(join(ws.paths.root, rel), { force: true });
    else writeAtomic(join(ws.paths.root, rel), text);
  }
  if (before.ledger !== ledger) writeAtomic(ws.paths.ledger, ledger);
  onDisk.set(books, { files, ledger });
  placeFiles(ws, books);
}

/**
 * Writes `index` as the books of a workspace that has none yet, or replaces them whole: for
 * `npm run init`, the layout migration, the demo generator and tests. Every record lies in the
 * year of its own date, closed or not. Loaded books are saved with saveBooks, which keeps closed
 * years and seals.
 */
export function writeBooks(paths: WorkspacePaths, index: Index): void {
  for (const year of yearsOf(paths)) rmSync(yearPaths(paths, year).books, { recursive: true, force: true });
  const books = { journalEntries: [], ...index, config: index.config ?? {} } as Books;
  const { files, ledger } = render(books, () => true);
  for (const [rel, text] of files) writeAtomic(join(paths.root, rel), text);
  writeAtomic(paths.ledger, ledger);
}

// ─── Files by year ──────────────────────────────────────────────────────────

/** The folder a receipt's file belongs in: beleg-import/ until it is matched, its year's receipts/ after. */
export function receiptHome(ws: Workspace, books: Books, receipt: Receipt): string {
  if (receipt.location === 'staged') return ws.paths.inbox;
  return yearPaths(ws.paths, placement(books, books.config, closedRecords(books)).receipt(receipt)).receipts;
}

/** Where a receipt's file lies now: beleg-import/, or the year folder that holds it (its home when none does yet). */
export function receiptFile(ws: Workspace, books: Books, receipt: Receipt): string {
  if (receipt.location === 'staged') return join(ws.paths.inbox, receipt.filename);
  return findFile(ws.paths, 'receipts', receipt.filename) ?? join(receiptHome(ws, books, receipt), receipt.filename);
}

/**
 * Moves each receipt and statement file of an open year to the year its record says, when that
 * is open too. Idempotent: a run after a crash finishes the moves the last one left.
 */
export function placeFiles(ws: Workspace, books: Books): void {
  const closedThrough = books.config.closedThrough;
  const place = placement(books, books.config, closedRecords(books));
  const move = (part: 'receipts' | 'statements', name: string, year: string) => {
    if (isClosedYear(year, closedThrough)) return;
    const from = findFile(ws.paths, part, name);
    const to = join(yearPaths(ws.paths, year)[part], name);
    if (!from || from === to || isClosedYear(relative(ws.paths.transactional, from).split('/')[0], closedThrough)) return;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  };
  for (const r of books.receipts) if (r.location !== 'staged') move('receipts', r.filename, place.receipt(r));
  for (const s of books.bankStatements) move('statements', statementFile(s), place.statement(s));
}

export interface PeriodLock {
  /** The filed line: golden rule 1. */
  closedThrough: string | undefined;
  /** The return approved and not yet filed, whose period is held like a filed one (r7h-24). */
  approved: ApprovedReturn | undefined;
  /** The last day the books are locked through: the filed line, or the held period's end when it lies after. */
  lockedThrough: string | undefined;
  isClosed(date: string | undefined): boolean;
  /** The period's approval when `date` is held by it and not filed; undefined when filed or open. */
  heldBy(date: string | undefined): ApprovedReturn | undefined;
  /** «Periode geschlossen bis …» or «… ist freigegeben …»: the words a refusal of `date` begins with. */
  closedText(date: string | undefined): string;
  assertOpen(date: string | undefined, what: string): void;
  /** The books' first day (booksOpen); nothing is dated before it. */
  opens: string | undefined;
  beforeBooks(date: string | undefined): boolean;
}

/**
 * The books' first day: 1 January of the first year with opening balances, else of the year of the
 * earliest payment; undefined for books with neither. The year before is the opening balances'
 * (#39): no entry is dated in it and no year folder is made for it.
 */
export function booksOpen(books: { config?: Pick<AccountingConfig, 'openingBalances'>; transactions?: readonly { date: string }[] }): string | undefined {
  const year = Object.keys(books.config?.openingBalances ?? {}).sort()[0]
    ?? (books.transactions ?? []).reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined)?.slice(0, 4);
  return year && `${year}-01-01`;
}

export function periodLock(books: Pick<Index, 'config'> & { transactions?: readonly { date: string }[] }): PeriodLock {
  let first: { day: string | undefined } | undefined;
  const opens = () => (first ??= { day: booksOpen(books) }).day;
  const closedThrough = books.config?.closedThrough;
  const approved = books.config?.approvedReturn;
  const lockedThrough = approved && (!closedThrough || approved.through > closedThrough) ? approved.through : closedThrough;
  const isClosed = (date: string | undefined) => !!lockedThrough && !!date && date <= lockedThrough;
  const heldBy = (date: string | undefined) => (isClosed(date) && !(closedThrough && date! <= closedThrough) ? approved : undefined);
  const closedText = (date: string | undefined) => {
    const held = heldBy(date);
    if (held?.filed) return `${held.period} ist bei der Steuerbehörde eingereicht, die Bücher weichen von der Abrechnung ab: bis ${held.through} nur Änderungen, die sie zur eingereichten Abrechnung zurückbringen.`;
    return held ? `${held.period} ist freigegeben und wartet auf die Einreichung: bis ${held.through} ändert sich nichts.` : `Periode geschlossen bis ${closedThrough}.`;
  };
  return {
    closedThrough,
    approved,
    lockedThrough,
    isClosed,
    heldBy,
    closedText,
    assertOpen(date, what) {
      if (isClosed(date)) throw new ClosedPeriodError(`${closedText(date)} ${what}`, closedThrough, undefined, heldBy(date)?.period);
    },
    get opens() { return opens(); },
    beforeBooks: (date) => { const day = opens(); return !!day && !!date && date < day; },
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
 * How far each box and the payable of `held.period` stand from the return filed, in cents
 * (r10h-4). A change a person makes in a filed, unsealed period passes the write door only when no
 * distance grows and their sum shrinks: the books come back toward the return.
 */
function filedDistance(books: Books, held: ApprovedReturn & { filed: FiledFigures }): Map<string, number> {
  const now = vat().figures(books.journalEntries, held.period, books.config.vatAdjustments ?? []);
  const boxes = new Set([...Object.keys(held.filed.figures), ...Object.keys(now.ziffern), 'payable']);
  const rappen = (x: number | undefined) => Math.round((x ?? 0) * 100);
  const at = (z: string, f: { figures: Record<string, number>; payable: number }) => (z === 'payable' ? f.payable : f.figures[z]);
  return new Map([...boxes].map((z) => [z, Math.abs(rappen(at(z, { figures: now.ziffern as Record<string, number>, payable: now.payable })) - rappen(at(z, held.filed)))]));
}

const filedHoldOf = (books: Books): (ApprovedReturn & { filed: FiledFigures }) | undefined => {
  const a = books.config?.approvedReturn;
  return a?.filed ? (a as ApprovedReturn & { filed: FiledFigures }) : undefined;
};

/**
 * The one write door. Runs `fn` as `actor`, then throws ClosedPeriodError if any closed-period
 * journal entry, closed transaction, or mapping to a closed transaction was changed, added or
 * removed (golden rule 1), and OwnershipError if an actor other than a person changed or removed
 * a person's entry. A saveBooks inside `fn` runs the same checks before it writes. One exception
 * (r10h-4): in a period filed with the tax authority whose books differ from the return (approvedReturn.filed),
 * a person's change passes only when it brings the books closer to the figures filed: no box
 * and not the payable moves further away, and together they come closer. So the books can be
 * brought back and then sealed; any other change, a run's or a module's, is refused there.
 */
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => Promise<T>): Promise<T>;
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => T): T;
export function update<T>(books: Books, actor: Actor, fn: (books: Books) => T | Promise<T>): T | Promise<T> {
  const was = periodLock(books);
  const before = { lockedThrough: was.lockedThrough, ...closedPart(books, was.lockedThrough) };
  const filedHold = actor.kind === 'person' ? filedHoldOf(books) : undefined;
  const filedPart = filedHold ? closedPart(books, was.closedThrough) : undefined;
  const distanceBefore = filedHold ? filedDistance(books, filedHold) : undefined;
  const persons = actor.kind === 'person' ? undefined : personsEntries(books);
  const dated = new Map(books.journalEntries.map((e) => [e.id, e.date]));
  const check = () => {
    const lock = periodLock(books);
    const early = books.journalEntries.filter((e) => lock.beforeBooks(e.date) && dated.get(e.id) !== e.date);
    if (early.length) throw new BeforeBooksError(`Die Bücher beginnen am ${lock.opens}: ${early.map((e) => `entry ${e.id} dated ${e.date}`).join('; ')}.`, `${Number(lock.opens!.slice(0, 4)) - 1}-12-31`);
    if (lock.lockedThrough !== before.lockedThrough) {
      throw new ClosedPeriodError(`the period lock moved from ${before.lockedThrough} to ${lock.lockedThrough} (closedThrough, approvedReturn).`, lock.closedThrough);
    }
    const after = closedPart(books, lock.lockedThrough);
    const changed = (['entries', 'transactions', 'mappings'] as const).flatMap((k) => diff(k, before[k], after[k]));
    if (changed.length && filedHold && filedPart && distanceBefore) {
      const sealed = closedPart(books, lock.closedThrough);
      const inFiled = (['entries', 'transactions', 'mappings'] as const).flatMap((k) => diff(k, filedPart[k], sealed[k]));
      if (inFiled.length) throw new ClosedPeriodError(`Periode geschlossen bis ${lock.closedThrough}. ${inFiled.join('; ')}`, lock.closedThrough);
      const distanceAfter = filedDistance(books, filedHold);
      const worse = [...distanceAfter].filter(([z, d]) => d > (distanceBefore.get(z) ?? 0)).map(([z]) => z);
      const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
      if (worse.length || sum(distanceAfter) >= sum(distanceBefore)) {
        const why = worse.length ? `die Änderung entfernt die Bücher weiter von der eingereichten Abrechnung (Feld ${worse.join(', ')})` : 'die Änderung bringt die Bücher der eingereichten Abrechnung nicht näher';
        throw new ClosedPeriodError(`${filedHold.period} ist bei der Steuerbehörde eingereicht: ${why}. Nur Wiederherstellen, dann «Weiter»; eine andere Korrektur als neue Buchung in der offenen Periode.`, lock.closedThrough, undefined, undefined, filedHold.period);
      }
    } else if (changed.length) {
      throw new ClosedPeriodError(`${lock.closedText(lock.lockedThrough)} ${changed.join('; ')}`, lock.closedThrough, undefined, lock.heldBy(lock.lockedThrough)?.period);
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
