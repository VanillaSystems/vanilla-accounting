/**
 * A review file becomes a git branch of the workspace, and the owner merges it like a pull
 * request. Import: branch review/<name>-<period>-<date> from the snapshot's commit, one commit
 * per correction (author the Treuhänder, message his reason), and a last commit with his file
 * (comments, sign-offs). Merge: the accepted corrections go through mutateJournal and saveBooks
 * on TODAY's books (src/review/plan.ts says how each applies now), never a git merge of
 * books.json; the merge commit names both parents, so the Treuhänder's commits stay in history.
 * The owner's decisions land in review/<dir>/decisions.json. The working tree is never switched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Index, JournalEntry } from '../types/index.js';
import { applyChange } from '../books/changes.js';
import { canonical } from '../books/canonical.js';
import { authorEnv, git, repoOf, writerOf, type Author } from '../books/history.js';
import { loadBooks, mutateJournal, saveBooks } from '../books/store.js';
import { chartFor, loadChart } from '../workspace/chart.js';
import type { Workspace } from '../workspace/workspace.js';
import { planCorrection, planReview, type CorrectionPlan } from './plan.js';
import { slug } from './session.js';
import { parseReviewFile, type Decision, type Decisions, type ReviewFile } from './types.js';

export class ReviewGitError extends Error {}

const PREFIX = 'review/';
const TRAILER = 'Vanilla-Correction';

/** review/<dir>/ in the workspace: the Treuhänder's file and the owner's decisions. */
export const reviewDir = (branch: string) => join('review', branch.slice(PREFIX.length));

function repo(ws: Workspace): string {
  const root = repoOf(ws);
  if (!root) throw new ReviewGitError(`${ws.paths.root} ist kein git-Repository (git init im Arbeitsbereich).`);
  return root;
}

const booksPath = (ws: Workspace, root: string) => relative(root, ws.paths.books);
const tryGit = (root: string, args: string[]) => { try { return git(root, args).trim(); } catch { return undefined; } };
const pretty = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;

/** A tree that is `parent`'s with `files` (path → content) written, without touching the index or working tree. */
function treeWith(root: string, parent: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(root, ['read-tree', parent], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = git(root, ['hash-object', '-w', '--stdin'], { input: content }).trim();
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    }
    return git(root, ['write-tree'], { env }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitTree(ws: Workspace, root: string, tree: string, parents: string[], message: string, author: Author, date?: string): string {
  const owner = writerOf(ws);
  const env = { ...authorEnv(ws, author), GIT_COMMITTER_NAME: owner.name, GIT_COMMITTER_EMAIL: owner.email, ...(date ? { GIT_AUTHOR_DATE: date } : {}) };
  return git(root, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], { input: message, env }).trim();
}

export interface ImportResult { branch: string; created: boolean; commits: number; base: string; note?: string }

/**
 * The branch of a review file. Idempotent: the same file again finds its branch and changes
 * nothing; another file for the same name, period and day gets the next free branch name.
 */
export function importReview(ws: Workspace, input: unknown): ImportResult {
  const file = parseReviewFile(input);
  const root = repo(ws);
  const day = file.createdAt.slice(0, 10);
  const stem = `${PREFIX}${slug(file.reviewer.name)}-${file.base.period}-${day}`;
  for (let n = 1; ; n++) {
    const branch = n === 1 ? stem : `${stem}-${n}`;
    const tip = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (!tip) return createBranch(ws, root, branch, file);
    const theirs = tryGit(root, ['show', `${tip}:${reviewDir(branch)}/review.json`]);
    if (theirs && canonical(JSON.parse(theirs)) === canonical(file)) {
      return { branch, created: false, commits: 0, base: tryGit(root, ['merge-base', tip, 'HEAD']) ?? '' };
    }
  }
}

function createBranch(ws: Workspace, root: string, branch: string, file: ReviewFile): ImportResult {
  const known = file.base.commit && tryGit(root, ['cat-file', '-e', `${file.base.commit}^{commit}`]) !== undefined;
  const base = known ? file.base.commit! : git(root, ['rev-parse', 'HEAD']).trim();
  const note = known ? undefined : `Der Stand ${file.base.commit ?? '(ohne Commit)'} der Prüfung ist nicht in diesem Repository; der Zweig beginnt bei HEAD.`;
  const path = booksPath(ws, root);
  const books = JSON.parse(git(root, ['show', `${base}:${path}`])) as Index;
  const author: Author = { name: file.reviewer.name, email: file.reviewer.email ?? '' };
  let parent = base;
  for (const c of file.corrections) {
    for (const change of c.changes) {
      const status = applyChange(books, change);
      if (status === 'conflict') throw new ReviewGitError(`Korrektur ${c.id} passt nicht auf den Stand der Prüfung (${change.collection} ${change.key}).`);
    }
    const tree = treeWith(root, parent, { [path]: JSON.stringify(books, null, 2) });
    parent = commitTree(ws, root, tree, [parent], `${c.reason}\n\n${TRAILER}: ${c.id}\nVanilla-Kind: ${c.kind}\nVanilla-Review: ${file.id}\n`, author, c.at);
  }
  const summary = file.message ?? `Prüfung ${file.base.period}: ${file.comments.length} Kommentare, ${file.signOffs.length} Freigaben`;
  const tree = treeWith(root, parent, { [`${reviewDir(branch)}/review.json`]: pretty(file) });
  parent = commitTree(ws, root, tree, [parent], `${summary}\n\nVanilla-Review: ${file.id}\n`, author, file.createdAt);
  git(root, ['update-ref', `refs/heads/${branch}`, parent, '']);
  return { branch, created: true, commits: file.corrections.length + 1, base, note };
}

export interface ReviewView {
  branch: string;
  file: ReviewFile;
  /** The commit of each correction on the branch. */
  commits: Record<string, string>;
  base: string;
  plans: CorrectionPlan[];
  decisions: Decision[];
}

function decisionsOf(ws: Workspace, branch: string): Decisions | undefined {
  const file = join(ws.paths.root, reviewDir(branch), 'decisions.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Decisions : undefined;
}

/** Every review branch with its plan against today's books, newest first. */
export function listReviews(ws: Workspace): ReviewView[] {
  const root = repoOf(ws);
  if (!root) return [];
  const branches = git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `refs/heads/${PREFIX}`]).split('\n').filter(Boolean);
  return branches.map((b) => viewReview(ws, b));
}

export function viewReview(ws: Workspace, branch: string): ReviewView {
  const root = repo(ws);
  const tip = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!branch.startsWith(PREFIX) || !tip) throw new ReviewGitError(`Zweig ${branch} gibt es nicht.`);
  const file = parseReviewFile(JSON.parse(git(root, ['show', `${tip}:${reviewDir(branch)}/review.json`])));
  const base = git(root, ['merge-base', tip, 'HEAD']).trim();
  const commits: Record<string, string> = {};
  const log = git(root, ['log', '--format=%H%x1f%(trailers:key=Vanilla-Correction,valueonly,separator=)', `${base}..${tip}`]);
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, id] = line.split('\x1f');
    if (id) commits[id.trim()] = hash;
  }
  const decisions = decisionsOf(ws, branch)?.decisions ?? [];
  return { branch, file, commits, base, plans: planReview(loadBooks(ws), file, new Set(decisions.map((d) => d.correctionId))), decisions };
}

export interface DecideInput {
  /** Correction ids to merge, or 'all' for every applicable one not decided yet. */
  accept: string[] | 'all';
  /** Correction id → the owner's reason. */
  reject?: Record<string, string>;
}

export interface DecideResult { merged: string[]; rejected: string[]; skipped: Array<{ id: string; status: string }>; commit?: string }

/** Accounts of the SME chart that applied entries use and accounts.json lacks, appended to it. */
function addChartAccounts(ws: Workspace, entries: JournalEntry[]): boolean {
  if (!existsSync(ws.paths.accounts)) return false;
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string }>;
  const have = new Set(accounts.map((a) => a.number));
  const chart = chartFor(loadChart(), 'both', ws.company.legalForm ?? 'GmbH');
  const wanted = new Set(entries.flatMap((e) => [e.accountDebit, e.accountCredit]).filter((n) => n && !have.has(n)));
  const add = chart.filter((a) => wanted.has(a.number));
  if (!add.length) return false;
  writeFileSync(ws.paths.accounts, pretty([...accounts, ...add].sort((a, b) => a.number.localeCompare(b.number))).trimEnd() + '\n');
  return true;
}

/**
 * The owner's decision on a review: merges the accepted corrections into today's books (through
 * mutateJournal, so a filed quarter cannot change), records the rejected ones with their reason,
 * and commits it all once: a merge commit "Merged <branch> by <owner>" when anything was merged.
 * Idempotent: a decided correction is skipped; deciding nothing new commits nothing.
 */
export function decideReview(ws: Workspace, branch: string, input: DecideInput, by: Author = writerOf(ws)): DecideResult {
  const root = repo(ws);
  const view = viewReview(ws, branch);
  const tip = git(root, ['rev-parse', `refs/heads/${branch}`]).trim();
  const path = booksPath(ws, root);
  if (tryGit(root, ['diff', '--quiet', 'HEAD', '--', path]) === undefined) {
    throw new ReviewGitError(`${path} hat ungespeicherte Änderungen gegenüber dem letzten Commit; zuerst committen.`);
  }
  const decided = new Set(view.decisions.map((d) => d.correctionId));
  const rejectIds = Object.keys(input.reject ?? {});
  for (const id of [...rejectIds, ...(input.accept === 'all' ? [] : input.accept)]) {
    if (!view.file.corrections.some((c) => c.id === id)) throw new ReviewGitError(`Korrektur ${id} gibt es in ${branch} nicht.`);
  }
  const at = new Date().toISOString();
  const result: DecideResult = { merged: [], rejected: [], skipped: [] };
  const decisions: Decision[] = [];
  const books = loadBooks(ws);
  const appliedEntries: JournalEntry[] = [];
  mutateJournal(books, (b) => {
    for (const correction of view.file.corrections) {
      const id = correction.id;
      if (decided.has(id)) continue;
      const plan = planCorrection(b, correction, view.file.id);
      if (rejectIds.includes(id)) {
        decisions.push({ correctionId: id, decision: 'rejected', status: plan.status, reason: input.reject![id], by: by.name, at });
        result.rejected.push(id);
        continue;
      }
      const wanted = input.accept === 'all' ? plan.status !== 'conflict' && plan.status !== 'refused' : input.accept.includes(id);
      if (!wanted) continue;
      if (plan.status === 'conflict' || plan.status === 'refused') { result.skipped.push({ id, status: plan.status }); continue; }
      for (const change of plan.changes) {
        if (applyChange(b, change) === 'conflict') throw new ReviewGitError(`Korrektur ${id}: ${change.collection} ${change.key} lässt sich nicht anwenden.`);
        if (change.collection === 'entries' && change.after) appliedEntries.push(change.after);
      }
      decisions.push({ correctionId: id, decision: 'merged', status: plan.status, by: by.name, at });
      result.merged.push(id);
    }
  });
  if (!decisions.length) return result;

  const dir = reviewDir(branch);
  const files: Record<string, string> = {};
  if (result.merged.length) {
    saveBooks(ws, books, '', { commit: false });
    files[path] = readFileSync(ws.paths.books, 'utf8');
    if (addChartAccounts(ws, appliedEntries)) files[relative(root, ws.paths.accounts)] = readFileSync(ws.paths.accounts, 'utf8');
  }
  const all: Decisions = { branch, reviewId: view.file.id, reviewer: view.file.reviewer, decisions: [...view.decisions, ...decisions] };
  files[`${dir}/review.json`] = pretty(view.file);
  files[`${dir}/decisions.json`] = pretty(all);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }

  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const tree = treeWith(root, head, files);
  const counts = `${result.merged.length} übernommen, ${result.rejected.length} abgelehnt`;
  const message = result.merged.length
    ? `Merged ${branch} by ${by.name} (${counts})\n`
    : `Prüfung ${branch}: ${counts}\n`;
  const commit = commitTree(ws, root, tree, result.merged.length ? [head, tip] : [head], message, by);
  git(root, ['update-ref', '-m', message.trim(), 'HEAD', commit, head]);
  git(root, ['reset', '-q', '--', ...Object.keys(files)]);
  return { ...result, commit };
}
