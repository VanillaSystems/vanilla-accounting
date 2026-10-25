/**
 * Which terminal CLIs this computer has and opening Terminal (issue #146; the shared part is
 * src/platform/terminal.ts). A CLI is found as src/platform/ai-cli.ts looks for it, afresh each time:
 * in ~/.local/bin and on the login shell's PATH (an app started from the Finder has only /usr/bin:/bin).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAll } from './ai-cli.js';
import type { CliProbe } from './ai-setup.js';
import { REQUEST_MAX, launchScript, type CliState, type TerminalCli } from './terminal.js';

/** A CLI found, with the path Terminal starts it by. */
export type FoundCli = CliState & { bin?: string };

/** A look's answer as «Im Terminal» needs it: a program that does not answer counts as not installed. */
export function foundOf({ cli, probe }: { cli: TerminalCli; probe: CliProbe }): FoundCli {
  if (probe.found === 'none' || probe.found === 'silent') return { cli, installed: false };
  return { cli, installed: true, signedIn: probe.found === 'signedIn', bin: probe.bin };
}

export const detectClis = async (home?: string): Promise<FoundCli[]> => (await probeAll(home)).map(foundOf);

/** The state without the path, as GET /api/terminal shows it. */
export const stateOf = ({ bin: _bin, ...state }: FoundCli): CliState => state;

export type Run = (command: string, args: string[], done: (err: Error | null) => void) => void;
/** VANILLA_TERMINAL_OPENER: another program than `open` gets `-a Terminal <script>` (a test runs the script itself). */
const run: Run = (command, args, done) => { execFile(command === 'open' ? process.env.VANILLA_TERMINAL_OPENER || 'open' : command, args, (err) => done(err)); };

/**
 * Writes the .command script `scriptOf(dir)` into a new private folder `dir` and lets Terminal run
 * it: `open -a Terminal` needs no permission to control Terminal. The script removes its folder.
 */
export function openScript(scriptOf: (dir: string) => string, start: Run = run): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-terminal-'));
  // Terminal names the window after the file: a name a person reads.
  const script = join(dir, 'Vanilla Accounting.command');
  writeFileSync(script, scriptOf(dir), { mode: 0o700 });
  return new Promise((done, fail) => {
    start('open', ['-a', 'Terminal', script], (err) => (err ? fail(err) : done(script)));
  });
}

/**
 * Opens a Terminal window in `folder` with `bin` started on `request`. The request goes into a file
 * beside the script, which reads and removes it (src/platform/terminal.ts launchScript).
 */
export function openInTerminal(folder: string, bin: string, request: string, start: Run = run): Promise<string> {
  return openScript((dir) => {
    const requestFile = join(dir, 'request.txt');
    writeFileSync(requestFile, request.trim().slice(0, REQUEST_MAX), { mode: 0o600 });
    return launchScript(folder, bin, requestFile, dir);
  }, start);
}
