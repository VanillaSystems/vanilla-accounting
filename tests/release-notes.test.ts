import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_LIMIT, changelogSection, highlights, releaseNotes } from '../tools/release/notes.js';

const changelog = `# Changelog

## [Unreleased]

- Not yet.

## [0.3.0] - 2026-10-11

### Added

- The Mac app: it opens the books
  of a workspace. And more.
- Card lines (#409), **⚠ figures**: read by code.

### Changed

- Setup asks less. It keeps the answers.

### Fixed

- A crash: gone.

## [0.2.0] - 2026-10-01

- Older.
`;

const repo = 'Owner/app';
const assets = [
  { name: 'Vanilla Accounting-0.3.0-arm64.dmg', sha256: 'a'.repeat(64) },
  { name: 'Vanilla Accounting-0.3.0-x64.dmg', sha256: 'b'.repeat(64) },
  { name: 'latest-mac.yml', sha256: 'c'.repeat(64) },
];
const notes = (over: Partial<Parameters<typeof releaseNotes>[0]> = {}) => releaseNotes({ changelog, version: '0.3.0', assets, signed: false, repo, ...over });

test('the release text is the version section only, not Unreleased or an older one', () => {
  assert.match(changelogSection(changelog, '0.3.0'), /^### Added\n\n- The Mac app/);
  assert.doesNotMatch(changelogSection(changelog, '0.3.0'), /Not yet|Older/);
  assert.throws(() => changelogSection(changelog, '0.4.0'), /no section "## \[0.4.0\]"/);
});

test('the release opens with what the app is, then the downloads, what is new, and the full changelog folded away', () => {
  const text = notes();
  assert.match(text, /^\*\*Free bookkeeping for small Swiss firms[^\n]*\*\*\n\n## Download\n/);
  const order = ['## Download', 'Open Anyway', "## What's new in 0.3.0", '<details>\n<summary>Full changelog</summary>', '### Fixed', '</details>'].map((s) => text.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `order: ${order}`);
});

test('each dmg links to its asset as GitHub names it, with its Mac and SHA-256; an unsigned build says how to open it', () => {
  const text = notes();
  assert.match(text, /\| \[Vanilla Accounting-0\.3\.0-arm64\.dmg\]\(https:\/\/github\.com\/Owner\/app\/releases\/download\/v0\.3\.0\/Vanilla\.Accounting-0\.3\.0-arm64\.dmg\) \| Apple silicon \(M1 and later\) \| `a{64}` \|/);
  assert.match(text, /\| \[Vanilla Accounting-0\.3\.0-x64\.dmg\]\(https:\/\/github\.com\/Owner\/app\/releases\/download\/v0\.3\.0\/Vanilla\.Accounting-0\.3\.0-x64\.dmg\) \| Intel \| `b{64}` \|/);
  assert.doesNotMatch(text, /latest-mac\.yml/);
  assert.match(text, /Privacy & Security and click \*\*Open Anyway\*\*/);
  assert.doesNotMatch(notes({ signed: true }), /Open Anyway/);
});

test('without a Highlights subsection the titles of Added and Changed are the highlights, at most six', () => {
  assert.deepEqual(highlights(changelogSection(changelog, '0.3.0')), [
    '- The Mac app',
    '- Card lines (#409), **⚠ figures**',
    '- Setup asks less',
  ]);
  const many = `### Added\n\n${Array.from({ length: 9 }, (_, i) => `- Entry ${i}: text.`).join('\n')}`;
  assert.equal(highlights(many).length, 6);
});

test('a Highlights subsection the author wrote is the list, and it is not repeated in the full changelog', () => {
  const written = changelog.replace('## [0.3.0] - 2026-10-11\n', '## [0.3.0] - 2026-10-11\n\n### Highlights\n\n- **A Mac app** you can install.\n- **Fewer questions.**\n');
  const text = notes({ changelog: written });
  assert.match(text, /## What's new in 0\.3\.0\n\n- \*\*A Mac app\*\* you can install\.\n- \*\*Fewer questions\.\*\*\n\n<details>/);
  assert.equal(text.match(/A Mac app\*\* you can install/g)?.length, 1);
  assert.doesNotMatch(text, /### Highlights/);
  assert.doesNotMatch(text, /- The Mac app\n- Card lines/);
});

test('a changelog too long for GitHub is linked at the tag instead of embedded', () => {
  const long = changelog.replace('- A crash: gone.', `- A crash: ${'x'.repeat(BODY_LIMIT)}`);
  const text = notes({ changelog: long });
  assert.ok(text.length <= BODY_LIMIT, `${text.length}`);
  assert.doesNotMatch(text, /<details>/);
  assert.match(text, /\(https:\/\/github\.com\/Owner\/app\/blob\/v0\.3\.0\/CHANGELOG\.md\)/);
  assert.match(text, /## What's new in 0\.3\.0/);
});
