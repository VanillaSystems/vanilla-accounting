/**
 * Git as the books' change log. Every saveBooks commits books.json in the workspace's own git
 * repository, with the writer as author and the action as message; history() reads the log
 * back as record-level changes (src/books/changes.ts) for the Protokoll tab and the audit export.
 *
 * A workspace that is not the top of a git repository (a temp copy in a test, the verify
 * sandbox, a demo inside the app repo) is saved but not committed, with one note per process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Index } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { diffBooks, type RecordChange } from './changes.js';

export interface Author { name: string; email: string }

let writer: Author | undefined;

/** Who writes the books in this process. Default: the owner from belege.workspace.yaml. */
export function setWriter(author: Author | undefined): void {
  writer = author;
}

export function writerOf(ws: Workspace): Author {
  return writer ?? { name: ws.company.owner, email: gitConfig(ws, 'user.email') ?? '' };
}

/** What a save does when no action is named: the npm script or the script file that runs. */
export const defaultAction = (): string =>
  process.env.npm_lifecycle_event ? `npm run ${process.env.npm_lifecycle_event}` : basename(process.argv[1] ?? 'node');

export function git(root: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitConfig(ws: Workspace, key: string): string | undefined {
  try { return git(ws.paths.root, ['config', key]).trim() || undefined; } catch { return undefined; }
}

/** The workspace root when it is the top of its own git repository, else undefined. */
export function repoOf(ws: Workspace): string | undefined {
  try {
    const top = git(ws.paths.root, ['rev-parse', '--show-toplevel']).trim();
    return realpathSync(top) === realpathSync(ws.paths.root) ? ws.paths.root : undefined;
  } catch {
    return undefined;
  }
}

const noted = new Set<string>();

/** Environment that makes `author` the commit's author, and the committer when git knows none. */
export function authorEnv(ws: Workspace, author: Author): NodeJS.ProcessEnv {
  const committer = gitConfig(ws, 'user.name') ? {} : { GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
  return { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, ...committer };
}

/**
 * Commits books.json (and `paths`, relative to the workspace) as `author`, with `message`.
 * Nothing changed: no commit. Not a repository: a note, no commit. A failing git is a warning:
 * the books are saved either way. Returns the new commit's hash.
 */
export function commitBooks(ws: Workspace, message: string, opts: { author?: Author; paths?: string[] } = {}): string | undefined {
  const root = repoOf(ws);
  if (!root) {
    if (!noted.has(ws.paths.root)) {
      noted.add(ws.paths.root);
      console.warn(`note: ${ws.paths.root} is not the top of a git repository; books.json is saved without a commit.`);
    }
    return undefined;
  }
  const paths = [relative(root, ws.paths.books), ...(opts.paths ?? [])];
  try {
    git(root, ['add', '--', ...paths]);
    const staged = git(root, ['diff', '--cached', '--name-only', '--', ...paths]).trim();
    if (!staged) return undefined;
    git(root, ['commit', '--quiet', '--no-verify', '-m', message, '--only', '--', ...paths], { env: authorEnv(ws, opts.author ?? writerOf(ws)) });
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch (e) {
    console.warn(`warning: books.json saved, but the git commit failed: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

/** One commit of the books' log, with the records it changed. */
export interface LogCommit {
  hash: string;
  parents: string[];
  at: string;
  author: Author;
  message: string;
  changes: RecordChange[];
}

const EMPTY: Index = { receipts: [], transactions: [], mappings: [], bankStatements: [] };

/** books.json as it stood at `rev`; empty books when it did not exist there. */
export function booksAt(ws: Workspace, rev: string): Index {
  const root = repoOf(ws);
  if (!root) return EMPTY;
  try {
    return JSON.parse(git(root, ['show', `${rev}:${relative(root, ws.paths.books)}`])) as Index;
  } catch {
    return EMPTY;
  }
}

/**
 * The commits that changed books.json, newest first, each with its record-level changes against
 * its first parent. Derived from git, cached per commit in data/log/ (a commit never changes).
 */
export function history(ws: Workspace, opts: { limit?: number; rev?: string } = {}): LogCommit[] {
  const root = repoOf(ws);
  if (!root) return [];
  const SEP = '\x1f';
  let out: string;
  try {
    out = git(root, ['log', `-n${opts.limit ?? 200}`, `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%B%x1e`, opts.rev ?? 'HEAD', '--', relative(root, ws.paths.books)]);
  } catch {
    return [];
  }
  const cacheDir = join(ws.paths.data, 'log');
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((line) => {
    const [hash, parents, name, email, at, message] = line.split(SEP);
    const cache = join(cacheDir, `${hash}.json`);
    let changes: RecordChange[];
    if (existsSync(cache)) changes = JSON.parse(readFileSync(cache, 'utf8')) as RecordChange[];
    else {
      const parent = parents.split(' ').filter(Boolean)[0];
      changes = diffBooks(parent ? booksAt(ws, parent) : EMPTY, booksAt(ws, hash));
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cache, JSON.stringify(changes));
    }
    return { hash, parents: parents.split(' ').filter(Boolean), at, author: { name, email }, message: message.trim(), changes };
  });
}
