/** The disk side of the leak guard: which files a tree has, their text, and the workspace's secrets. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { loadBooks } from '../books/store.js';
import { loadMailConfig } from '../collect/mail-config.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT, MANIFEST_FILE, openWorkspace, type Workspace } from '../workspace/workspace.js';
import { isAllowed, parseAllowlist, scan, secretsOf, type Allowlist, type Finding, type PublicFile, type Secret } from './leak-guard.js';

export const ALLOWLIST_FILE = 'public-files.txt';

export const loadAllowlist = (): Allowlist => parseAllowlist(readFileSync(join(APP_ROOT, ALLOWLIST_FILE), 'utf8'));

/**
 * The files of a tree: in a git checkout the tracked and untracked-but-not-ignored ones (so an
 * ignored file such as .env or data/ never counts), else every file but .git and node_modules.
 */
export function filesOf(dir: string): string[] {
  if (existsSync(join(dir, '.git'))) {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, maxBuffer: 1 << 28 });
    return [...new Set(out.toString('utf8').split('\0').filter(Boolean))]
      .filter((p) => existsSync(join(dir, p)) && statSync(join(dir, p)).isFile()).sort();
  }
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return [];
    const full = join(d, e.name);
    return e.isDirectory() ? walk(full) : e.isFile() ? [relative(dir, full)] : [];
  });
  return walk(dir).sort();
}

const BINARY = /\.(pdf|png|jpe?g|gif|ico|webp|heic|zip|xlsx?|docx?|pptx?|ac2|sqlite|db)$/i;

export function readPublicFile(dir: string, path: string): PublicFile {
  const buf = readFileSync(join(dir, path));
  const binary = BINARY.test(path) || buf.subarray(0, 8192).includes(0);
  return { path, text: binary ? null : buf.toString('utf8') };
}

/** Every secret of the company, from its workspace. Nothing here is ever written into the app. */
export function workspaceSecrets(ws: Workspace): Secret[] {
  const knowledge = loadKnowledge(APP_ROOT, ws.paths.root);
  const statementsDir = ws.paths.statements;
  const statements = existsSync(statementsDir)
    ? filesOf(statementsDir).map((p) => ({ name: p, text: p.endsWith('.xml') ? readFileSync(join(statementsDir, p), 'utf8') : null }))
    : [];
  const terms = existsSync(ws.paths.secretTerms)
    ? readFileSync(ws.paths.secretTerms, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const mail = existsSync(ws.paths.mail) ? loadMailConfig(ws).mailboxes : [];
  const envFile = join(ws.paths.root, '.env');
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const logins = mail.map((m) => env[`${m.env}_IMAP_USER`]).filter((u): u is string => !!u?.includes('@'));
  return secretsOf({
    company: ws.company,
    mailboxes: [...new Set([...mail.flatMap((m) => [m.address, ...(m.filterTo ? [m.filterTo] : [])]), ...logins])],
    books: loadBooks(ws),
    counterparties: knowledge.counterparties,
    bindings: knowledge.counterpartyFiles.filter((f) => f.layer === 'workspace').map((f) => f.body),
    statements,
    terms,
  });
}

/** The secrets of the configured workspace, or none with the reason (the demo has no secrets). */
export function secretsOrWhyNot(): { secrets: Secret[] } | { why: string } {
  let ws;
  try { ws = openWorkspace(); } catch (e) { return { why: (e as Error).message }; }
  if (ws.paths.root.startsWith(join(APP_ROOT, 'demo'))) return { why: 'the workspace is the demo, whose data is public' };
  return { secrets: workspaceSecrets(ws) };
}

export function checkTree(dir: string, secrets: readonly Secret[]): Finding[] {
  const allowlist = loadAllowlist();
  const privateRepo = existsSync(join(dir, MANIFEST_FILE));
  const paths = filesOf(dir).filter((p) => !privateRepo || isAllowed(p, allowlist));
  return scan(paths.map((p) => readPublicFile(dir, p)), secrets, allowlist, { requireAllowlisted: !privateRepo });
}
