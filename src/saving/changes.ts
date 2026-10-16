/**
 * What Änderungen reads (docs/0.4.0/ui/design.md, the mockup's screen 7): the books as they differ
 * from the last save, the AI's draft in data/draft/ against the books folder, customizing files
 * changed outside the app against git's HEAD, and Verlauf. Only this module and saving.ts read or
 * write git (and the year close, which commits itself as a locked save).
 */
import fs, { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import git from 'isomorphic-git';
import { repositoryAt } from '../workspace/git.js';
import { LAYOUT, yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';
import { BOOK_FILES, fromJsonl } from '../books/years.js';
import { hasBooks, loadBooks, periodLock, type Books } from '../books/store.js';
import type { JournalEntry } from '../types/index.js';
import { counts, type BooksChange, type HandEdit, type ChangesView, type FileChange, type FileDiff, type SaveDetail, type SaveSummary } from './model.js';

type Ws = Pick<Workspace, 'paths'>;

/** The customizing of the app's folder: what a person or the AI changes and saves in Änderungen. Records are the app's own path. */
export function customizingNames(): string[] {
  const top = Object.entries(LAYOUT.top).filter(([name, owner]) => owner === 'company' && name !== 'beleg-import').map(([name]) => name);
  return [...top, 'logos', 'master-data'];
}

/** The records: the books, which a save of kind books commits. */
export const recordsPaths = (ws: Ws): string[] => [ws.paths.ledger, ws.paths.transactional, ws.paths.invoices, join(ws.paths.root, 'collected')];

export const draftDir = (ws: Ws): string => join(ws.paths.data, 'draft');

const files = (dir: string, base = dir): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = join(dir, d.name);
  return d.isDirectory() ? files(p, base) : [relative(base, p)];
}) : []);
const read = (p: string): string => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : '');

/** The draft's files against the books folder. */
export function draftChanges(ws: Ws): FileChange[] {
  const dir = draftDir(ws);
  return files(dir).sort().flatMap((path): FileChange[] => {
    const before = read(join(ws.paths.root, path));
    const after = read(join(dir, path));
    if (before === after) return [];
    return [{ path, state: existsSync(join(ws.paths.root, path)) ? 'modified' : 'added', ...counts(before, after) }];
  });
}

/** The repository-relative path of a path in the app's folder. */
const inRepo = (ws: Ws, path: string) => relative(ws.paths.repository, join(ws.paths.root, path));

async function headBlob(repo: string, filepath: string): Promise<string> {
  try {
    const oid = await git.resolveRef({ fs, dir: repo, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs, dir: repo, oid, filepath });
    return Buffer.from(blob).toString('utf8');
  } catch {
    return '';
  }
}

/** Customizing files that differ from HEAD: edited outside the app, or by a settings page. */
export async function outsideChanges(ws: Ws): Promise<FileChange[]> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return [];
  const rows = await git.statusMatrix({ fs, dir: repo, filepaths: customizingNames().map((n) => inRepo(ws, n)) });
  const out: FileChange[] = [];
  for (const [filepath, head, workdir] of rows) {
    if (head === 1 && workdir === 1) continue;
    if (head === 0 && workdir === 0) continue;
    const path = relative(relative(repo, ws.paths.root), filepath);
    const before = head ? await headBlob(repo, filepath) : '';
    const after = workdir ? read(join(repo, filepath)) : '';
    out.push({ path, state: head === 0 ? 'added' : workdir === 0 ? 'deleted' : 'modified', ...counts(before, after) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The books' own files: hashing every receipt and statement (hundreds of MB) would make the page slow. */
const ownBooks = (ws: Ws): string[] => [ws.paths.ledger, ws.paths.invoices, ...yearsOf(ws.paths).flatMap((y) => [yearPaths(ws.paths, y).books, yearPaths(ws.paths, y).runLog, yearPaths(ws.paths, y).questions])];

/** How many of the books' own files differ from the last save, and the bookings a person changed since. The runs that wrote them are the engine's to name. */
export async function booksChange(ws: Ws): Promise<BooksChange> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return { files: 0, runs: [], hand: [] };
  const rows = await git.statusMatrix({ fs, dir: repo, filepaths: ownBooks(ws).map((p) => relative(repo, p)) });
  const files = rows.filter(([, head, workdir]) => !(head === 1 && workdir === 1) && !(head === 0 && workdir === 0)).length;
  return { files, runs: [], hand: files ? await handEdits(ws) : [] };
}

const entriesIn = (text: string, file: string) => new Map((fromJsonl(text, file) as JournalEntry[]).map((e) => [e.id, e]));

/** A booking a person deleted, kept beside the books so that Änderungen can put it back also when no save ever held it (r7h-31). */
interface TrashedEntry { deletedAt: string; entry: JournalEntry; kept: string[] }

const entryTrash = (ws: Ws): string => join(ws.paths.data, 'trash', 'entries');

/**
 * Records a booking a person deleted (the API's DELETE), with the payment's other bookings at that
 * moment, so a booking a run made since the last save has its «Rückgängig» under Änderungen too.
 */
export function recordDeletion(ws: Ws, entry: JournalEntry, kept: string[], deletedAt = new Date().toISOString()): void {
  const dir = entryTrash(ws);
  fs.mkdirSync(dir, { recursive: true });
  const record: TrashedEntry = { deletedAt, entry, kept };
  fs.writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(record, null, 2));
}

/** The deletions recorded since `after` (the last save); records from before it are dropped, the save holds their story. */
function trashedSince(ws: Ws, after: string | undefined): TrashedEntry[] {
  const dir = entryTrash(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    const path = join(dir, f);
    const record = JSON.parse(readFileSync(path, 'utf8')) as TrashedEntry;
    if (after && record.deletedAt <= after) { fs.rmSync(path, { force: true }); return []; }
    return [record];
  });
}

/**
 * The bookings a person changed, booked or deleted by hand, or the AI sidebar on her wish, since
 * the last save: those whose `by` names a person or the AI sidebar and that differ from the last
 * save, each with the booking as that save holds it; the saved bookings that are gone while
 * their payment got no booking since (r6h-28), dated by the file's last write; and the deletions
 * the app recorded since the last save (recordDeletion), also of a booking a run made meanwhile
 * and of one whose payment got booked again since: its restore takes that booking out (r7h-31).
 * A saved booking replaced by a re-booking is listed through the bookings that replaced it.
 */
export async function handEdits(ws: Ws): Promise<HandEdit[]> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return [];
  const out: HandEdit[] = [];
  const trashed = trashedSince(ws, await lastSaveAt(ws));
  // A booking in a filed period is as filed: no «Rückgängig» on it (r7h-36).
  const closedThrough = (JSON.parse(read(ws.paths.ledger) || '{}') as { config?: { closedThrough?: string } }).config?.closedThrough ?? '';
  for (const year of yearsOf(ws.paths)) {
    const path = join(yearPaths(ws.paths, year).books, BOOK_FILES.journalEntries);
    const now = entriesIn(read(path), path);
    const saved = entriesIn(await headBlob(repo, relative(repo, path)), path);
    for (const e of now.values()) {
      if ((e.by?.kind !== 'person' && e.by?.kind !== 'assistant') || e.date <= closedThrough) continue;
      const was = saved.get(e.id);
      if (was && JSON.stringify(was) === JSON.stringify(e)) continue;
      out.push({ id: e.id, ref: e.transactionRef, date: e.date, text: e.description ?? e.transactionRef, at: e.by.at, ...(e.by.kind === 'assistant' ? { ai: true } : {}), ...(was ? { saved: was } : {}) });
    }
    const bookedSince = new Set([...now.values()].filter((e) => !saved.has(e.id)).map((e) => e.transactionRef));
    const wrote = existsSync(path) ? statSync(path).mtime.toISOString() : '';
    for (const was of saved.values()) {
      if (now.has(was.id) || bookedSince.has(was.transactionRef) || was.date <= closedThrough) continue;
      out.push({ id: was.id, ref: was.transactionRef, date: was.date, text: was.description ?? was.transactionRef, at: wrote, deleted: true, saved: was });
    }
    for (const { deletedAt, entry, kept } of trashed) {
      if (entry.date.slice(0, 4) !== year || now.has(entry.id) || out.some((h) => h.id === entry.id) || entry.date <= closedThrough) continue;
      out.push({ id: entry.id, ref: entry.transactionRef, date: entry.date, text: entry.description ?? entry.transactionRef, at: deletedAt, deleted: true, saved: entry, kept });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The books as they are now, as one fingerprint: their own files' content and the names of the receipts and statements beside them. */
export function booksBasis(ws: Ws): string {
  const h = createHash('sha256');
  for (const p of ownBooks(ws)) for (const f of existsSync(p) && statSync(p).isDirectory() ? files(p).sort().map((x) => join(p, x)) : [p]) h.update(f).update(read(f));
  for (const y of yearsOf(ws.paths)) for (const part of [yearPaths(ws.paths, y).receipts, yearPaths(ws.paths, y).statements]) h.update(files(part).sort().join('\n'));
  return h.digest('hex').slice(0, 16);
}

/** When the last save was made: what counts as since. */
export async function lastSaveAt(ws: Ws): Promise<string | undefined> {
  return (await history(ws, 1))[0]?.at;
}

const trailer = (message: string, key: string): string | undefined => message.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1];

function summary(c: Awaited<ReturnType<typeof git.log>>[number]): SaveSummary {
  const kind = trailer(c.commit.message, 'Vanilla-Kind');
  const run = trailer(c.commit.message, 'Vanilla-Run');
  return {
    oid: c.oid, short: c.oid.slice(0, 7), at: new Date(c.commit.author.timestamp * 1000).toISOString(), author: c.commit.author.name,
    subject: c.commit.message.split('\n')[0], kind: kind === 'books' ? 'books' : kind === 'customizing' ? 'customizing' : 'outside', ...(run ? { run } : {}),
    ...(trailer(c.commit.message, 'Vanilla-Lock') ? { locked: true } : {}),
  };
}

export async function history(ws: Ws, depth = 200): Promise<SaveSummary[]> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return [];
  try {
    return (await git.log({ fs, dir: repo, depth })).map(summary);
  } catch {
    return [];
  }
}

export async function changesView(ws: Ws): Promise<ChangesView> {
  const repository = !!(await repositoryAt(ws.paths.repository));
  const [draft, outside, books, log] = [draftChanges(ws), await outsideChanges(ws), await booksChange(ws), await history(ws)];
  const rev = createHash('sha256').update(JSON.stringify([draft, outside, books, log[0]?.oid])).digest('hex').slice(0, 16);
  return { rev, repository, draft, outside, books, history: log, sync: { remote: false, ahead: 0 } };
}

/** One save: its message and the files it changed against its parent. */
export async function saveDetail(ws: Workspace, oid: string): Promise<SaveDetail | undefined> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return undefined;
  const [c] = await git.log({ fs, dir: repo, ref: oid, depth: 2 }).catch(() => []);
  if (!c) return undefined;
  const parent = c.commit.parent[0];
  const changed: FileChange[] = [];
  await git.walk({
    fs, dir: repo, trees: [git.TREE({ ref: parent ?? oid }), git.TREE({ ref: oid })],
    map: async (filepath, [a, b]) => {
      if (filepath === '.') return true;
      const [ta, tb] = [await a?.type(), await b?.type()];
      if (ta === 'tree' || tb === 'tree') return true;
      const [oa, ob] = [parent ? await a?.oid() : undefined, await b?.oid()];
      if (oa === ob) return false;
      const text = async (e: typeof a) => (e ? Buffer.from((await e.content()) ?? new Uint8Array()).toString('utf8') : '');
      changed.push({ path: filepath, state: !oa ? 'added' : !ob ? 'deleted' : 'modified', ...counts(await text(parent ? a : null), await text(b)) });
      return false;
    },
  });
  const s = summary(c);
  const blocked = s.kind === 'books' && s.run && !s.locked && hasBooks(ws) ? undoBlockedBy(loadBooks(ws), s.run) : undefined;
  const undo = s.kind === 'customizing' ? 'draft' as const : s.kind === 'books' && s.run && !s.locked && !blocked ? 'reverse' as const : undefined;
  return { ...s, body: c.commit.message, files: changed, ...(undo ? { undo } : {}), ...(blocked ? { undoBlocked: blocked } : {}) };
}

/** The bookings of a run that are not reversed yet, whatever their period. */
export function unreversedOf(books: Books, runId: string): JournalEntry[] {
  const reversedIds = new Set(books.journalEntries.flatMap((e) => (e.id.startsWith('storno-') ? [e.id.slice('storno-'.length)] : [])));
  return books.journalEntries.filter((e) => e.run === runId && !reversedIds.has(e.id));
}

/** Why a run's save offers no Rückgängig: nothing of it is left to reverse, or what is left lies in a filed period (r7f-36). */
export function undoBlockedBy(books: Books, runId: string): 'closed' | 'reversed' | undefined {
  const own = unreversedOf(books, runId);
  if (!own.length) return 'reversed';
  const lock = periodLock(books);
  return own.every((e) => lock.isClosed(e.date)) ? 'closed' : undefined;
}

/** Before and after of one file: in the draft, outside the app, or in a save. */
export async function fileDiff(ws: Ws, source: string, path: string): Promise<FileDiff | undefined> {
  const repo = await repositoryAt(ws.paths.repository);
  if (source === 'draft') return { path, before: read(join(ws.paths.root, path)), after: read(join(draftDir(ws), path)) };
  if (source === 'outside') return repo ? { path, before: await headBlob(repo, inRepo(ws, path)), after: read(join(ws.paths.root, path)) } : undefined;
  if (!repo) return undefined;
  const [c] = await git.log({ fs, dir: repo, ref: source, depth: 1 }).catch(() => []);
  if (!c) return undefined;
  const blobAt = async (oid: string | undefined) => {
    if (!oid) return '';
    try { return Buffer.from((await git.readBlob({ fs, dir: repo, oid, filepath: path })).blob).toString('utf8'); } catch { return ''; }
  };
  return { path, before: await blobAt(c.commit.parent[0]), after: await blobAt(c.oid) };
}
