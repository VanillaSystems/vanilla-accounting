/**
 * What the app does with git on a workspace, through isomorphic-git (pure JavaScript, no git
 * program; ADR 0006): a new repository for a workspace `init` writes, the commit of a year
 * close, the moves of a migration. A workspace that is no repository of its own (a demo inside
 * the app's checkout, a folder never initialised) gets no commit, and the callers say so.
 */
import fs, { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import git from 'isomorphic-git';

/** The repository `dir` is the root of, or null when it is none or lies inside another one. */
export async function repositoryAt(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, '.git'))) return null;
  try {
    const root = await git.findRoot({ fs, filepath: dir });
    return fs.realpathSync(root) === fs.realpathSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Whether the index holds `path` (relative to the repository). */
export async function isTracked(dir: string, path: string): Promise<boolean> {
  return (await git.listFiles({ fs, dir })).includes(path);
}

/** `git mv`: the file moves on disk and in the index. */
export async function moveTracked(dir: string, from: string, to: string): Promise<void> {
  renameSync(join(dir, from), join(dir, to));
  await git.remove({ fs, dir, filepath: from });
  await git.add({ fs, dir, filepath: to });
}

/** `git rm`: the file leaves the index and the disk. */
export async function removeTracked(dir: string, path: string): Promise<void> {
  await git.remove({ fs, dir, filepath: path });
  fs.rmSync(join(dir, path), { force: true });
}

/**
 * Stages `paths` (files or folders, absolute or relative to `dir`) and commits them when any of
 * them changed against HEAD; nothing else is staged or committed. False when nothing changed.
 */
export async function commitPaths(dir: string, message: string, paths: string[]): Promise<boolean> {
  const filepath = paths.filter((p) => existsSync(join(dir, relative(dir, p)))).map((p) => relative(dir, p));
  if (!filepath.length) return false;
  await git.add({ fs, dir, filepath });
  const changed = (await git.statusMatrix({ fs, dir, filepaths: filepath })).some(([, head, , stage]) => head !== stage);
  if (!changed) return false;
  await git.commit({ fs, dir, message, author: await authorOf(dir) });
  return true;
}

/** `git init` plus a first commit of everything in the folder. */
export async function initRepository(dir: string, message: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: 'main' });
  await git.add({ fs, dir, filepath: '.' });
  await git.commit({ fs, dir, message, author: await authorOf(dir) });
}

/** The committer, as git would pick it: GIT_AUTHOR_*, the repository's user, ~/.gitconfig, else the app itself. */
async function authorOf(dir: string): Promise<{ name: string; email: string }> {
  const local = { name: await git.getConfig({ fs, dir, path: 'user.name' }), email: await git.getConfig({ fs, dir, path: 'user.email' }) };
  const global = globalUser();
  return {
    name: process.env.GIT_AUTHOR_NAME || local.name || global.name || 'Vanilla Accounting',
    email: process.env.GIT_AUTHOR_EMAIL || local.email || global.email || 'vanilla-accounting@localhost',
  };
}

/** isomorphic-git reads only the repository's config; the user's own ~/.gitconfig is read here. */
function globalUser(): { name?: string; email?: string } {
  try {
    const text = readFileSync(join(homedir(), '.gitconfig'), 'utf8');
    const section = text.split(/^\[/m).find((s) => s.startsWith('user]')) ?? '';
    const value = (key: string) => section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
    return { name: value('name'), email: value('email') };
  } catch {
    return {};
  }
}
