import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changelogSection, releaseNotes } from '../tools/release/notes.js';

const changelog = `# Changelog

## [Unreleased]

- Not yet.

## [0.3.0] - 2026-10-11

### Added

- The Mac app.

## [0.2.0] - 2026-10-01

- Older.
`;

const assets = [
  { name: 'Vanilla Accounting-0.3.0-arm64.dmg', sha256: 'a'.repeat(64) },
  { name: 'Vanilla Accounting-0.3.0-x64.dmg', sha256: 'b'.repeat(64) },
  { name: 'latest-mac.yml', sha256: 'c'.repeat(64) },
];

test('the release text is the version section only, not Unreleased or an older one', () => {
  assert.equal(changelogSection(changelog, '0.3.0'), '### Added\n\n- The Mac app.');
  assert.throws(() => changelogSection(changelog, '0.4.0'), /no section "## \[0.4.0\]"/);
});

test('the release lists each dmg with its Mac and SHA-256, and says how to open an unsigned app', () => {
  const unsigned = releaseNotes({ changelog, version: '0.3.0', assets, signed: false });
  assert.match(unsigned, /\| Vanilla Accounting-0\.3\.0-arm64\.dmg \| Apple silicon \(M1 and later\) \| `a{64}` \|/);
  assert.match(unsigned, /\| Vanilla Accounting-0\.3\.0-x64\.dmg \| Intel \| `b{64}` \|/);
  assert.doesNotMatch(unsigned, /latest-mac\.yml/);
  assert.match(unsigned, /Privacy & Security and click \*\*Open Anyway\*\*/);
  assert.doesNotMatch(releaseNotes({ changelog, version: '0.3.0', assets, signed: true }), /Open Anyway/);
});
