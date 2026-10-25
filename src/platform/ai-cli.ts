/**
 * Detection of the AI CLIs on this Mac and the Terminal scripts that install them or sign in
 * (docs/0.4.0/ai-setup.md, «Detection»). Every look asks afresh: a CLI installed or signed in a
 * moment ago is found without a restart. Nothing here opens a CLI's login, its credential files or
 * its Keychain entries; the CLI itself answers whether it is signed in, and only its method and
 * plan are kept.
 */
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { loginPath, programOn } from './login-path.js';
import { AI_CLIS, shellQuote, type TerminalCli } from './terminal.js';
import type { CliProbe } from './ai-setup.js';

/** Where a look searches: the home whose ~/.local/bin the native installers write to, and the login shell's PATH. */
export interface Look {
  home?: string;
  path?: string;
}

let lastLogin: string | undefined;

/** The login shell's PATH, asked now (it takes a moment); the process's own when the shell does not answer. Kept for claudeBin(). */
export async function freshLoginPath(): Promise<string> {
  lastLogin = (await loginPath()) ?? process.env.PATH ?? '';
  return lastLogin;
}

/** CLAUDE_BIN or CODEX_BIN names the one program to run (a test's stub, a developer's own build); nothing else is looked for then. */
const pinned = (cli: TerminalCli): string | undefined => process.env[cli === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN'] || undefined;

/**
 * The places a look tries, in order: the PATH (the process's own, then the login shell's), then
 * ~/.local/bin, where the vendors' installers write before a new shell has it on its PATH.
 */
export function placesOf(cli: TerminalCli, { home = homedir(), path = process.env.PATH ?? '' }: Look = {}): string[] {
  const own = pinned(cli);
  if (own) return [own];
  const { program } = AI_CLIS[cli];
  return [...new Set([...path.split(':').filter(isAbsolute), join(home, '.local', 'bin')].map((dir) => join(dir, program)))];
}

/** The first executable of placesOf. */
export function locate(cli: TerminalCli, look: Look = {}): string | undefined {
  for (const place of placesOf(cli, look)) if (programOn(dirname(place), basename(place)) === place) return place;
  return undefined;
}

/**
 * The claude the app's steps run: as a look finds it, with the PATH of the last login-shell look
 * (refreshed by every detection); `claude` on the PATH when none is found, which fails as «no Claude».
 */
export const claudeBin = (): string => pinned('claude') ?? locate('claude', { path: knownPath() }) ?? 'claude';

/** The process's PATH and the login shell's as the last look found it. */
export const knownPath = (): string => [process.env.PATH, lastLogin].filter(Boolean).join(':');

interface Ran { code: number | null; stdout: string; timedOut: boolean }

/** Runs a CLI briefly from an empty folder, its own folder on the PATH (an npm-installed CLI finds its node). */
function runCli(bin: string, args: readonly string[], timeoutMs: number): Promise<Ran> {
  const env = { ...process.env, PATH: [dirname(bin), process.env.PATH, lastLogin].filter(Boolean).join(delimiter) };
  return new Promise((done) => {
    const child = execFile(bin, args, { cwd: tmpdir(), env, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
      done({ code: !e ? 0 : typeof e.code === 'number' ? e.code : null, stdout: stdout ?? '', timedOut: !!e?.killed });
    });
    // Nothing to read: a CLI that reads its input gets its end at once instead of waiting for the timeout.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
}

/** `claude --version` prints «2.1.211 (Claude Code)», `codex --version` «codex-cli 0.163.0»: the version number. */
export const versionOf = (stdout: string): string => /\d+\.\d+[\w.+-]*/.exec(stdout)?.[0] ?? stdout.trim().split('\n')[0] ?? '';

/**
 * `claude auth status`: JSON, exit 0 signed in. Of it the app keeps whether it is signed in, the
 * method and the plan (`subscriptionType`); the email, the organization and everything else are dropped.
 */
export function parseClaudeStatus(stdout: string, code: number | null): { loggedIn: boolean; method?: string; plan?: string } {
  let raw: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } = {};
  try { raw = JSON.parse(stdout); } catch { /* not JSON: the exit code says it */ }
  const loggedIn = typeof raw.loggedIn === 'boolean' ? raw.loggedIn : code === 0;
  return {
    loggedIn,
    ...(loggedIn && typeof raw.authMethod === 'string' && raw.authMethod ? { method: raw.authMethod } : {}),
    ...(loggedIn && typeof raw.subscriptionType === 'string' && raw.subscriptionType ? { plan: raw.subscriptionType } : {}),
  };
}

/** One look at one CLI: found, answering, signed in. `timeoutMs` for each command it runs. */
export async function probeCli(cli: TerminalCli, look: Look = {}, timeoutMs = 10_000): Promise<CliProbe> {
  const bin = locate(cli, look);
  if (!bin) return { found: 'none', looked: placesOf(cli, look).map(dirname) };
  const v = await runCli(bin, ['--version'], Math.min(timeoutMs, 8000));
  if (v.code !== 0) return { found: 'silent', bin };
  const version = versionOf(v.stdout);
  const s = await runCli(bin, AI_CLIS[cli].status, timeoutMs);
  if (s.timedOut || s.code === null) return { found: 'signedOut', bin, version };
  if (cli === 'claude') {
    const { loggedIn, method, plan } = parseClaudeStatus(s.stdout, s.code);
    return loggedIn ? { found: 'signedIn', bin, version, ...(method ? { method } : {}), ...(plan ? { plan } : {}) } : { found: 'signedOut', bin, version };
  }
  return s.code === 0 ? { found: 'signedIn', bin, version } : { found: 'signedOut', bin, version };
}

/** Every CLI, looked for with the login shell's PATH as it is now. */
export async function probeAll(home?: string): Promise<Array<{ cli: TerminalCli; probe: CliProbe }>> {
  const path = await freshLoginPath();
  return Promise.all((Object.keys(AI_CLIS) as TerminalCli[]).map(async (cli) => ({ cli, probe: await probeCli(cli, { path, ...(home ? { home } : {}) }) })));
}

/**
 * The words a Terminal script prints, in the person's language (src/server/ai-setup.ts). The
 * screens are for people who never used a terminal: a title, three numbered steps, the command
 * shown small for transparency, one visible prompt, and a plain end state.
 */
export interface ScriptTexts {
  /** The window's title and the boxed header. */
  title: string;
  steps: readonly [string, string, string];
  /** «Was ausgeführt wird:», above the command. */
  runs: string;
  /** The line that waits for Enter. */
  prompt: string;
  /** While the installer runs. */
  working: string;
  installed: string;
  /** After the install: Enter signs in. */
  signInPrompt: string;
  done: string;
  failed: string;
  signInFailed: string;
  /** Where to go on after a failure. */
  back: string;
}

/**
 * The script's head: its folder removed, the window's title set, colours unless NO_COLOR, and
 * `say`, `ok`, `bad` and `dim` to print a line indented. Every text is one quoted shell word.
 */
function head(scriptDir: string, t: Pick<ScriptTexts, 'title' | 'steps' | 'runs'>, command: string): string[] {
  return [
    '#!/bin/sh',
    `rm -rf ${shellQuote(scriptDir)}`,
    `printf '\\033]0;%s\\007' ${shellQuote(t.title)}`,
    `if [ -z "\${NO_COLOR:-}" ]; then B=$(printf '\\033[1m'); D=$(printf '\\033[2m'); G=$(printf '\\033[32m'); R=$(printf '\\033[31m'); C=$(printf '\\033[36m'); N=$(printf '\\033[0m'); else B=; D=; G=; R=; C=; N=; fi`,
    `say() { printf '  %s\\n' "$1"; }`,
    `ok() { printf '\\n  %s✓ %s%s\\n' "$G$B" "$1" "$N"; }`,
    `bad() { printf '\\n  %s✗ %s%s\\n' "$R$B" "$1" "$N"; }`,
    `dim() { printf '  %s%s%s\\n' "$D" "$1" "$N"; }`,
    `ask() { printf '\\n  %s➜ %s%s ' "$B" "$1" "$N"; read answer; }`,
    'clear',
    `printf '\\n  %s╭────────────────────────────────────────────────────%s\\n' "$C" "$N"`,
    `printf '  %s│%s  %s%s%s\\n' "$C" "$N" "$B" ${shellQuote(t.title)} "$N"`,
    `printf '  %s╰────────────────────────────────────────────────────%s\\n\\n' "$C" "$N"`,
    ...t.steps.map((step, i) => `say ${shellQuote(`${i + 1}. ${step}`)}`),
    'echo',
    `dim ${shellQuote(t.runs)}`,
    `dim ${shellQuote(command)}`,
  ];
}

/** The sign-in and its end state, the CLI found where its installer put it. */
function signIn(cli: TerminalCli, bin: string, t: Pick<ScriptTexts, 'done' | 'signInFailed' | 'back'>): string[] {
  return [
    'echo',
    `if ${[bin, ...AI_CLIS[cli].login].map(shellQuote).join(' ')}; then ok ${shellQuote(t.done)}; else bad ${shellQuote(t.signInFailed)}; say ${shellQuote(t.back)}; fi`,
    'echo',
  ];
}

/**
 * The installer's .command script: what will happen in three steps, the vendor's command shown,
 * and nothing runs before Enter (end of input or a closed window ends it unrun). While the
 * installer runs, one line says so; its output goes to a log whose last lines are shown when it
 * fails. Installed, Enter signs in with the CLI's own login in the same window.
 */
export function installScript(cli: TerminalCli, scriptDir: string, t: ScriptTexts): string {
  const { install, program } = AI_CLIS[cli];
  return [
    ...head(scriptDir, t, install),
    `ask ${shellQuote(t.prompt)} || exit 0`,
    'log=$(mktemp "${TMPDIR:-/tmp}/vanilla-install.XXXXXX")',
    'echo',
    `say ${shellQuote(t.working)}`,
    `if ! ( ${install} ) >"$log" 2>&1; then bad ${shellQuote(t.failed)}; tail -n 5 "$log" | while IFS= read -r line; do dim "$line"; done; say ${shellQuote(t.back)}; echo; exit 1; fi`,
    'rm -f "$log"',
    'PATH="$HOME/.local/bin:$PATH"; export PATH',
    `ok ${shellQuote(t.installed)}`,
    `ask ${shellQuote(t.signInPrompt)} || exit 0`,
    ...signIn(cli, program, t),
    '',
  ].join('\n');
}

/** The sign-in's .command script: the steps, then the CLI's own login (it opens the browser) and its end state. */
export function loginScript(cli: TerminalCli, bin: string, scriptDir: string, t: Omit<ScriptTexts, 'prompt' | 'working' | 'installed' | 'signInPrompt' | 'failed'>): string {
  return [
    ...head(scriptDir, t, [AI_CLIS[cli].program, ...AI_CLIS[cli].login].join(' ')),
    ...signIn(cli, bin, t),
    '',
  ].join('\n');
}
