/**
 * npm run test:changed [-- <base-ref>] [--list] [--force]: runs the test files a change can break
 * (tools/test/select.ts), through the same runner as npm test (tools/test/run.sh: its lock, nice,
 * concurrency and time limit).
 *
 * The change is everything since the merge-base of HEAD with <base-ref> (origin/next unless named),
 * uncommitted and untracked files included. When a commit since then passed the full suite
 * (tools/test/runs.mjs), the change counts from the newest such commit instead. A change the graph
 * cannot place runs the full suite and says why. --list prints the selection and runs nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules, select } from './select.ts';
import { describeRun, greenRuns } from './runs.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const list = args.includes('--list');
const force = args.includes('--force');
const named = args.find((a) => !a.startsWith('--'));
const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const lines = (s: string): string[] => s.split('\n').filter(Boolean);

const ref = named ?? 'origin/next';
let base = git('merge-base', 'HEAD', ref);
let baseWhy = `merge-base with ${ref}`;
const runs = greenRuns(root);
for (const line of lines(git('rev-list', '--first-parent', '--format=%H %T', '--no-commit-header', `${base}..HEAD`))) {
  const [commit, tree] = line.split(' ');
  if (runs[tree]) { base = commit; baseWhy = describeRun(tree, runs[tree]); break; }
}

const changed = new Set<string>();
for (const line of lines(git('diff', '--name-status', '-M', base))) {
  const [, ...paths] = line.split('\t');
  for (const p of paths) changed.add(p);
}
for (const p of lines(git('ls-files', '--others', '--exclude-standard'))) changed.add(p);
const files = lines(git('ls-files', '--cached', '--others', '--exclude-standard')).filter((f) => existsSync(join(root, f)));
const allTests = files.filter((f) => /^tests\/.*\.test\.ts$/.test(f)).length;

console.log(`test:changed: ${changed.size} file${changed.size === 1 ? '' : 's'} changed since ${base.slice(0, 9)} (${baseWhy})`);
for (const f of [...changed].sort()) console.log(`  ${f}`);
if (!changed.size) {
  console.log('Nothing changed: nothing to run.');
  process.exit(0);
}

const t0 = Date.now();
const rules = loadRules();
const sel = select(root, files, [...changed], rules);
const took = ((Date.now() - t0) / 1000).toFixed(1);

const typed = [...changed].some((f) => /\.(ts|tsx|mts|cts|mjs)$/.test(f));
const run = (testArgs: string[]): never => {
  if (list) process.exit(0);
  // The types of the whole program, as npm test checks them first; incremental, so a second run takes seconds.
  if (testArgs.length && typed) {
    console.log('types: tsc --noEmit (incremental)');
    const tsc = spawnSync('sh', ['-c', 'nice -n 10 npx tsc --noEmit --incremental --tsBuildInfoFile "$(git rev-parse --git-dir)/vanilla-tsc.tsbuildinfo"'], { cwd: root, stdio: 'inherit' });
    if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  }
  const r = spawnSync('sh', [join(import.meta.dirname, 'run.sh'), ...(force ? ['--force'] : []), ...testArgs], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

if (sel.full) {
  console.log(`\nthe full suite (${allTests} test files), types first: ${sel.full}`);
  run([]);
}
const width = Math.max(...[...sel.tests.keys()].map((t) => t.length));
console.log(`\nselected ${sel.tests.size} of ${allTests} test files (${took} s):`);
for (const [t, why] of [...sel.tests].sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${t.padEnd(width)}  ${why}`);
console.log(sel.golden.length
  ? `\nVAT golden master: added, on every demo workspace (${sel.golden.slice(0, 3).join(', ')}${sel.golden.length > 3 ? ', …' : ''})`
  : '\nVAT golden master: not needed (nothing of the books\' figures changed)');
if (sel.untested.length) {
  console.log('no test for:');
  for (const u of sel.untested) console.log(`  ${u.file}: ${u.why}`);
}
console.log(sel.vm.length
  ? `VM tests before a release: needed (${sel.vm.slice(0, 3).join(', ')}${sel.vm.length > 3 ? ', …' : ''}): ${rules.vm.why}`
  : 'VM tests before a release: not needed');
console.log(typed ? 'types: tsc --noEmit, a TypeScript file changed\n' : 'types: no TypeScript file changed\n');
run([...sel.tests.keys()].sort());
