/**
 * The build string (src/version.ts): derived from package.json and `git describe`, so a person can
 * tell one build from the next and compare it with the checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appVersion, describeBuild, isCut, versionFrom } from '../src/version.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const cases: Array<[planned: string, describe: string | undefined, version: string]> = [
  // towards an unreleased version: the count is the release candidate number
  ['0.4.0', 'v0.3.0-56-g36b66d6', '0.4.0-rc.56+g36b66d6'],
  ['0.4.0', 'v0.3.0-56-g36b66d6-dirty', '0.4.0-rc.56+g36b66d6.dirty'],
  // after a pre-release tag of the same version, the count goes on from that tag
  ['0.4.0', 'v0.4.0-rc.1-3-g1a2b3c4', '0.4.0-rc.1.3+g1a2b3c4'],
  ['0.4.0', 'v0.4.0-rc.1-0-g1a2b3c4', '0.4.0-rc.1+g1a2b3c4'],
  // the released version: commits past its tag are metadata, the release itself is bare
  ['0.3.0', 'v0.3.0-56-g36b66d6', '0.3.0+56.g36b66d6'],
  ['0.3.0', 'v0.3.0-0-g36b66d6', '0.3.0'],
  ['0.3.0', 'v0.3.0-0-g36b66d6-dirty', '0.3.0+0.g36b66d6.dirty'],
  // no tag reachable (a shallow clone): the sha alone; no git at all: the version alone
  ['0.3.0', '36b66d6', '0.3.0+g36b66d6'],
  ['0.3.0', '36b66d6-dirty', '0.3.0+g36b66d6.dirty'],
  ['0.3.0', undefined, '0.3.0'],
];

for (const [planned, describe, version] of cases) {
  test(`${planned} with "${describe}" is ${version}`, () => assert.equal(versionFrom(planned, describe), version));
}

// Cut but not tagged (CHANGELOG.md dates the version, no tag yet): the release's name, so its dmg is built and smoke-tested once.
const cut: Array<[planned: string, describe: string, version: string]> = [
  ['0.6.0', 'v0.5.0-41-g1a2b3c4', '0.6.0'],
  ['0.6.0', 'v0.6.0-rc.2-4-g1a2b3c4', '0.6.0'],
  ['0.6.0', '1a2b3c4', '0.6.0'],
  // never a dirty build
  ['0.6.0', 'v0.5.0-41-g1a2b3c4-dirty', '0.6.0-rc.41+g1a2b3c4.dirty'],
];
for (const [planned, describe, version] of cut) {
  test(`${planned} cut, with "${describe}", is ${version}`, () => assert.equal(versionFrom(planned, describe, true), version));
}

test('a release is cut while CHANGELOG.md dates its version and no tag names it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'version-cut-'));
  const sh = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  sh('init', '-q');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [Unreleased]\n\n## [0.5.0] - 2026-11-13\n');
  sh('add', '.');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'work towards 0.6.0');
  sh('tag', '-a', 'v0.5.0', '-m', 'v0.5.0');
  assert.equal(isCut(repo, '0.6.0'), false);
  assert.match(describeBuild(repo).version, /^0\.6\.0\+g[0-9a-f]+$|^0\.6\.0-rc\.0\+g/);
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [Unreleased]\n\n## [0.6.0] - 2026-11-14\n\n## [0.5.0] - 2026-11-13\n');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'Release 0.6.0');
  assert.equal(isCut(repo, '0.6.0'), true);
  assert.equal(describeBuild(repo).version, '0.6.0');
  assert.equal(describeBuild(repo).file, '0.6.0');
  writeFileSync(join(repo, 'stray.txt'), 'x');
  sh('add', 'stray.txt');
  assert.match(describeBuild(repo).version, /\.dirty$/);
  sh('rm', '-q', '--cached', 'stray.txt');
  rmSync(join(repo, 'stray.txt'));
  sh('tag', '-a', 'v0.6.0', '-m', 'v0.6.0');
  assert.equal(isCut(repo, '0.6.0'), false);
  assert.equal(describeBuild(repo).version, '0.6.0');
  rmSync(repo, { recursive: true, force: true });
});

test('this checkout: the version package.json names, a file name without +, a climbing number', () => {
  const { version: planned } = JSON.parse(readFileSync(`${APP_ROOT}/package.json`, 'utf8')) as { version: string };
  const b = describeBuild(APP_ROOT);
  assert.ok(b.version.startsWith(planned), b.version);
  assert.ok(!b.file.includes('+'), b.file);
  assert.ok(b.number > 0);
  assert.equal(appVersion(), b.version);
});
