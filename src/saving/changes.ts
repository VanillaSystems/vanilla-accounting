/**
 * What Änderungen reads (docs/0.4.0/ui/design.md): the AI's draft in data/draft/ against the books
 * folder, customizing files changed outside the app against git's HEAD, records the app has not
 * committed, and Verlauf. Only this module and records.ts read or write git.
 */
import fs, { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import git from 'isomorphic-git';
import { repositoryAt } from '../workspace/git.js';
import { LAYOUT, yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';
import { counts, type ChangesView, type FileChange, type FileDiff, type SaveDetail, type SaveSummary } from './model.js';

type Ws = Pick<Workspace, 'paths'>;

/** The customizing of the app's folder: what a person or the AI changes and saves in Änderungen. Records are the app's own path. */
export function customizingNames(): string[] {
  const top = Object.entries(LAYOUT.top).filter(([name, owner]) => owner === 'company' && name !== 'beleg-import').map(([name]) => name);
  return [...top, 'logos', 'master-data'];
}

/** The records: committed by the app (records.ts), never through Änderungen. */
export const recordsPaths = (ws: Ws): string[] => [ws.paths.ledger, ws.paths.transactional, ws.paths.invoices];

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

/** How many of the books' own files differ from HEAD (the app commits them; normally zero). */
export async function booksUnsaved(ws: Ws): Promise<number> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return 0;
  // Only the books' own files: hashing every receipt and statement (hundreds of MB) would make the page slow.
  const own = [ws.paths.ledger, ws.paths.invoices, ...yearsOf(ws.paths).flatMap((y) => [yearPaths(ws.paths, y).books, yearPaths(ws.paths, y).runLog])];
  const rows = await git.statusMatrix({ fs, dir: repo, filepaths: own.map((p) => relative(repo, p)) });
  return rows.filter(([, head, workdir]) => !(head === 1 && workdir === 1) && !(head === 0 && workdir === 0)).length;
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
  const [draft, outside, unsaved, log] = [draftChanges(ws), await outsideChanges(ws), await booksUnsaved(ws), await history(ws)];
  const rev = createHash('sha256').update(JSON.stringify([draft, outside, unsaved, log[0]?.oid])).digest('hex').slice(0, 16);
  return { rev, repository, draft, outside, booksUnsaved: unsaved, history: log, sync: { remote: false, ahead: 0 } };
}

/** One save: its message and the files it changed against its parent. */
export async function saveDetail(ws: Ws, oid: string): Promise<SaveDetail | undefined> {
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
  const undo = s.kind === 'customizing' ? 'draft' as const : s.kind === 'books' && s.run && !s.locked ? 'reverse' as const : undefined;
  return { ...s, body: c.commit.message, files: changed, ...(undo ? { undo } : {}) };
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
