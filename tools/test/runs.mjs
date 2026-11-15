/**
 * The trees that passed the full suite on this clone: same tree hash, same result.
 * Kept in the git folder shared by every worktree of the clone (vanilla-test-runs.json), never in the repository.
 *
 *   node tools/test/runs.mjs tree            the clean tree's hash, nothing when the tree has changes
 *   node tools/test/runs.mjs check <tree>    exit 0 and say so when <tree> passed, else exit 1
 *   node tools/test/runs.mjs record <tree> <started>   after a green full run: records <tree> when it is still the checkout's clean tree
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function runsFile(root) {
  const common = git(root, 'rev-parse', '--git-common-dir');
  return join(isAbsolute(common) ? common : join(root, common), 'vanilla-test-runs.json');
}

/** The checkout's tree hash when nothing is changed, staged or untracked (ignored files do not count); undefined otherwise. */
export function cleanTree(root) {
  if (git(root, 'status', '--porcelain', '--untracked-files=normal')) return undefined;
  return git(root, 'rev-parse', 'HEAD^{tree}');
}

/** The tree of a commit. */
export const treeOf = (root, rev) => git(root, 'rev-parse', `${rev}^{tree}`);

export function greenRuns(root) {
  const file = runsFile(root);
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

export function record(root, tree, started) {
  if (cleanTree(root) !== tree) return false;
  const runs = greenRuns(root);
  const seconds = started ? Math.round(Date.now() / 1000 - Number(started)) : undefined;
  runs[tree] = { commit: git(root, 'rev-parse', 'HEAD'), at: new Date().toISOString(), node: process.version, ...(seconds ? { seconds } : {}) };
  const file = runsFile(root);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(runs, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return true;
}

export const describeRun = (tree, run) =>
  `tree ${tree.slice(0, 12)} passed the full suite ${run.at.slice(0, 16).replace('T', ' ')} (commit ${run.commit.slice(0, 9)}${run.seconds ? `, ${Math.round(run.seconds / 60)} min` : ''}): same tree, same result`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, tree, started] = process.argv.slice(2);
  const root = process.cwd();
  if (cmd === 'tree') { process.stdout.write(cleanTree(root) ?? ''); process.exit(0); }
  if (cmd === 'check') {
    const run = tree && greenRuns(root)[tree];
    if (!run) process.exit(1);
    console.log(`npm test: ${describeRun(tree, run)}. Nothing to run; npm test -- --force runs it again.`);
    process.exit(0);
  }
  if (cmd === 'record') {
    if (record(root, tree, started)) console.log(`npm test: recorded tree ${tree.slice(0, 12)} as green (${runsFile(root)})`);
    else console.log('npm test: the tree changed during the run; nothing recorded');
    process.exit(0);
  }
  console.error('usage: runs.mjs tree | check <tree> | record <tree> <started>');
  process.exit(2);
}
