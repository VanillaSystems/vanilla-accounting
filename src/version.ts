/**
 * Which build of the app this is, derived from package.json and `git describe`, never kept by
 * hand. Semantic Versioning: `-rc.N` is a pre-release, `+…` build metadata.
 *
 *   0.4.0-rc.56+g36b66d6   package.json says 0.4.0, the last tag is older: 56 commits towards it
 *   0.4.0-rc.1.3+g1a2b3c4  the last tag is a pre-release of this version (v0.4.0-rc.1), 3 commits after it
 *   0.3.0+56.g36b66d6      package.json still says the released 0.3.0: 56 commits past its tag
 *   0.3.0                  the tagged release itself, clean
 *   ….dirty                uncommitted changes in the tree
 *
 * The count climbs with every commit and resets at every tag; the sha tells two branches at the
 * same count apart. The packed Mac app has no git: tools/desktop/build.mjs bakes the string in as
 * VANILLA_BUILD. Imports only node: modules, so the build scripts load it with plain node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Build {
  /** Shown to people and written into commits. */
  version: string;
  /** For file names, which cannot hold `+`: 0.4.0-rc.56-g36b66d6. */
  file: string;
  /** Commits on the line: always climbs, the bundle version macOS compares. */
  number: number;
}

const LONG = /^(.*)-(\d+)-g([0-9a-f]+)(-dirty)?$/;
const BARE = /^([0-9a-f]+)(-dirty)?$/;

/** Pure: the build string from the version package.json names and what `git describe --tags --long --dirty --always` says. */
export function versionFrom(planned: string, describe: string | undefined): string {
  const long = describe ? LONG.exec(describe) : null;
  const bare = long || !describe ? null : BARE.exec(describe);
  if (!long && !bare) return planned;
  const commit = long ? long[3] : bare![1];
  const dirty = !!(long ? long[4] : bare![2]);
  const meta = `g${commit}${dirty ? '.dirty' : ''}`;
  if (!long) return `${planned}+${meta}`;
  const tag = long[1].replace(/^v/, '');
  const n = Number(long[2]);
  // The version is released: commits past its tag are metadata, not a new pre-release.
  if (tag === planned) return n === 0 && !dirty ? planned : `${planned}+${n}.${meta}`;
  // A pre-release tag of this version: count on from it.
  if (tag.startsWith(`${planned}-`)) return `${n === 0 ? tag : `${tag}.${n}`}+${meta}`;
  return `${planned}-rc.${n}+${meta}`;
}

const git = (root: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
};

export function describeBuild(root: string): Build {
  const planned = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const checkout = existsSync(join(root, '.git'));
  const version = versionFrom(planned, checkout ? git(root, 'describe', '--tags', '--long', '--dirty', '--always') : undefined);
  return { version, file: version.replace(/\+/g, '-'), number: Number((checkout && git(root, 'rev-list', '--count', 'HEAD')) || 0) };
}

let described: string | undefined;

/** This process's build. */
export function appVersion(): string {
  return process.env.VANILLA_BUILD ?? (described ??= describeBuild(fileURLToPath(new URL('..', import.meta.url))).version);
}
