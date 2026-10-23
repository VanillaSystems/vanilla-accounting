/**
 * npm run update: brings the app to the newest version of the branch it follows, and the open
 * workspace with it.
 *
 *   1. the app's folder has no uncommitted change
 *   2. git pull --ff-only
 *   3. npm ci, when package-lock.json differs from the last install
 *   4. the books and belege.workspace.yaml written at the new schema and layout (backups in data/backups/),
 *      and the terminal AI's instructions (src/workspace/terminal-agents.ts)
 *   5. npm run doctor
 *   6. npm run test:books: no filed figure moved (skipped while the workspace has no expected/)
 *
 * Stops at the first step that fails and says how to fix it. Safe to rerun: each step checks
 * its own end state. Steps 4 to 6 run in a new process, so they run the code just pulled.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { upgradeWorkspace } from '../workspace/upgrade.js';
import { ensureTerminalAgents } from '../workspace/terminal-agents.js';
import { convertMail, mailConfigured } from '../platform/sources/mail.js';
import { config as loadEnv } from 'dotenv';
import { APP_ROOT, openWorkspace, openWorkspaceAt, partDirs } from '../workspace/workspace.js';

type Outcome = { ok: true; note?: string } | { ok: false; problem: string; fix: string };
interface Step { name: string; run(): Outcome | Promise<Outcome> }

const done = (note?: string): Outcome => ({ ok: true, note });
const failed = (problem: string, fix: string): Outcome => ({ ok: false, problem, fix });

const git = (...args: string[]) => execFileSync('git', ['-C', APP_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args: string[]): { ok: true; out: string } | { ok: false; err: string } => {
  try { return { ok: true, out: git(...args) }; } catch (e) { return { ok: false, err: String((e as { stderr?: string }).stderr || (e as Error).message).trim() }; }
};
const npm = (...args: string[]) => spawnSync('npm', args, { cwd: APP_ROOT, stdio: 'inherit' }).status === 0;
const version = () => (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const LOCK = join(APP_ROOT, 'package-lock.json');
/** The package-lock.json node_modules was last installed from, written by this command. */
const INSTALLED = join(APP_ROOT, 'node_modules', '.vanilla-installed-lock.sha256');
const lockHash = () => createHash('sha256').update(readFileSync(LOCK)).digest('hex');

/** The CHANGELOG.md sections after `from` up to the current version. */
function changesSince(from: string): string {
  const file = join(APP_ROOT, 'CHANGELOG.md');
  if (!existsSync(file)) return '';
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^## \[\d/.test(l));
  const end = lines.findIndex((l) => l.startsWith(`## [${from}]`));
  return start < 0 ? '' : lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

const beforePull: Step[] = [
  {
    name: 'No uncommitted change in the app',
    run() {
      const dirty = git('status', '--porcelain');
      return dirty ? failed(`the app's folder has changes:\n${dirty}`, 'Commit them on a branch of your own, or set them aside with git stash, then run npm run update again.') : done();
    },
  },
  {
    name: 'Note what node_modules was installed from',
    run() {
      // A first update trusts the install it finds; from then on the hash says.
      if (existsSync(join(APP_ROOT, 'node_modules')) && !existsSync(INSTALLED)) writeFileSync(INSTALLED, lockHash());
      return done();
    },
  },
  {
    name: 'git pull --ff-only',
    run() {
      const upstream = tryGit('rev-parse', '--abbrev-ref', '@{upstream}');
      if (!upstream.ok) return failed('this copy of the app follows no remote branch', 'Point it at the app\'s main branch: git branch --set-upstream-to origin/main, then run npm run update again.');
      const was = version();
      const pull = tryGit('pull', '--ff-only');
      if (!pull.ok) {
        return failed(`git pull --ff-only did not apply (${pull.err.split('\n')[0]})`,
          `Your copy has commits that ${upstream.out} does not (git log ${upstream.out}..HEAD). Move them to a branch of your own (git branch my-changes; git reset --hard ${upstream.out}), then run npm run update again.`);
      }
      const now = version();
      if (now === was) return done(`version ${now}, ${/Already up to date/i.test(pull.out) ? 'nothing new' : 'new commits, same version'}`);
      const changes = changesSince(was);
      return done(`version ${was} → ${now}${changes ? `\n\n${changes}\n` : ''}`);
    },
  },
  {
    name: 'npm ci, when package-lock.json changed',
    run() {
      const lock = lockHash();
      if (existsSync(join(APP_ROOT, 'node_modules')) && existsSync(INSTALLED) && readFileSync(INSTALLED, 'utf8') === lock) return done('dependencies unchanged');
      if (!npm('ci')) return failed('npm ci failed', 'Read the npm error above (network, Node.js version), fix it, then run npm run update again.');
      writeFileSync(INSTALLED, lock);
      return done('dependencies installed');
    },
  },
];

const afterPull: Step[] = [
  {
    name: 'Workspace files at the schema and layout of this version',
    async run() {
      let opened;
      try { opened = openWorkspace(); } catch (e) { return failed((e as Error).message, 'Set VANILLA_WORKSPACE in the app\'s .env to your workspace folder (npm run doctor checks it).'); }
      try {
        const { ws, done: changed } = await upgradeWorkspace(opened);
        openWorkspaceAt(ws.paths.root);
        if (!changed.length) return done(`${ws.paths.root}: up to date`);
        const at = (f: string) => relative(ws.paths.repository, f);
        return done(changed.map((u) => `${at(u.file)}: schema ${u.from ?? '(none)'} → ${u.to}, backup ${at(u.backup)}${u.moved ? `; ${u.moved} files and folders moved into vanilla-accounting/ (ADR 0013)` : ''}`).join('\n    ')
          + '\n    Commit the workspace (git add -A && git commit -m "Schema update"), so the change is on record.');
      } catch (e) {
        return failed((e as Error).message.split('\n')[0], 'Each file is written whole, and a rerun finishes the rest: fix what the message names, then run npm run update again.');
      }
    },
  },
  {
    name: 'Instructions for an AI in the terminal (vanilla-accounting/AGENTS.md)',
    run() {
      const ws = openWorkspace();
      const written = ensureTerminalAgents(ws.paths);
      return done(written.length ? `${written.join(', ')} written; commit them with the workspace` : 'up to date');
    },
  },
  {
    name: 'Mailboxes as sources (ADR 0014)',
    run() {
      const ws = openWorkspace();
      if (!mailConfigured(ws)) return done(existsSync(join(ws.paths.root, 'sources')) ? 'sources/ already' : 'no mail.yaml');
      loadEnv({ path: join(APP_ROOT, '.env'), quiet: true });
      const { sources: made, backup } = convertMail(ws, process.env);
      const at = (f: string) => relative(ws.paths.repository, f);
      return done(`mail.yaml → ${made.map((id) => `sources/${id}/`).join(', ') || 'nothing new'} (backup ${at(backup)}). Switch each on in Firma › Quellen; their passwords: npm run secret -- source:<id>:mail.`);
    },
  },
  {
    name: 'npm run doctor',
    run: () => npm('run', '-s', 'doctor') ? done() : failed('doctor found problems', 'Fix each ✗ above as its fix line says, then run npm run update again.'),
  },
  {
    name: 'npm run test:books: no filed figure moved',
    run() {
      if (!partDirs(openWorkspace().paths, 'expected').length) return done('skipped: the workspace has no expected/ yet (npm run test:books:init, then test:books:update, after your first filed quarter)');
      return npm('run', '-s', 'test:books') ? done()
        : failed('a figure differs from the frozen golden master',
          'A filed quarter\'s figure must never move: go back to the old version (git reset --hard ORIG_HEAD and npm ci in the app; git checkout . in the workspace) and report it. An open quarter\'s figure may move only where CHANGELOG.md marks the release ⚠ figures: read it, then accept with npm run test:books:update and commit the workspace.');
    },
  },
];

async function runSteps(steps: Step[]): Promise<boolean> {
  for (const step of steps) {
    const r = await step.run();
    if (!r.ok) {
      console.log(`✗ ${step.name}: ${r.problem}\n    fix: ${r.fix}`);
      return false;
    }
    console.log(`✓ ${step.name}${r.note ? `: ${r.note}` : ''}`);
  }
  return true;
}

if (process.argv.includes('--after-pull')) {
  process.exitCode = (await runSteps(afterPull)) ? 0 : 1;
  if (!process.exitCode) console.log('\nUp to date.');
} else if (!(await runSteps(beforePull))) {
  process.exitCode = 1;
} else {
  const next = spawnSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/update.ts'), '--after-pull'], { cwd: APP_ROOT, stdio: 'inherit' });
  process.exitCode = next.status ?? 1;
}
