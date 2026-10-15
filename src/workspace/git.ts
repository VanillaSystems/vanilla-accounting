/**
 * What the app does with git on a workspace, through isomorphic-git (pure JavaScript, no git
 * program; ADR 0006): a new repository for a workspace `init` writes, the commit of a year
 * close, the moves of a migration. The repository is the company's (ws.paths.repository, ADR 0013),
 * not the app's folder inside it. A workspace that is no repository of its own (a demo inside
 * the app's checkout, a folder never initialised) gets no commit, and the callers say so.
 */
import fs, { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import git from 'isomorphic-git';
import { appVersion } from '../version.js';

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
 * Commits exactly `paths` (files or folders, absolute or relative to `dir`) as they are on disk,
 * added, changed and deleted files alike, and nothing else: whatever else was staged before (a
 * migration's `git mv`) is set aside for the commit and staged again after it. False when none of
 * them differs from HEAD.
 */
export async function commitExactly(dir: string, message: string, paths: string[]): Promise<boolean> {
  const wanted = paths.map((p) => (isAbsolute(p) ? relative(dir, p) : p));
  const inWanted = (f: string) => wanted.some((w) => f === w || f.startsWith(`${w}/`));
  const differs = ([, head, , stage]: StatusRow) => (head === 0 ? stage !== 0 : stage !== 1);
  const others = (await git.statusMatrix({ fs, dir })).filter((row) => !inWanted(row[0]) && differs(row));
  const staged = await stagedEntries(dir, new Set(others.map(([f]) => f)));
  for (const [filepath] of others) await git.resetIndex({ fs, dir, filepath });
  try {
    const rows = await git.statusMatrix({ fs, dir, filepaths: wanted });
    for (const [filepath, head, workdir] of rows) {
      if (workdir === 0) { if (head === 1) await git.remove({ fs, dir, filepath }); }
      else await git.add({ fs, dir, filepath });
    }
    if (!(await git.statusMatrix({ fs, dir, filepaths: wanted })).some(differs)) return false;
    // The app's own commits (they carry Vanilla-Kind) say which build made them.
    const stamped = /\nVanilla-Kind: /.test(message) ? `${message}\nVanilla-Build: ${appVersion()}` : message;
    await git.commit({ fs, dir, message: stamped, author: await authorOf(dir) });
    return true;
  } finally {
    for (const [filepath] of others) {
      const entry = staged.get(filepath);
      if (entry) await git.updateIndex({ fs, dir, filepath, oid: entry.oid, mode: entry.mode, add: true });
      else await git.remove({ fs, dir, filepath });
    }
  }
}

type StatusRow = [string, number, number, number];

/** The index's blob and mode of each of `paths` that the index holds. */
async function stagedEntries(dir: string, paths: Set<string>): Promise<Map<string, { oid: string; mode: number }>> {
  const out = new Map<string, { oid: string; mode: number }>();
  if (!paths.size) return out;
  await git.walk({
    fs, dir, trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (entry && paths.has(filepath)) out.set(filepath, { oid: await entry.oid(), mode: await entry.mode() });
      return true;
    },
  });
  return out;
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
