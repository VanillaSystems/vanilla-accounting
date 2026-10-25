/**
 * npm run doctor: is everything in place to keep the books? Checks the tools (Node, the claude
 * CLI and its login, without a model call; git only for npm run update) and the workspace (manifest, books.json,
 * folders, chart, bank accounts, which bank account each statement lands on, the answers of
 * npm run init), every reference of the books that names no record, the mailboxes of mail.yaml (their keys in the app's .env; `--mail` also logs in
 * to each, nothing fetched) and how many open transactions route to no knowledge file. Prints one
 * line per check and the fix for each ✗; exit code 1 on any ✗.
 * `--workspace <dir>` checks that folder instead of the one VANILLA_WORKSPACE names.
 */
import { execFileSync } from 'node:child_process';
import { gitProgram } from '../platform/git-program.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { hasBooks, loadBooks, periodLock } from '../books/store.js';
import { mailConfigured } from '../platform/sources/mail.js';
import { sources } from '../platform/sources/index.js';
import { secretKey } from '../platform/sources/model.js';
import { imapBackend } from '../platform/sources/mail-channel.js';
import { secrets } from '../secrets/secrets.js';
import { useKeychain } from '../secrets/keychain-store.js';
import { byKind, danglingRefsOf } from '../accounting/integrity.js';
import { knowledgeGaps } from '../knowledge/gaps.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { fail, ok, warn, workspaceChecks, type Result } from '../workspace/checks.js';
import { plausibilityHints } from '../accounting/booking-warnings.js';
import { APP_ROOT, openWorkspace, workspaceAt, type Workspace } from '../workspace/workspace.js';
import { appTime, appVersion } from '../version.js';

function run(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch (e) {
    const err = e as { code?: string; stdout?: string; stderr?: string };
    return err.code === 'ENOENT' ? undefined : (err.stdout || err.stderr || undefined);
  }
}

function toolChecks(): Result[] {
  const major = Number(process.versions.node.split('.')[0]);
  const results = [
    major >= 22 ? ok(`Node.js ${process.versions.node}`) : fail(`Node.js ${process.versions.node} is too old`, 'Install Node.js 22 or newer (nodejs.org, or brew install node).'),
    // PDFs, photos and the workspace's git history are read and written by the app itself (ADR 0006).
    gitProgram() ? ok('git found (npm run update, npm run check-closed)') : warn('git not found', 'the books work without it; npm run update and npm run check-closed need it'),
  ];
  const version = run('claude', ['--version']);
  if (version === undefined) {
    return [...results, fail('claude CLI not found', 'Install Claude Code (npm install -g @anthropic-ai/claude-code) and log in with your Claude subscription: claude')];
  }
  let loggedIn: boolean | undefined;
  try { loggedIn = (JSON.parse(run('claude', ['auth', 'status']) ?? '') as { loggedIn?: boolean }).loggedIn; } catch { /* older CLI */ }
  return [
    ...results,
    ok(`claude CLI ${version.trim().split(/\s/)[0]}`),
    loggedIn === true ? ok('claude is logged in')
      : loggedIn === false ? fail('claude is not logged in', 'Run claude once and log in (a Claude Pro or Max subscription covers booking and matching).')
      : warn('claude login not checked', 'this claude version has no "auth status"; run claude once to be sure you are logged in'),
  ];
}

/** The open transactions no supplier, customer or authority file claims: booked by the generic rules alone. */
function knowledgeCheck(ws: Workspace): Result[] {
  if (!hasBooks(ws)) return [];
  try {
    const books = loadBooks(ws);
    const lock = periodLock(books);
    const open = books.transactions.filter((t) => !lock.isClosed(t.date));
    const unrouted = knowledgeGaps(open, books, loadKnowledge(APP_ROOT, ws.paths.root).counterparties).reduce((n, g) => n + g.count, 0);
    return [!open.length ? ok('Knowledge base: no open transactions yet')
      : unrouted ? warn(`Knowledge base: ${unrouted} of ${open.length} open transactions route to no supplier, customer or authority file`, 'npm run gaps lists them by merchant, most frequent first')
      : ok(`Knowledge base: every one of ${open.length} open transactions routes to a knowledge file`)];
  } catch (e) {
    return [fail(`Knowledge base does not load: ${(e as Error).message.split('\n')[0]}`, 'Fix the file the message names, then run npm run check-processes.')];
  }
}

/** The references of the books that name no record (#126), a line per kind with its first few: doctor only reports, it repairs nothing. */
function integrityCheck(ws: Workspace): Result[] {
  if (!hasBooks(ws)) return [];
  let groups: ReturnType<typeof byKind>;
  try {
    groups = byKind(danglingRefsOf(ws, loadBooks(ws)));
  } catch (e) {
    return [warn(`Books: the reference check did not run (${(e as Error).message.split('\n')[0]})`, 'it reads the books, invoices.json and the questions: fix the one that does not read, then run npm run doctor again')];
  }
  if (!groups.length) return [ok('Books: every reference names a record')];
  return groups.map(({ label, found }) => warn(`Books: ${found.length} ${label}`, `${found.slice(0, 3).map((d) => `${d.record} → ${d.missing}`).join('; ')}${found.length > 3 ? `; and ${found.length - 3} more` : ''}`));
}

/** Each mail source (ADR 0014): its password in the keychain, switched on, and with `login` a real IMAP login and logout. */
async function mailChecks(ws: Workspace, login: boolean): Promise<Result[]> {
  useKeychain(() => ws.paths.root);
  const results: Result[] = [];
  if (mailConfigured(ws)) results.push(warn('mail.yaml is not converted into sources yet', 'npm run update turns each login into sources/<id>/ (docs/mail-setup.md).'));
  const mail = sources(ws, APP_ROOT).filter((v) => v.kind !== 'invalid' && v.decl.reach.mail);
  if (!mail.length) return [...results, login ? fail('--mail: no mail source', 'Set one up: docs/mail-setup.md.') : ok('No mail source: receipts are not collected from a mailbox (docs/mail-setup.md sets one up)')];
  for (const v of mail) {
    if (v.kind === 'invalid') continue;
    const { decl } = v;
    const r = decl.reach.mail!;
    const label = `Mail source ${decl.id} (${r.account})`;
    const name = secretKey(decl.id, 'mail');
    const password = await secrets.get(name);
    if (!password) { results.push(fail(`${label}: ${name} not set`, `Set the password with npm run secret -- ${name} (docs/mail-setup.md).`)); continue; }
    if (v.kind === 'pending') results.push(warn(`${label}: not switched on`, 'Firma › Quellen shows what it may reach; switch it on there.'));
    if (!login) { results.push(ok(`${label}: password in the keychain (npm run doctor -- --mail logs in)`)); continue; }
    try {
      const port = Number(process.env[`${decl.id.toUpperCase().replace(/-/g, '_')}_IMAP_PORT`] || 993);
      await (await imapBackend(r, password, port)).close();
      results.push(ok(`${label}: logs in to ${r.host}:${port}`));
    } catch (e) {
      const err = e as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
      results.push(err.authenticationFailed
        ? fail(`${label}: ${r.host} refused the login (${err.responseText ?? err.message})`, `Create a new app-specific password and set it with npm run secret -- ${name}; check the account in sources/${decl.id}/source.yaml (docs/mail-setup.md).`)
        : fail(`${label}: cannot reach ${r.host} (${err.code ?? err.message})`, `Check reach.mail.host in sources/${decl.id}/source.yaml, and that IMAP is enabled for the mailbox (docs/mail-setup.md).`));
    }
  }
  return results;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, mail: { type: 'boolean' } } });
  const time = appTime();
  console.log(`Vanilla Accounting ${appVersion()}${time ? ` (${time.kind} ${time.at})` : ''}\n`);
  const results = toolChecks();
  let ws: Workspace | undefined;
  try {
    ws = values.workspace ? workspaceAt(values.workspace) : openWorkspace();
  } catch (e) {
    results.push(fail((e as Error).message, 'Run npm run init to set up a workspace, or set VANILLA_WORKSPACE in .env to the folder holding belege.workspace.yaml.'));
  }
  if (ws) results.push(...workspaceChecks(ws), ...(hasBooks(ws) ? plausibilityHints(loadBooks(ws)).map((h) => warn(h.label, h.fix)) : []), ...integrityCheck(ws), ...knowledgeCheck(ws), ...await mailChecks(ws, values.mail === true));

  for (const r of results) {
    if (r.status === 'ok') console.log(`✓ ${r.label}`);
    else if (r.status === 'warn') console.log(`! ${r.label}: ${r.note}`);
    else console.log(`✗ ${r.label}\n    fix: ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(failed ? `\n${failed} problem${failed > 1 ? 's' : ''} to fix.` : '\nAll set.');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
