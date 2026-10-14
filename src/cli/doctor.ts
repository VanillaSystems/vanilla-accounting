/**
 * npm run doctor: is everything in place to keep the books? Checks the tools (Node, the claude
 * CLI and its login, without a model call; git only for npm run update) and the workspace (manifest, books.json,
 * folders, chart, bank accounts, which bank account each statement lands on, the answers of
 * npm run init), the mailboxes of mail.yaml (their keys in the app's .env; `--mail` also logs in
 * to each, nothing fetched) and how many open transactions route to no knowledge file. Prints one
 * line per check and the fix for each ✗; exit code 1 on any ✗.
 * `--workspace <dir>` checks that folder instead of the one VANILLA_WORKSPACE names.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { hasBooks, loadBooks, periodLock } from '../books/store.js';
import { loadMailConfig, loginOf, mailConfigured } from '../collect/mail-config.js';
import { knowledgeGaps } from '../knowledge/gaps.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { fail, ok, warn, workspaceChecks, type Result } from '../workspace/checks.js';
import { APP_ROOT, openWorkspace, workspaceAt, type Workspace } from '../workspace/workspace.js';

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
    run('git', ['--version']) !== undefined ? ok('git found (npm run update, npm run check-closed)') : warn('git not found', 'the books work without it; npm run update and npm run check-closed need it'),
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

/** Each mailbox of mail.yaml: its keys in the app's .env, and with `login` a real IMAP login and logout. */
async function mailChecks(ws: Workspace, login: boolean): Promise<Result[]> {
  if (!mailConfigured(ws)) {
    return [login ? fail('--mail: mail.yaml lists no mailboxes', 'Set up the mailboxes first: docs/mail-setup.md.') : ok('No mailboxes in mail.yaml: receipts are not collected from a mailbox (docs/mail-setup.md sets one up)')];
  }
  let mailboxes;
  try { mailboxes = loadMailConfig(ws).mailboxes; } catch (e) {
    return [fail((e as Error).message, 'Fix mail.yaml as docs/mail-setup.md shows.')];
  }
  // The collector reads the app's .env (dotenv, from the app folder); so does this check.
  loadEnv({ path: join(APP_ROOT, '.env'), quiet: true });
  const { checkLogin } = login ? await import('../collect/imap.js') : { checkLogin: undefined };
  const results: Result[] = [];
  for (const m of mailboxes) {
    const label = `Mailbox ${m.label} (${m.address})`;
    const creds = loginOf(m, process.env);
    if (creds.status === 'missing') {
      const add = `Add to ${join(APP_ROOT, '.env')}: ${creds.keys.map((k) => `${k}=…`).join('  ')} (docs/mail-setup.md).`;
      // Blanking the app password between collections is the advice in docs/mail-setup.md, so that alone is a note.
      const onlyPassword = creds.keys.every((k) => k.endsWith('_IMAP_PASSWORD'));
      results.push(onlyPassword && !login
        ? warn(`${label}: no app password set (fine between collections)`, `Before collecting: ${add}`)
        : fail(`${label}: ${creds.keys.join(', ')} not set`, add));
      continue;
    }
    if (!checkLogin) { results.push(ok(`${label}: credentials in .env (npm run doctor -- --mail logs in)`)); continue; }
    try {
      await checkLogin({ label: m.label, ...creds });
      results.push(ok(`${label}: logs in to ${creds.host}:${creds.port}`));
    } catch (e) {
      const err = e as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
      results.push(err.authenticationFailed
        ? fail(`${label}: ${creds.host} refused the login (${err.responseText ?? err.message})`, `Create a new app-specific password and put it in ${m.env}_IMAP_PASSWORD; check ${m.env}_IMAP_USER is the full address (docs/mail-setup.md).`)
        : fail(`${label}: cannot reach ${creds.host}:${creds.port} (${err.code ?? err.message})`, `Check host in mail.yaml or ${m.env}_IMAP_HOST / ${m.env}_IMAP_PORT, and that IMAP is enabled for the mailbox (docs/mail-setup.md).`));
    }
  }
  return results;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, mail: { type: 'boolean' } } });
  const results = toolChecks();
  let ws: Workspace | undefined;
  try {
    ws = values.workspace ? workspaceAt(values.workspace) : openWorkspace();
  } catch (e) {
    results.push(fail((e as Error).message, 'Run npm run init to set up a workspace, or set VANILLA_WORKSPACE in .env to the folder holding belege.workspace.yaml.'));
  }
  if (ws) results.push(...workspaceChecks(ws), ...knowledgeCheck(ws), ...await mailChecks(ws, values.mail === true));

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
