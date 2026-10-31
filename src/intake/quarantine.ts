/**
 * data/quarantine/: files that came in (by a drop or from a mailbox source) and are no receipt by
 * their words, that a person set aside in the drop dialog, or that no PDF reader opens (r8k-9). They never enter the books; each
 * keeps its reason beside it (`<file>.reason.txt`), so Belege can say why it is there, and a
 * person can take it back into the inbox («Ist ein Beleg»).
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

/** `not-receipt <why>[ from <sender>]`, `unreadable` or `held`, as written beside the file. */
export function parseReason(line: string): QuarantineReason {
  if (/^unreadable\b/.test(line.trim())) return { kind: 'unreadable' };
  const m = /^not-receipt(?:\s+(\S+))?(?:\s+from\s+(\S+))?/.exec(line.trim());
  if (!m) return { kind: 'held' };
  const why = OTHER.find((w) => w === m[1]);
  return { kind: 'not-receipt', ...(why ? { why } : {}), ...(m[2] ? { from: m[2] } : {}) };
}

const formatReason = (r: QuarantineReason) => r.kind === 'held' || r.kind === 'unreadable' ? r.kind : `not-receipt${r.why ? ` ${r.why}` : ''}${r.from ? ` from ${r.from}` : ''}`;

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
      const reasonFile = join(dir, file + REASON);
      return { file, reason: parseReason(existsSync(reasonFile) ? readFileSync(reasonFile, 'utf8') : ''), at: statSync(join(dir, file)).mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.file.localeCompare(b.file));
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
