/**
 * «Teilen…» on the sharer's side (docs/specs/e2e-and-fiduciary.md B3.1, B3.4, B3.5): what a hand-over
 * to a person carries, and the package itself. Every hand-over, by link or by file, is whole (`full`):
 * the books' files and every receipt, statement and invoice of the open years (a closed year's only
 * «mit Archiv»), so any one of them opens on any computer, on a copy that is lost, older or missing a
 * receipt alike (the owner's decision of 2026-11-15: no update that builds on what the person is
 * thought to hold). Each hand-over writes a version (B7) and keeps its index and records in
 * handover/sent/: a return is merged against the version it was made on.
 */
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import git from 'isomorphic-git';
import { isClosedYear } from '../books/years.js';
import { loadBooks } from '../books/store.js';
import { committedAsIs, repositoryAt } from '../workspace/git.js';
import type { Workspace } from '../workspace/workspace.js';
import { appVersion } from '../version.js';
import { checksumOf, contentFiles, factOf, type FileFact } from './content.js';
import { PACKAGE_FORMAT, packageName, writePackage, type PackageIndex, type Question } from './package.js';
import { nextVersion, writeVersion, VERSIONS_FILE, type Party, type Version } from './versions.js';
import { pendingQuestions, takeQuestions } from './returns.js';

/** The sharer's own folder of hand-overs in the workspace: sent/ (each version's index), returns/ (what came back). */
export const HANDOVER_DIR = 'handover';
const sentFile = (ws: Pick<Workspace, 'paths'>, n: number) => join(ws.paths.root, HANDOVER_DIR, 'sent', `v${n}.json`);
/** The books' record files of the version `n` as handed over: the base a return from that person is merged against. */
export const baseDirOf = (ws: Pick<Workspace, 'paths'>, n: number): string => join(ws.paths.root, HANDOVER_DIR, 'sent', `v${n}`);
const isBaseFile = (p: string) => p === 'ledger.json' || p === 'master-data/accounts.json' || p.startsWith('knowledge/') || /^transactional-data\/\d{4}\/books\//.test(p);

export interface ShareRequest {
  to: Party;
  message?: string;
  /** «mit Archiv <Jahr>»: closed years whose receipts and statements go along. */
  archive?: string[];
}

/** What a hand-over would carry, before it is made: the dialog names it with its size. */
export interface SharePlan {
  kind: 'full';
  to: Party;
  files: FileFact[];
  omitted: FileFact[];
  /** The bytes of the files carried. */
  bytes: number;
  /** The receipts, statements and invoices carried (the books' own files go besides). */
  documents: number;
  /** Closed years whose receipts stay home unless asked for. */
  closedYears: string[];
  /** The questions of earlier returns that go along. */
  questions: number;
}

export function planShare(ws: Workspace, req: ShareRequest): SharePlan {
  const closedThrough = loadBooks(ws).config.closedThrough;
  const files = contentFiles(ws.paths.root).map((f) => ({ ...f, ...factOf(ws.paths.root, f.path) }));
  const closedYears = [...new Set(files.flatMap((f) => (f.year && isClosedYear(f.year, closedThrough) ? [f.year] : [])))].sort();
  const archive = new Set(req.archive ?? []);
  const out: SharePlan = { kind: 'full', to: req.to, files: [], omitted: [], bytes: 0, documents: 0, closedYears, questions: pendingQuestions(ws, req.to).length };
  for (const f of files) {
    const fact: FileFact = { path: f.path, sha256: f.sha256, blob: f.blob, bytes: f.bytes };
    if (f.carriage === 'whole') { out.files.push(fact); continue; }
    // A closed year's receipts and statements stay home unless asked for (B3.5): their checksums go along.
    if (f.year && isClosedYear(f.year, closedThrough) && !archive.has(f.year)) { out.omitted.push(fact); continue; }
    out.files.push(fact);
    out.documents++;
  }
  out.bytes = out.files.reduce((n, f) => n + f.bytes, 0);
  return out;
}

/**
 * The version's commit and its tree objects, when the repository holds the content exactly as it
 * is on disk: the recipient can rebuild the commit from the files (B3.4). None for books outside a
 * repository or with changes not saved yet.
 */
async function gitSide(ws: Workspace, paths: string[]): Promise<PackageIndex['git']> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return undefined;
  try {
    const inRepo = paths.map((p) => relative(repo, join(ws.paths.root, p)));
    const clean = await committedAsIs(repo, inRepo);
    if (clean.size !== inRepo.length) return undefined;
    const commit = await git.resolveRef({ fs, dir: repo, ref: 'HEAD' });
    const objects: Record<string, string> = {};
    const raw = async (oid: string) => Buffer.from((await git.readObject({ fs, dir: repo, oid, format: 'content' })).object as Uint8Array).toString('base64');
    objects[commit] = await raw(commit);
    const { commit: c } = await git.readCommit({ fs, dir: repo, oid: commit });
    const trees = [c.tree];
    for (let oid = trees.pop(); oid; oid = trees.pop()) {
      if (objects[oid]) continue;
      objects[oid] = await raw(oid);
      const { tree } = await git.readTree({ fs, dir: repo, oid });
      trees.push(...tree.filter((e) => e.type === 'tree').map((e) => e.oid));
    }
    return { commit, objects };
  } catch {
    return undefined;
  }
}

export interface ShareResult { version: Version; name: string; bytes: Uint8Array; index: PackageIndex }

/** A hand-over made but not written down yet: `commit` writes its version, keeps its index and base, and takes its questions along. */
export interface PreparedShare { index: PackageIndex; files: Map<string, Uint8Array>; name: string; commit(): Version }

/**
 * Makes the hand-over: writes the next version (reason handover, to the person), keeps the index in
 * handover/sent/, takes the questions of earlier returns along, and returns the `.vanilla` file.
 */
export async function makeShare(ws: Workspace, req: ShareRequest, from: Party, now = new Date()): Promise<ShareResult> {
  const prepared = await prepareShare(ws, req, from, now);
  const bytes = writePackage({ index: prepared.index, files: prepared.files });
  const version = prepared.commit();
  return { version, name: prepared.name, bytes, index: prepared.index };
}

/**
 * The hand-over of the next version, built without writing anything. The link through the share
 * service commits it only once the service took the package (src/share/sharing.ts): an upload that
 * fails leaves no version written.
 */
export async function prepareShare(ws: Workspace, req: ShareRequest, from: Party, now = new Date()): Promise<PreparedShare> {
  const plan = planShare(ws, req);
  const all = [...plan.files, ...plan.omitted];
  const git = await gitSide(ws, all.map((f) => f.path));
  const checksum = checksumOf(all);
  const n = nextVersion(ws.paths);
  const questions: Question[] = pendingQuestions(ws, req.to);
  const index: PackageIndex = {
    format: PACKAGE_FORMAT, kind: plan.kind,
    firm: { name: ws.company.name, ...(ws.company.uid ? { uid: ws.company.uid } : {}) },
    from, to: { ...req.to, role: 'fiduciary' },
    version: { n, at: now.toISOString(), checksum },
    app: appVersion(), at: now.toISOString(),
    files: plan.files,
    ...(plan.omitted.length ? { omitted: plan.omitted } : {}),
    ...(git ? { git } : {}),
    ...(req.message?.trim() ? { message: req.message.trim().slice(0, 2000) } : {}),
    ...(questions.length ? { questions } : {}),
  };
  const files = new Map(plan.files.map((f) => [f.path, readFileSync(join(ws.paths.root, f.path)) as Uint8Array]));
  const commit = (): Version => {
    // A version written meanwhile would leave the package naming a number the log gives to something else: nothing is written then.
    const next = nextVersion(ws.paths);
    if (next !== n) throw new Error(`${VERSIONS_FILE}: version ${n} was expected, the next is ${next}: written meanwhile.`);
    const version = writeVersion(ws.paths, { reason: 'handover', to: req.to, at: index.version.at, checksum });
    takeQuestions(ws, req.to);
    mkdirSync(join(ws.paths.root, HANDOVER_DIR, 'sent'), { recursive: true });
    const { git: _g, ...kept } = index;
    writeFileSync(sentFile(ws, version.n), JSON.stringify(kept) + '\n');
    // The records as handed over: a return's `before` is read from here, never from the return (review of #535).
    for (const f of plan.files.filter((x) => isBaseFile(x.path))) {
      const to = join(baseDirOf(ws, version.n), f.path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, files.get(f.path)!);
    }
    return version;
  };
  return { index, files, name: packageName(index), commit };
}
