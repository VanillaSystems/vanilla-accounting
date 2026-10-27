/**
 * Which terminal CLIs and terminal apps this computer has, and opening one (issues #146, #210; the
 * shared part is src/platform/terminal.ts). A CLI is found as src/platform/ai-cli.ts looks for it,
 * afresh each time: in ~/.local/bin and on the login shell's PATH (an app started from the Finder
 * has only /usr/bin:/bin).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAll } from './ai-cli.js';
import type { CliProbe } from './ai-setup.js';
import { REQUEST_MAX, TERMINAL_APPS, TERMINAL_APP_FACTS, launchScript, openArgs, type CliState, type TerminalApp, type TerminalCli } from './terminal.js';

/** A CLI found, with the path the terminal starts it by. */
export type FoundCli = CliState & { bin?: string };

/** A look's answer as «Im Terminal» needs it: a program that does not answer counts as not installed. */
export function foundOf({ cli, probe }: { cli: TerminalCli; probe: CliProbe }): FoundCli {
  if (probe.found === 'none' || probe.found === 'silent') return { cli, installed: false };
  return { cli, installed: true, signedIn: probe.found === 'signedIn', bin: probe.bin };
}

export const detectClis = async (home?: string): Promise<FoundCli[]> => (await probeAll(home)).map(foundOf);

/** The state without the path, as GET /api/terminal shows it. */
export const stateOf = ({ bin: _bin, ...state }: FoundCli): CliState => state;

/** The folders a terminal app is installed in; VANILLA_APPLICATIONS (separated by «:») names others (a test names a folder of its own). */
export const applicationFolders = (): string[] =>
  process.env.VANILLA_APPLICATIONS?.split(':').filter(Boolean) ?? ['/Applications', join(homedir(), 'Applications'), '/Applications/Utilities'];

/** The terminal apps installed, in the table's order: Terminal always, as macOS has it in /System. */
export function detectTerminalApps(folders: readonly string[] = applicationFolders()): TerminalApp[] {
  return TERMINAL_APPS.filter((app) => app === 'terminal' || folders.some((f) => existsSync(join(f, `${TERMINAL_APP_FACTS[app].bundle}.app`))));
}

export type Run = (command: string, args: string[], done: (err: Error | null) => void) => void;
/** VANILLA_TERMINAL_OPENER: another program than `open` gets its arguments (a test runs the script itself). */
const run: Run = (command, args, done) => { execFile(command === 'open' ? process.env.VANILLA_TERMINAL_OPENER || 'open' : command, args, (err) => done(err)); };

/**
 * Writes the .command script `scriptOf(dir)` into a new private folder `dir` and lets `app` run it
 * by `open` (openArgs), which needs no permission to control the app. The script removes its folder.
 */
export function openScript(scriptOf: (dir: string) => string, app: TerminalApp = 'terminal', start: Run = run): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-terminal-'));
  // Terminal names the window after the file: a name a person reads.
  const script = join(dir, 'Vanilla Accounting.command');
  writeFileSync(script, scriptOf(dir), { mode: 0o700 });
  return new Promise((done, fail) => {
    start('open', openArgs(app, script), (err) => (err ? fail(err) : done(script)));
  });
}

export interface Opening {
  folder: string;
  bin: string;
  /** The person's request; empty or absent: the CLI starts with no prompt (issue #210). */
  request?: string;
  app?: TerminalApp;
}

/**
 * Opens a window of `app` in `folder` with `bin` started, on `request` when there is one. The
 * request goes into a file beside the script, which reads and removes it (launchScript).
 */
export function openInTerminal({ folder, bin, request, app = 'terminal' }: Opening, start: Run = run): Promise<string> {
  const text = request?.trim().slice(0, REQUEST_MAX);
  return openScript((dir) => {
    if (!text) return launchScript(folder, bin, dir);
    const requestFile = join(dir, 'request.txt');
    writeFileSync(requestFile, text, { mode: 0o600 });
    return launchScript(folder, bin, dir, requestFile);
  }, app, start);
}
