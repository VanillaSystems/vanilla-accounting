/**
 * data/quarantine/: files that came in (by a drop or from a mailbox source) and are no receipt by
 * their words, that a person set aside in the drop dialog, or that no PDF reader opens (r8k-9). They never enter the books; each
 * keeps its reason beside it (`<file>.reason.txt`), so Belege can say why it is there, and a
 * person can take it back into the inbox («Doch behalten»). Belege shows them as «Aussortiert».
 * What a mailbox source set aside (by its words, a group the person keeps aside, a duplicate of a
 * receipt) is deleted ASIDE_DAYS after it was set aside, by the mailbox's next live pull
 * (src/platform/sources/host.ts); anything else, and what a person kept, stays until a person decides.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { OtherWhy } from '../core/modules/schema.js';
import type { QuarantinedFile, QuarantineReason } from '../types/drop.js';

const REASON = '.reason.txt';
const TMP = '.tmp';
const dirOf = (data: string) => join(data, 'quarantine');

/** A free name in `folder` for `name` (no path, no control characters): the same stem with -2, -3 … when taken. */
export function freeName(folder: string, name: string): string {
  const clean = name.replace(/[/\\\u0000-\u001f]/g, '_').slice(-120) || 'document.pdf';
  const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
  let out = clean;
  for (let n = 2; existsSync(join(folder, out)); n++) out = `${stem}-${n}${ext}`;
  return out;
}

const OTHER: readonly OtherWhy[] = ['newsletter', 'terms', 'price-list', 'tracking', 'no-receipt'];

/** Days what a mailbox source set aside stays before it is deleted by itself. */
export const ASIDE_DAYS = 30;

/** A token of the reason line: no spaces, so a file name is written encoded. */
const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * The reason as written beside the file: `not-receipt <why>[ from <sender>][ source <id>][ at <iso>]`,
 * `not-receipt group <shape> from <sender> source <id> at <iso>[ kept]`, `duplicate <receipt id> <file> …`,
 * `unreadable` or `held`. `at`: when it was set aside, recorded (a file's time on disk changes with
 * a copy). Lines written before `source`, `group` and `at` existed read as before.
 */
export function parseReason(line: string): QuarantineReason {
  const [head, ...rest] = line.trim().split(/\s+/);
  if (head === 'unreadable') return { kind: 'unreadable' };
  if (head !== 'not-receipt' && head !== 'duplicate') return { kind: 'held' };
  const named: Record<string, string> = {};
  const free: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if ((rest[i] === 'from' || rest[i] === 'source' || rest[i] === 'at') && rest[i + 1] !== undefined) named[rest[i]] = rest[++i];
    else if (rest[i] === 'kept') named.kept = 'yes';
    else free.push(rest[i]);
  }
  const at = named.at && !Number.isNaN(Date.parse(named.at)) ? named.at : undefined;
  const tail = { ...(named.from ? { from: named.from } : {}), ...(named.source ? { source: named.source } : {}), ...(at ? { at } : {}), ...(named.kept ? { kept: true as const } : {}) };
  if (head === 'duplicate') return { kind: 'duplicate', of: free[0] ?? '', ...(free[1] ? { ofFile: dec(free[1]) } : {}), ...tail };
  if (free[0] === 'group' && free[1]) return { kind: 'not-receipt', why: 'group', shape: dec(free[1]), ...tail };
  const why = OTHER.find((w) => w === free[0]);
  return { kind: 'not-receipt', ...(why ? { why } : {}), ...tail };
}

export function formatReason(r: QuarantineReason): string {
  if (r.kind === 'held' || r.kind === 'unreadable') return r.kind;
  const tail = `${r.from ? ` from ${r.from.replace(/\s/g, '')}` : ''}${r.source ? ` source ${r.source}` : ''}${r.at ? ` at ${r.at}` : ''}${r.kept ? ' kept' : ''}`;
  if (r.kind === 'duplicate') return `duplicate ${r.of}${r.ofFile ? ` ${enc(r.ofFile)}` : ''}${tail}`;
  if (r.why === 'group') return `not-receipt group ${enc(r.shape ?? '')}${tail}`;
  return `not-receipt${r.why ? ` ${r.why}` : ''}${tail}`;
}

/**
 * The day a file set aside is deleted by itself: only what a mailbox source set aside, counted from
 * when it was set aside as recorded in its reason. A drop's, a person's, one a person kept, and one
 * without a recorded time are kept until a person decides.
 */
export function deleteOn(reason: QuarantineReason): string | undefined {
  if (reason.kind !== 'not-receipt' && reason.kind !== 'duplicate') return undefined;
  if (!reason.source || !reason.at || reason.kept) return undefined;
  return new Date(Date.parse(reason.at) + ASIDE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** Puts `bytes` into quarantine under a free name for `name`; returns that name. */
export function putInQuarantine(data: string, name: string, bytes: Buffer, reason: QuarantineReason): string {
  const dir = dirOf(data);
  mkdirSync(dir, { recursive: true });
  const file = freeName(dir, name);
  writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, file + REASON), `${formatReason(reason)}\n`);
  return file;
}

/** Every file in quarantine with its reason, newest first. */
export function quarantined(data: string): QuarantinedFile[] {
  const dir = dirOf(data);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.endsWith(REASON) && !f.startsWith('.') && !f.endsWith(TMP))
    .map((file) => {
      const reason = reasonOf(data, file) ?? { kind: 'held' as const };
      const at = ('at' in reason && reason.at) || statSync(join(dir, file)).mtime.toISOString();
      const until = deleteOn(reason);
      return { file, reason, at, ...(until ? { deleteOn: until } : {}) };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.file.localeCompare(b.file));
}

/** The reason beside a quarantined file, or undefined for a file that is not there. */
export function reasonOf(data: string, file: string): QuarantineReason | undefined {
  const path = quarantinePath(data, file);
  if (!path) return undefined;
  return parseReason(existsSync(path + REASON) ? readFileSync(path + REASON, 'utf8') : '');
}

/**
 * A person keeps these files: their reasons are marked `kept`, so they are never deleted by
 * themselves (a group switched off: its other files stay until a person decides). The source that
 * set them aside stays named, so «Doch behalten» on one of them can still switch its group off.
 */
export function keepQuarantined(data: string, files: readonly string[]): void {
  for (const f of files) {
    const r = reasonOf(data, f);
    if (!r || (r.kind !== 'not-receipt' && r.kind !== 'duplicate') || r.kept) continue;
    const kept: QuarantineReason = { ...r, kept: true };
    const path = quarantinePath(data, f)! + REASON;
    writeFileSync(path + TMP, `${formatReason(kept)}\n`);
    renameSync(path + TMP, path);
  }
}

/** The last sweep that deleted something: the day and how many, for «Aussortiert» to say. */
export interface Swept { on: string; n: number }
const SWEPT = '.swept.json';

export function lastSwept(data: string): Swept | undefined {
  try { return JSON.parse(readFileSync(join(dirOf(data), SWEPT), 'utf8')) as Swept; } catch { return undefined; }
}

/**
 * Deletes what a mailbox source set aside and nobody kept within ASIDE_DAYS of when it was set
 * aside (as recorded). A recorded time in the future deletes nothing (a clock set wrong). A drop's
 * file, one a person set aside or kept, and an unreadable one stay. Returns what it deleted, and
 * records the day and the count for the person to read.
 */
export function sweepQuarantine(data: string, now: Date = new Date()): QuarantinedFile[] {
  const today = now.toISOString().slice(0, 10);
  const gone = quarantined(data).filter((q) => q.deleteOn && q.deleteOn <= today && Date.parse(q.at) <= now.getTime());
  for (const q of gone) release(data, q.file);
  if (gone.length) {
    const before = lastSwept(data);
    const n = before?.on === today ? before.n + gone.length : gone.length;
    writeFileSync(join(dirOf(data), SWEPT), JSON.stringify({ on: today, n } satisfies Swept) + '\n');
  }
  return gone;
}

/** The path of a quarantined file, or undefined for a name that is none (never outside the folder). */
export function quarantinePath(data: string, file: string): string | undefined {
  if (file !== basename(file) || file.endsWith(REASON) || file.startsWith('.')) return undefined;
  const path = join(dirOf(data), file);
  return existsSync(path) ? path : undefined;
}

/** A quarantined file's bytes, leaving it where it is. */
export function bytesOf(data: string, file: string): Buffer | undefined {
  const path = quarantinePath(data, file);
  return path ? readFileSync(path) : undefined;
}

/** Takes a file out of quarantine: its bytes, and it and its reason are gone. */
export function release(data: string, file: string): Buffer | undefined {
  const path = quarantinePath(data, file);
  if (!path) return undefined;
  const bytes = readFileSync(path);
  rmSync(path, { force: true });
  rmSync(path + REASON, { force: true });
  return bytes;
}
