/**
 * The app's own git (src/workspace/git.ts, isomorphic-git): a repository for a new workspace,
 * the commit of a year close. Checked against the git program as an independent reader of what
 * the app wrote; the app itself runs with nothing on the PATH (tests/init.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths, initRepository, isTracked, repositoryAt } from '../src/workspace/git.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

test('init commits the folder; a commit of paths takes only them, once per change; a subfolder is no repository of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-git-'));
  mkdirSync(join(dir, 'filings/2026'), { recursive: true });
  writeFileSync(join(dir, 'books.json'), '{}');
  writeFileSync(join(dir, 'filings/2026/seal-Q1.json'), '{}');
  assert.equal(await repositoryAt(dir), null, 'not a repository yet');

  process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
  process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
  await initRepository(dir, 'Workspace set up');
  assert.equal(git(dir, 'log', '--format=%s|%an|%ae'), 'Workspace set up|Erika Beispiel|erika@example.com');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'everything committed');
  assert.equal(await repositoryAt(dir), dir);
  assert.equal(await repositoryAt(join(dir, 'filings')), null, 'inside a repository, not one of its own');
  assert.equal(await isTracked(dir, 'filings/2026/seal-Q1.json'), true);

  assert.equal(await commitPaths(dir, 'Nothing changed', [join(dir, 'books.json')]), false);
  writeFileSync(join(dir, 'books.json'), '{"schema":2}');
  writeFileSync(join(dir, 'filings/2026/seal-Q4.json'), '{}');
  writeFileSync(join(dir, 'notes.md'), 'not part of the close');
  assert.equal(await commitPaths(dir, 'Jahresabschluss 2026', [join(dir, 'books.json'), join(dir, 'filings/2026'), join(dir, 'missing')]), true);
  assert.equal(git(dir, 'show', '--stat', '--format=%s', 'HEAD').split('\n')[0], 'Jahresabschluss 2026');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['books.json', 'filings/2026/seal-Q4.json']);
  assert.equal(git(dir, 'status', '--porcelain'), '?? notes.md', 'the note stays unstaged');
  assert.equal(await commitPaths(dir, 'Again', [join(dir, 'books.json')]), false, 'a rerun has nothing to commit');
});
