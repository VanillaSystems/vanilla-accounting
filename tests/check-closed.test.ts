/**
 * #117: npm run check-closed reads its baseline from git for a workspace whose books lie in the
 * app's folder of a repository (ADR 0013), not only when that folder is the repository's root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { APP_ROOT } from '../src/workspace/workspace.js';

const repo = mkdtempSync(join(tmpdir(), 'check-closed-'));
cpSync(join(APP_ROOT, 'demo-consulting'), repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', stdio: 'pipe' });
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'books');

const checkClosed = () => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/check-closed-period.ts'], {
  cwd: APP_ROOT, encoding: 'utf8', env: { ...process.env, VANILLA_WORKSPACE: repo },
});
const entries = join(repo, 'vanilla-accounting/transactional-data/2026/books/entries.jsonl');

test.after(() => rmSync(repo, { recursive: true, force: true }));

test('unchanged books in vanilla-accounting/ of a repository: the baseline holds every closed record', () => {
  const run = checkClosed();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const counts = [...run.stdout.matchAll(/(\d+) baseline \/ (\d+) current/g)];
  assert.equal(counts.length, 3, run.stdout);
  for (const [, base, curr] of counts) {
    assert.ok(Number(base) > 0, run.stdout);
    assert.equal(base, curr, run.stdout);
  }
});

test('a changed closed entry in vanilla-accounting/ of a repository is the one violation', () => {
  const original = readFileSync(entries, 'utf8');
  try {
    const lines = original.split('\n');
    const i = lines.findIndex((l) => /"date":"2026-0[1-3]-/.test(l));
    const entry = JSON.parse(lines[i]);
    lines[i] = JSON.stringify({ ...entry, amount: entry.amount + 1 });
    writeFileSync(entries, lines.join('\n'));
    const run = checkClosed();
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, new RegExp(`✗ 1 closed-period violation\\(s\\):\\n  journalEntry MODIFIED  ${entry.id}`));
  } finally {
    writeFileSync(entries, original);
  }
});
