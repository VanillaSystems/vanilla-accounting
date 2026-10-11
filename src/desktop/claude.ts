/**
 * The `claude` CLI for the desktop app. An app started from the Finder gets a PATH of
 * /usr/bin:/bin, not the one the person's terminal has, so the CLI is looked up through their
 * login shell. Only its path is taken: the app's own PATH stays as it is, so nothing else comes to
 * depend on what a terminal happens to have installed.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
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

/** The first executable `claude` on `path`. A shell alias of that name is not a program and is not found. */
export function claudeOn(path: string): string | undefined {
  return path.split(':').filter(isAbsolute).map((dir) => join(dir, 'claude')).find(executable);
}

/**
 * The CLI on the login PATH, else in ~/.local/bin, where the official installer puts it: right
 * after "Claude einrichten" the shell's profile may not name that folder yet.
 */
export async function findClaude(shell?: string): Promise<string | undefined> {
  const path = await loginPath(shell);
  return claudeOn([path, join(homedir(), '.local/bin')].filter(Boolean).join(':'));
}

/**
 * Looks for the CLI again and sets CLAUDE_BIN, which src/llm/ask.ts reads on every call: a CLI
 * installed while the app runs is used from the next inbox job on, without a restart.
 */
export async function resolveClaude(shell?: string): Promise<string | undefined> {
  const bin = await findClaude(shell);
  if (bin) process.env.CLAUDE_BIN = bin;
  else delete process.env.CLAUDE_BIN;
  return bin;
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
