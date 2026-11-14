/**
 * The text of a GitHub release: what the app is, the downloads (each a link to its asset, with its
 * SHA-256, and how to open an unsigned app), the version's highlights, and its full changelog section
 * folded away at the end.
 */
export interface Asset { name: string; sha256: string }

/** GitHub's limit on a release body. */
export const BODY_LIMIT = 125_000;

const TAGLINE = '**Free bookkeeping for small Swiss firms: bank statements, receipts, AI booking and the VAT return for the ESTV.**';
const UNSIGNED = 'This build is not signed with an Apple Developer ID, so macOS refuses it the first time. Open it once and click **Done**, then go to System Settings › Privacy & Security and click **Open Anyway** next to "Vanilla Accounting was blocked".';
const MAX_HIGHLIGHTS = 6;

export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section "## [${version}]"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** The section's `### <name>` subsections, by name, each without its heading. */
function subsections(section: string): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  const close = () => { if (name !== null) found.set(name, body.join('\n').trim()); };
  for (const line of section.split('\n')) {
    const heading = line.match(/^### (.+?)\s*$/);
    if (heading) { close(); name = heading[1]; body = []; } else body.push(line);
  }
  close();
  return found;
}

/** The section without its `### Highlights` subsection, which the release shows on its own. */
function withoutHighlights(section: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of section.split('\n')) {
    if (/^### /.test(line)) skipping = /^### Highlights\s*$/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n').trim();
}

/** The `- ` entries of a list, each joined onto one line. */
function entries(list: string): string[] {
  const found: string[] = [];
  for (const line of list.split('\n')) {
    if (line.startsWith('- ')) found.push(line.slice(2).trim());
    else if (found.length && line.trim()) found[found.length - 1] += ` ${line.trim()}`;
  }
  return found;
}

/** An entry's title: its first sentence, up to the colon when it has one. */
function title(entry: string): string {
  const sentence = entry.split(/(?<=\.)\s/)[0];
  const colon = sentence.indexOf(':');
  return (colon < 0 ? sentence : sentence.slice(0, colon)).replace(/\.$/, '').trim();
}

/** What the release author wrote under `### Highlights`, else the titles of Added and Changed, at most six. */
export function highlights(section: string): string[] {
  const parts = subsections(section);
  const written = parts.get('Highlights');
  if (written) return entries(written).map((e) => `- ${e}`);
  return ['Added', 'Changed']
    .flatMap((name) => entries(parts.get(name) ?? '').map(title))
    .filter(Boolean)
    .slice(0, MAX_HIGHLIGHTS)
    .map((t) => `- ${t}`);
}

/** The URL GitHub serves an asset at: it stores the name with each space replaced by a dot. */
export function assetUrl(repo: string, version: string, name: string): string {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name.replace(/ /g, '.'))}`;
}

export function releaseNotes({ changelog, version, assets, signed, repo }: { changelog: string; version: string; assets: Asset[]; signed: boolean; repo: string }): string {
  const section = changelogSection(changelog, version);
  const downloads = assets
    .filter((a) => a.name.endsWith('.dmg'))
    .map((a) => `| [${a.name}](${assetUrl(repo, version, a.name)}) | ${a.name.includes('arm64') ? 'Apple silicon (M1 and later)' : 'Intel'} | \`${a.sha256}\` |`);
  const head = [
    TAGLINE,
    '## Download',
    ['| File | Mac | SHA-256 |', '|---|---|---|', ...downloads].join('\n'),
    ...(signed ? [] : [UNSIGNED]),
  ];
  const listed = highlights(section);
  if (listed.length) head.push(`## What's new in ${version}`, listed.join('\n'));

  const full = [...head, `<details>\n<summary>Full changelog</summary>\n\n${withoutHighlights(section)}\n\n</details>`].join('\n\n') + '\n';
  if (full.length <= BODY_LIMIT) return full;
  return [...head, `The full changelog of ${version}: [CHANGELOG.md](https://github.com/${repo}/blob/v${version}/CHANGELOG.md).`].join('\n\n') + '\n';
}
