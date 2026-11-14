/**
 * data/quarantine/: files that came in (by a drop or from a mailbox source) and are no receipt by
 * their words, that a person set aside in the drop dialog, or that no PDF reader opens (r8k-9). They never enter the books; each
 * keeps its reason beside it (`<file>.reason.txt`), so Belege can say why it is there, and a
 * person can take it back into the inbox («Ist ein Beleg»). Belege shows them as «Aussortiert».
 * What a mailbox source set aside (by its words, a group the person set aside, a duplicate of a
 * receipt) is deleted by itself ASIDE_DAYS after it came; anything else stays until a person decides.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { OtherWhy } from '../core/modules/schema.js';
import type { QuarantinedFile, QuarantineReason } from '../types/drop.js';

const REASON = '.reason.txt';
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
 * The reason as written beside the file: `not-receipt <why>[ from <sender>][ source <id>]`,
 * `not-receipt group <shape> from <sender> source <id>`, `duplicate <receipt id> <file> …`,
 * `unreadable` or `held`. Lines written before `source` and `group` existed read as before.
 */
export function parseReason(line: string): QuarantineReason {
  const [head, ...rest] = line.trim().split(/\s+/);
  if (head === 'unreadable') return { kind: 'unreadable' };
  if (head !== 'not-receipt' && head !== 'duplicate') return { kind: 'held' };
  const named: Record<string, string> = {};
  const free: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if ((rest[i] === 'from' || rest[i] === 'source') && rest[i + 1] !== undefined) named[rest[i]] = rest[++i];
    else free.push(rest[i]);
  }
  const tail = { ...(named.from ? { from: named.from } : {}), ...(named.source ? { source: named.source } : {}) };
  if (head === 'duplicate') return { kind: 'duplicate', of: free[0] ?? '', ...(free[1] ? { ofFile: dec(free[1]) } : {}), ...tail };
  if (free[0] === 'group' && free[1]) return { kind: 'not-receipt', why: 'group', shape: dec(free[1]), ...tail };
  const why = OTHER.find((w) => w === free[0]);
  return { kind: 'not-receipt', ...(why ? { why } : {}), ...tail };
}

export function formatReason(r: QuarantineReason): string {
  if (r.kind === 'held' || r.kind === 'unreadable') return r.kind;
  const tail = `${r.from ? ` from ${r.from.replace(/\s/g, '')}` : ''}${r.source ? ` source ${r.source}` : ''}`;
  if (r.kind === 'duplicate') return `duplicate ${r.of}${r.ofFile ? ` ${enc(r.ofFile)}` : ''}${tail}`;
  if (r.why === 'group') return `not-receipt group ${enc(r.shape ?? '')}${tail}`;
  return `not-receipt${r.why ? ` ${r.why}` : ''}${tail}`;
}

/** The day a file set aside at `at` is deleted by itself: only what a mailbox source set aside; a drop's and a person's are kept until a person decides. */
export function deleteOn(reason: QuarantineReason, at: string): string | undefined {
  if (reason.kind !== 'not-receipt' && reason.kind !== 'duplicate') return undefined;
  if (!reason.source) return undefined;
  return new Date(Date.parse(at) + ASIDE_DAYS * 86_400_000).toISOString().slice(0, 10);
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
    .filter((f) => !f.endsWith(REASON) && !f.startsWith('.'))
    .map((file) => {
      const reason = reasonOf(data, file) ?? { kind: 'held' as const };
      const at = statSync(join(dir, file)).mtime.toISOString();
      const until = deleteOn(reason, at);
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
 * Deletes what a mailbox source set aside and nobody took back within ASIDE_DAYS (its `deleteOn`
 * passed). A drop's file, one a person set aside and an unreadable one stay. Returns the names deleted.
 */
export function sweepQuarantine(data: string, now: Date = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const gone = quarantined(data).filter((q) => q.deleteOn && q.deleteOn <= today).map((q) => q.file);
  for (const f of gone) release(data, f);
  return gone;
}

/** The path of a quarantined file, or undefined for a name that is none (never outside the folder). */
export function quarantinePath(data: string, file: string): string | undefined {
  if (file !== basename(file) || file.endsWith(REASON) || file.startsWith('.')) return undefined;
  const path = join(dirOf(data), file);
  return existsSync(path) ? path : undefined;
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
