/**
 * The content version (docs/specs/e2e-and-fiduciary.md B7): a plain counter of the states of the
 * books a person can name («Version 12 · 14.11.2026»), kept in versions.jsonl at the workspace's
 * top. Appended only; its first line is the header `{"schema":1}`. A version is written when the
 * books are handed over, when a return is taken over and when a quarter is sealed; never on a plain
 * save. Books without the file are at no version yet; the first event writes Version 1. The seals
 * do not hash this file, so a new line never touches a filed quarter, and the books' schema is
 * unchanged by it (the owner's OK of 2026-11-14).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from '../workspace/workspace.js';
import { contentChecksum } from './content.js';

export const VERSIONS_FILE = 'versions.jsonl';
export const VERSIONS_SCHEMA = 1;

export type VersionReason = 'handover' | 'return-applied' | 'return-undone' | 'sealed';

/** Who a version was handed to or came from: a name always, an e-mail when the person gave one. */
export interface Party { name: string; email?: string }

export interface Version {
  n: number;
  /** ISO time. */
  at: string;
  reason: VersionReason;
  /** `sha256:<hex>` over the content files (src/handover/content.ts checksumOf). */
  checksum: string;
  /** A milestone's name, when a person gave one. */
  label?: string;
  /** A sealed version's filing period («Version 15 · Q3 2026 eingereicht»: the UI says it in the viewer's language). */
  period?: string;
  /** A hand-over's recipient; the version that recipient now holds. */
  to?: Party;
  /** A return's sender. */
  from?: Party;
  /** A return's base version. */
  basedOn?: number;
  /** A return taken over: how many changes were taken and how many left. */
  taken?: number;
  left?: number;
  /** The return's id in handover/ (src/handover/returns.ts). */
  ret?: string;
}

const fileOf = (paths: Pick<WorkspacePaths, 'root'>) => join(paths.root, VERSIONS_FILE);

/** Every version, oldest first; none for books without the log. A line that does not read is skipped with a note. */
export function readVersions(paths: Pick<WorkspacePaths, 'root'>): Version[] {
  const file = fileOf(paths);
  if (!existsSync(file)) return [];
  const out: Version[] = [];
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<Version> & { schema?: number };
      if (i === 0 && v.schema !== undefined) {
        if (v.schema > VERSIONS_SCHEMA) throw new Error(`${file}: schema ${v.schema} is newer than this app reads (${VERSIONS_SCHEMA}).`);
        continue;
      }
      if (typeof v.n === 'number' && typeof v.at === 'string' && typeof v.checksum === 'string' && typeof v.reason === 'string') out.push(v as Version);
    } catch (e) {
      if ((e as Error).message.includes('newer than')) throw e;
      console.warn(`${file}:${i + 1}: not a version line, skipped.`);
    }
  }
  return out;
}

/** The newest version; undefined while the books have none. */
export const currentVersion = (paths: Pick<WorkspacePaths, 'root'>): Version | undefined => readVersions(paths).at(-1);

/** Appends the next version for the content as it is now, and returns it. */
export function writeVersion(paths: Pick<WorkspacePaths, 'root'>, v: Omit<Version, 'n' | 'at' | 'checksum'> & { at?: string; checksum?: string }): Version {
  const file = fileOf(paths);
  // The next number is past every version read and every line written: a line that no longer reads never gives its number twice.
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('{"schema"')).length;
  const n = Math.max(lines, ...readVersions(paths).map((x) => x.n), 0) + 1;
  const line: Version = { n, at: v.at ?? new Date().toISOString(), ...v, checksum: v.checksum ?? contentChecksum(paths).checksum };
  if (!existsSync(file)) writeFileSync(file, `${JSON.stringify({ schema: VERSIONS_SCHEMA })}\n`);
  else if (text && !text.endsWith('\n')) appendFileSync(file, '\n');
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}

/** The newest version `email` (or, without one, `name`) holds: the newest handed to them or that their return was based on. */
export function heldBy(paths: Pick<WorkspacePaths, 'root'>, who: Party): Version | undefined {
  const same = (p: Party | undefined) => !!p && (who.email && p.email ? p.email.toLowerCase() === who.email.toLowerCase() : p.name === who.name);
  const all = readVersions(paths);
  let held: Version | undefined;
  for (const v of all) {
    const got = v.reason === 'handover' && same(v.to) ? v : v.reason === 'return-applied' && same(v.from) && v.basedOn ? all.find((x) => x.n === v.basedOn) : undefined;
    if (got && (!held || got.n > held.n)) held = got;
  }
  return held;
}

/**
 * A quarter sealed by the app's own steps (the filing, `npm run seal`, the year close) is a named
 * version: «Version 15 · Q3 2026 eingereicht». Never fails the seal: a version that cannot be
 * written is said in the log.
 */
export function sealedVersion(ws: { paths: Pick<WorkspacePaths, 'root'> }, period: string): Version | undefined {
  try {
    return writeVersion(ws.paths, { reason: 'sealed', period });
  } catch (e) {
    console.warn(`${VERSIONS_FILE}: the version of ${period} was not written (${(e as Error).message}).`);
    return undefined;
  }
}
