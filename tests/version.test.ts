/**
 * The build string (src/version.ts): derived from package.json and `git describe`, so a person can
 * tell one build from the next and compare it with the checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appVersion, describeBuild, versionFrom } from '../src/version.js';
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

test('this checkout: the version package.json names, a file name without +, a climbing number', () => {
  const { version: planned } = JSON.parse(readFileSync(`${APP_ROOT}/package.json`, 'utf8')) as { version: string };
  const b = describeBuild(APP_ROOT);
  assert.ok(b.version.startsWith(planned), b.version);
  assert.ok(!b.file.includes('+'), b.file);
  assert.ok(b.number > 0);
  assert.equal(appVersion(), b.version);
});
