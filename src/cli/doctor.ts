/**
 * npm run doctor: is everything in place to keep the books? Checks the tools (Node, pdftotext,
 * the claude CLI and its login, without a model call) and the workspace (manifest, books.json,
 * folders, chart, bank accounts, the answers of npm run init). Prints one line per check and the
 * fix for each ✗; exit code 1 on any ✗. `--workspace <dir>` checks that folder instead of the
 * one BELEGE_WORKSPACE names.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadBooks } from '../books/store.js';
import { bankKind } from '../workspace/scaffold.js';
import { openWorkspace, workspaceAt, type Workspace } from '../workspace/workspace.js';

type Result =
  | { status: 'ok'; label: string }
  | { status: 'warn'; label: string; note: string }
  | { status: 'fail'; label: string; fix: string };

const ok = (label: string): Result => ({ status: 'ok', label });
const warn = (label: string, note: string): Result => ({ status: 'warn', label, note });
const fail = (label: string, fix: string): Result => ({ status: 'fail', label, fix });

function run(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch (e) {
    const err = e as { code?: string; stdout?: string; stderr?: string };
    // pdftotext -v exits non-zero on some versions but still answers.
    return err.code === 'ENOENT' ? undefined : (err.stdout || err.stderr || undefined);
  }
}

function toolChecks(): Result[] {
  const major = Number(process.versions.node.split('.')[0]);
  const results = [
    major >= 22 ? ok(`Node.js ${process.versions.node}`) : fail(`Node.js ${process.versions.node} is too old`, 'Install Node.js 22 or newer (nodejs.org, or brew install node).'),
    run('pdftotext', ['-v']) !== undefined ? ok('pdftotext (poppler) found') : fail('pdftotext not found', 'Install poppler: brew install poppler (macOS) or apt install poppler-utils (Linux).'),
    run('convert', ['-version']) !== undefined ? ok('ImageMagick found (photos of receipts)') : warn('ImageMagick not found', 'receipts as PNG or JPG are not read; PDFs are. To read photos: brew install imagemagick'),
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

function workspaceChecks(ws: Workspace): Result[] {
  const results: Result[] = [ok(`Workspace ${ws.paths.root} (${ws.company.name})`)];
  const { profile } = ws;
  results.push(profile
    ? ok(`Profile: ${profile.preset}, sells ${profile.sells}, ${ws.company.legalForm ?? 'legal form not set'}`)
    : warn('No profile in belege.workspace.yaml', 'set up before npm run init; nothing is missing for booking'));

  try {
    loadBooks(ws);
    results.push(ok('books.json reads'));
  } catch (e) {
    results.push(fail(`books.json: ${(e as Error).message.split('\n')[0]}`, 'Restore books.json from git (git checkout books.json), or create it with npm run init in a new folder.'));
  }

  for (const [label, dir] of [['receipts/', ws.paths.receipts], ['bank-statements/', ws.paths.statements], ['filings/', ws.paths.filings]] as const) {
    results.push(existsSync(dir) ? ok(`${label} exists`) : fail(`${label} missing`, `mkdir ${dir}`));
  }
  // Not in git (.gitignore), so a fresh clone of the books lacks it; an upload creates it.
  results.push(existsSync(ws.paths.inbox) ? ok('beleg-import/ exists') : warn('beleg-import/ missing', `mkdir ${ws.paths.inbox} to drop receipts there`));

  let accounts: { number: string; name: string }[] = [];
  try {
    accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8'));
    results.push(ok(`accounts.json: ${accounts.length} accounts`));
  } catch (e) {
    results.push(fail(`accounts.json does not read (${(e as Error).message.split('\n')[0]})`, 'Restore it from git, or copy the chart from a new workspace made by npm run init.'));
  }
  const numbers = new Set(accounts.map((a) => a.number));
  for (const b of ws.bankAccounts) {
    const label = `${b.bank} ${b.currency} books on ${b.account}`;
    if (!numbers.has(b.account)) { results.push(fail(`${label}, which is not in accounts.json`, `Add { "number": "${b.account}", "name": "${b.label}" } to accounts.json, or fix the account in belege.workspace.yaml.`)); continue; }
    if (b.statements && !existsSync(resolve(ws.paths.statements, b.bank))) { results.push(fail(`${label}: bank-statements/${b.bank}/ missing`, `mkdir "${resolve(ws.paths.statements, b.bank)}" and put its camt.053 files there.`)); continue; }
    const ignored = b.statements ? readdirSync(resolve(ws.paths.statements, b.bank)).filter((f) => f.endsWith('.xml') && !f.startsWith('uuid_')) : [];
    if (ignored.length) { results.push(fail(`${label}: ${ignored.length} XML file(s) in bank-statements/${b.bank}/ are not read`, `The import reads files named uuid_*.xml only: rename ${ignored[0]} to uuid_${ignored[0]}.`)); continue; }
    const note = b.bank === 'manual' ? undefined : bankKind(b.bank).note;
    results.push(note ? warn(label, note) : ok(label));
  }

  if (profile) {
    const manual = ws.bankAccounts.some((b) => b.bank === 'manual');
    if (profile.ownerPaysPrivately === 'yes' && !manual) {
      results.push(fail('The owner pays business costs privately, but no bank account is `manual`', 'Add { bank: manual, currency: CHF, account: "2451", label: Kontokorrent <owner> } to bankAccounts (2850 Privat for an Einzelfirma).'));
    }
    if (profile.payouts === 'yes' && !numbers.has('1093')) {
      results.push(fail('Payouts from a webshop or payment provider need the clearing account 1093', 'Add { "number": "1093", "name": "Guthaben Zahlungsanbieter" } to accounts.json.'));
    }
  }

  const charts = existsSync(ws.paths.history) ? readdirSync(ws.paths.history).filter((f) => f.endsWith('.Konten.txt')).sort() : [];
  results.push(ok(charts.length
    ? `Booking reads the prior-year export ${charts.at(-1)} in history/`
    : 'Booking reads accounts.json and the casebook (no prior-year export in history/)'));
  return results;
}

function main(): number {
  const { values } = parseArgs({ options: { workspace: { type: 'string' } } });
  const results = toolChecks();
  let ws: Workspace | undefined;
  try {
    ws = values.workspace ? workspaceAt(values.workspace) : openWorkspace();
  } catch (e) {
    results.push(fail((e as Error).message, 'Run npm run init to set up a workspace, or set BELEGE_WORKSPACE in .env to the folder holding belege.workspace.yaml.'));
  }
  if (ws) results.push(...workspaceChecks(ws));

  for (const r of results) {
    if (r.status === 'ok') console.log(`✓ ${r.label}`);
    else if (r.status === 'warn') console.log(`! ${r.label}: ${r.note}`);
    else console.log(`✗ ${r.label}\n    fix: ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(failed ? `\n${failed} problem${failed > 1 ? 's' : ''} to fix.` : '\nAll set.');
  return failed ? 1 : 0;
}

process.exitCode = main();
