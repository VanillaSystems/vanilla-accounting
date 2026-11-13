/**
 * A program as the person's terminal finds it: the desktop app's claude (src/desktop/main.ts) and
 * the terminal CLIs (src/platform/terminal-open.ts). An app started from the Finder gets a PATH of
 * /usr/bin:/bin, not the one the person's terminal has, so a CLI is looked up through their
 * login shell. Only its path is taken: the app's own PATH stays as it is, so nothing else comes to
 * depend on what a terminal happens to have installed.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

const MARK = '__vanilla_path__';

/** The PATH of `shell` started as a login shell, or undefined when it does not answer. */
export function loginPath(shell = process.env.SHELL || '/bin/zsh', timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    // -i as well: many people set their PATH in .zshrc, which a login shell alone does not read.
    execFile(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: timeoutMs, encoding: 'utf8' }, (_err, stdout) => {
      resolve(new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout ?? '')?.[1]);
    });
  });
}

/**
 * Whether `dir` lies in the Documents, Desktop or Downloads folder of `home`: macOS asks the person
 * before an app looks there (#373), so a PATH entry there is never looked into, and a synchronous
 * look would hold the process while it asks.
 */
export function inProtectedFolder(dir: string, home = homedir()): boolean {
  return ['Documents', 'Desktop', 'Downloads'].some((f) => { const p = join(home, f); return dir === p || dir.startsWith(p + sep); });
}

/** The first executable `name` on `path`. A shell alias of that name is not a program and is not found. */
export function programOn(path: string, name: string): string | undefined {
  return path.split(':').filter((dir) => isAbsolute(dir) && !inProtectedFolder(dir)).map((dir) => join(dir, name)).find(executable);
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
