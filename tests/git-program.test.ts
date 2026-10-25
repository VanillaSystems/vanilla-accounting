import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGit, type GitProbe } from '../src/platform/git-program.js';

const mac = (executables: string[], developerDir?: string): GitProbe & { asked: number } => {
  const probe = { platform: 'darwin' as const, asked: 0, executable: (p: string) => executables.includes(p), developerDir: () => { probe.asked++; return developerDir; } };
  return probe;
};

test('a fresh Mac has no git: the /usr/bin/git stub is never chosen', () => {
  assert.equal(findGit(mac(['/usr/bin/git'])), undefined);
  assert.equal(findGit(mac(['/usr/bin/git'], '/Applications/Xcode.app/Contents/Developer')), undefined, 'a developer folder without git');
});

test('git of the Command Line Tools or Xcode runs through /usr/bin/git', () => {
  assert.equal(findGit(mac(['/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git'], '/Library/Developer/CommandLineTools')), '/usr/bin/git');
  assert.equal(findGit(mac(['/Applications/Xcode.app/Contents/Developer/usr/bin/git'], '/Applications/Xcode.app/Contents/Developer')), '/usr/bin/git');
});

test("Homebrew's git is taken by its path: the app's PATH from the Finder does not hold it", () => {
  const probe = mac(['/opt/homebrew/bin/git']);
  assert.equal(findGit(probe), '/opt/homebrew/bin/git');
  assert.equal(probe.asked, 0, 'xcode-select is not asked');
  assert.equal(findGit(mac(['/usr/local/bin/git'])), '/usr/local/bin/git');
});

test('off a Mac, git on the PATH', () => {
  assert.equal(findGit({ platform: 'linux', executable: () => false, developerDir: () => undefined }), 'git');
});
