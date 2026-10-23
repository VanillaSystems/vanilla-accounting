/**
 * The `claude` CLI for the desktop app. An app started from the Finder gets a PATH of
 * /usr/bin:/bin, not the one the person's terminal has, so the CLI is looked up through their
 * login shell. Only its path is taken: the app's own PATH stays as it is, so nothing else comes to
 * depend on what a terminal happens to have installed.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

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

/** The first executable `name` on `path`. A shell alias of that name is not a program and is not found. */
export function programOn(path: string, name: string): string | undefined {
  return path.split(':').filter(isAbsolute).map((dir) => join(dir, name)).find(executable);
}

export const claudeOn = (path: string): string | undefined => programOn(path, 'claude');

export async function findClaude(shell?: string): Promise<string | undefined> {
  const path = await loginPath(shell);
  return path ? claudeOn(path) : undefined;
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
