/** The text of a GitHub release: the version's changelog section, the downloads with their SHA-256, and how to open an unsigned app. */
export interface Asset { name: string; sha256: string }

export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section "## [${version}]"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

export function releaseNotes({ changelog, version, assets, signed }: { changelog: string; version: string; assets: Asset[]; signed: boolean }): string {
  const downloads = assets
    .filter((a) => a.name.endsWith('.dmg'))
    .map((a) => `| ${a.name} | ${a.name.includes('arm64') ? 'Apple silicon (M1 and later)' : 'Intel'} | \`${a.sha256}\` |`);
  const parts = [
    changelogSection(changelog, version),
    '## Download',
    ['| File | Mac | SHA-256 |', '|---|---|---|', ...downloads].join('\n'),
  ];
  if (!signed) {
    parts.push('This build is not signed with an Apple Developer ID. The first time, open the app in Applications with right-click → **Open**, then **Open** again.');
  }
  return parts.join('\n\n') + '\n';
}
