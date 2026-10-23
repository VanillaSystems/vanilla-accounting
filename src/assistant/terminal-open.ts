/**
 * Which terminal CLIs this computer has and opening one (issue #146; the shared part is
 * src/assistant/terminal.ts). A CLI is found on the login shell's PATH, as the desktop app finds
 * claude (src/desktop/claude.ts): an app started from the Finder has only /usr/bin:/bin.
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loginPath, programOn } from '../desktop/claude.js';
import { CLI_PROGRAM, REQUEST_MAX, TERMINAL_CLIS, launchScript, type CliState } from './terminal.js';

let pathOnce: Promise<string> | undefined;
/** The login shell's PATH, asked once per process (it takes a moment); the process's own when the shell does not answer. */
export const terminalPath = (): Promise<string> => (pathOnce ??= loginPath().then((p) => p ?? process.env.PATH ?? ''));

/** A CLI found, with the path Terminal starts it by. */
export type FoundCli = CliState & { bin?: string };

/** `codex login status`: exit 0 signed in, another exit code not; no answer (it did not start, or hung) is not known. */
export function codexSignedIn(bin: string, path: string, timeoutMs = 10_000): Promise<boolean | undefined> {
  return new Promise((done) => {
    execFile(bin, ['login', 'status'], { cwd: tmpdir(), timeout: timeoutMs, env: { ...process.env, PATH: path } }, (err) => {
      if (!err) return done(true);
      const code = (err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean }).code;
      done(typeof code === 'number' && !(err as { killed?: boolean }).killed ? false : undefined);
    });
  });
}

/**
 * Whether the app's own Claude steps work: the newest claude-cli call of the books' ledger
 * (data/llm-ledger.jsonl) answered. A failed call proves nothing (a limit, a timeout), so it is not known then.
 */
export function claudeSignedIn(ledger: string): true | undefined {
  if (!existsSync(ledger)) return undefined;
  const size = statSync(ledger).size;
  const length = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(length);
  const fd = openSync(ledger, 'r');
  try { readSync(fd, buf, 0, length, size - length); } finally { closeSync(fd); }
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as { provider?: string; ok?: boolean };
      if (row.provider === 'claude-cli') return row.ok ? true : undefined;
    } catch { /* the first line of the tail is cut, or empty */ }
  }
  return undefined;
}

export interface Detect {
  path: string;
  /** The books' ledger of model calls, for Claude's sign-in. */
  ledger: string;
  /** The desktop app's claude, found at its start (src/desktop/main.ts). */
  claudeBin?: string;
  codexStatus?: (bin: string, path: string) => Promise<boolean | undefined>;
}

export async function detectClis({ path, ledger, claudeBin, codexStatus = codexSignedIn }: Detect): Promise<FoundCli[]> {
  return Promise.all(TERMINAL_CLIS.map(async (cli): Promise<FoundCli> => {
    const own = cli === 'claude' && claudeBin ? programOn(dirname(claudeBin), basename(claudeBin)) : undefined;
    const bin = own ?? programOn(path, CLI_PROGRAM[cli]);
    if (!bin) return { cli, installed: false };
    const signedIn = cli === 'claude' ? claudeSignedIn(ledger) : await codexStatus(bin, path);
    return { cli, installed: true, signedIn, bin };
  }));
}

/** The state without the path, as GET /api/terminal shows it. */
export const stateOf = ({ bin: _bin, ...state }: FoundCli): CliState => state;

type Run = (command: string, args: string[], done: (err: Error | null) => void) => void;
/** VANILLA_TERMINAL_OPENER: another program than `open` gets `-a Terminal <script>` (a test runs the script itself). */
const run: Run = (command, args, done) => { execFile(command === 'open' ? process.env.VANILLA_TERMINAL_OPENER || 'open' : command, args, (err) => done(err)); };

/**
 * Opens a Terminal window in `folder` with `bin` started on `request`. The request goes into a file
 * of a new private folder, which the script reads and removes (src/assistant/terminal.ts
 * launchScript); `open -a Terminal` runs the .command file and needs no permission to control Terminal.
 */
export function openInTerminal(folder: string, bin: string, request: string, start: Run = run): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-terminal-'));
  const requestFile = join(dir, 'request.txt');
  const script = join(dir, 'vanilla.command');
  writeFileSync(requestFile, request.trim().slice(0, REQUEST_MAX), { mode: 0o600 });
  writeFileSync(script, launchScript(folder, bin, requestFile, dir), { mode: 0o700 });
  return new Promise((done, fail) => {
    start('open', ['-a', 'Terminal', script], (err) => (err ? fail(err) : done(script)));
  });
}

