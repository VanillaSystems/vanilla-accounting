/**
 * «Teilen…» on the sharer's side (docs/specs/e2e-and-fiduciary.md B3.1, B3.4, B3.5): what a hand-over
 * to a person carries, and the package itself. The first hand-over to a person is `full`: the books'
 * files and every receipt and statement of the open years (a closed year's only «mit Archiv»). A
 * later one is an `update` on the version that person holds: the books' files whole again, plus
 * the receipts and statements new since. Each hand-over writes a version (B7) and keeps its index in
 * handover/sent/, so the next update knows what the person has.
 */
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import git from 'isomorphic-git';
import { isClosedYear } from '../books/years.js';
import { loadBooks } from '../books/store.js';
import { committedAsIs, repositoryAt } from '../workspace/git.js';
import type { Workspace } from '../workspace/workspace.js';
import { appVersion } from '../version.js';
import { checksumOf, contentFiles, factOf, type FileFact } from './content.js';
import { PACKAGE_FORMAT, packageName, writePackage, type PackageIndex, type Question } from './package.js';
import { heldBy, writeVersion, type Party, type Version } from './versions.js';
import { pendingQuestions, takeQuestions } from './returns.js';

/** The sharer's own folder of hand-overs in the workspace: sent/ (each version's index), returns/ (what came back). */
export const HANDOVER_DIR = 'handover';
const sentFile = (ws: Pick<Workspace, 'paths'>, n: number) => join(ws.paths.root, HANDOVER_DIR, 'sent', `v${n}.json`);

export interface ShareRequest {
  to: Party;
  message?: string;
  /** «Vollständig»: a full package even when the person holds a version. */
  full?: boolean;
  /** «mit Archiv <Jahr>»: closed years whose receipts and statements go along. */
  archive?: string[];
}

/** What a hand-over would carry, before it is made: the dialog names it with its size. */
export interface SharePlan {
  kind: 'full' | 'update';
  to: Party;
  /** The version the person holds, for an update. */
  base?: Pick<Version, 'n' | 'at' | 'checksum'>;
  files: FileFact[];
  held: FileFact[];
  omitted: FileFact[];
  /** The bytes of the files carried. */
  bytes: number;
  /** New receipts and statements an update carries (the books' files go whole anyway). */
  newFiles: number;
  /** Closed years whose receipts stay home unless asked for. */
  closedYears: string[];
  /** The questions of earlier returns that go along. */
  questions: number;
}

/** The index of the version `n` as it was handed over, when it was: what that person's copy holds. */
function sentIndex(ws: Pick<Workspace, 'paths'>, n: number): PackageIndex | undefined {
  const file = sentFile(ws, n);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PackageIndex) : undefined;
}

export function planShare(ws: Workspace, req: ShareRequest): SharePlan {
  const closedThrough = loadBooks(ws).config.closedThrough;
  const files = contentFiles(ws.paths.root).map((f) => ({ ...f, ...factOf(ws.paths.root, f.path) }));
  const held = req.full ? undefined : heldBy(ws.paths, req.to);
  const had = held ? sentIndex(ws, held.n) : undefined;
  const hadFiles = had ? new Map([...had.files, ...(had.held ?? [])].map((f) => [f.path, f.sha256])) : undefined;
  const closedYears = [...new Set(files.flatMap((f) => (f.year && isClosedYear(f.year, closedThrough) ? [f.year] : [])))].sort();
  const archive = new Set(req.archive ?? []);
  const out: SharePlan = { kind: hadFiles ? 'update' : 'full', to: req.to, files: [], held: [], omitted: [], bytes: 0, newFiles: 0, closedYears, questions: pendingQuestions(ws, req.to).length };
  if (hadFiles && held) out.base = { n: held.n, at: held.at, checksum: held.checksum };
  for (const f of files) {
    const fact: FileFact = { path: f.path, sha256: f.sha256, blob: f.blob, bytes: f.bytes };
    if (f.carriage === 'whole') { out.files.push(fact); continue; }
    if (hadFiles?.get(f.path) === f.sha256) { out.held.push(fact); continue; }
    // A closed year's receipts and statements stay home, in a full package and in every update after it (B3.5).
    if (f.year && isClosedYear(f.year, closedThrough) && !archive.has(f.year)) { out.omitted.push(fact); continue; }
    out.files.push(fact);
    out.newFiles++;
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

/**
 * Makes the hand-over: writes the next version (reason handover, to the person), keeps the index in
 * handover/sent/, takes the questions of earlier returns along, and returns the `.vanilla` file.
 */
export async function makeShare(ws: Workspace, req: ShareRequest, from: Party, now = new Date()): Promise<ShareResult> {
  const plan = planShare(ws, req);
  const all = [...plan.files, ...plan.held, ...plan.omitted];
  const git = await gitSide(ws, all.map((f) => f.path));
  const version = writeVersion(ws.paths, { reason: 'handover', to: req.to, at: now.toISOString(), checksum: checksumOf(all) });
  const questions: Question[] = takeQuestions(ws, req.to);
  const index: PackageIndex = {
    format: PACKAGE_FORMAT, kind: plan.kind,
    firm: { name: ws.company.name, ...(ws.company.uid ? { uid: ws.company.uid } : {}) },
    from, to: { ...req.to, role: 'fiduciary' },
    version: { n: version.n, at: version.at, checksum: version.checksum },
    ...(plan.base ? { base: plan.base } : {}),
    app: appVersion(), at: now.toISOString(),
    files: plan.files,
    ...(plan.held.length ? { held: plan.held } : {}),
    ...(plan.omitted.length ? { omitted: plan.omitted } : {}),
    ...(git ? { git } : {}),
    ...(req.message?.trim() ? { message: req.message.trim().slice(0, 2000) } : {}),
    ...(questions.length ? { questions } : {}),
  };
  const files = new Map(plan.files.map((f) => [f.path, readFileSync(join(ws.paths.root, f.path)) as Uint8Array]));
  const bytes = writePackage({ index, files });
  mkdirSync(join(ws.paths.root, HANDOVER_DIR, 'sent'), { recursive: true });
  const { git: _g, ...kept } = index;
  writeFileSync(sentFile(ws, version.n), JSON.stringify(kept) + '\n');
  return { version, name: packageName(index), bytes, index };
}
