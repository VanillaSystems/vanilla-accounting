/**
 * The git program, when a real one is installed. On a Mac without the Command Line Tools,
 * /usr/bin/git is a stub: running it, even `git --version`, opens the system dialog that offers
 * to install the developer tools (or all of Xcode). The app does its own git work through
 * isomorphic-git (src/workspace/git.ts); the program is only for syncing with a remote through
 * the person's credential helper, and for developer CLIs. So it is looked up without ever
 * running the stub: Homebrew's git, or /usr/bin/git only when `xcode-select -p` names a
 * developer folder that holds git (xcode-select itself is no stub and opens no dialog).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export interface GitProbe {
  platform: NodeJS.Platform;
  executable(path: string): boolean;
  /** What `xcode-select -p` prints, or undefined when it exits non-zero (no developer tools). */
  developerDir(): string | undefined;
}

const HOMEBREW = ['/opt/homebrew/bin/git', '/usr/local/bin/git'];

export const systemProbe: GitProbe = {
  platform: process.platform,
  executable(path) {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  },
  developerDir() {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  },
};

/** The git program to run, or undefined when running one could open the developer-tools dialog. Off a Mac, `git` on the PATH. */
export function findGit(probe: GitProbe = systemProbe): string | undefined {
  if (probe.platform !== 'darwin') return 'git';
  const brew = HOMEBREW.find((p) => probe.executable(p));
  if (brew) return brew;
  const dev = probe.developerDir();
  return dev && probe.executable(join(dev, 'usr', 'bin', 'git')) ? '/usr/bin/git' : undefined;
}

let found: { git: string | undefined } | undefined;

/** This process's git program, looked up once. */
export function gitProgram(): string | undefined {
  return (found ??= { git: findGit() }).git;
}

/** For a CLI that cannot work without git: the program, or an error that says what to install. */
export function requireGit(): string {
  const git = gitProgram();
  if (!git) throw new Error('This command needs the git program, which is not installed. Install it with Homebrew (brew install git) or the Command Line Tools (xcode-select --install).');
  return git;
}
