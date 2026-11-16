/**
 * The Freigabe-Datei (src/handover/package.ts) over the share service, protocol version 3
 * (docs/share-protocol.md): one file per share, per «Aktualisieren» and per return, uploaded in one
 * PUT and downloaded in one GET straight from the storage. The file is the same one «Teilen › Als
 * Datei» saves: the link and the file are one format with two transports.
 *
 * A hand-over carries the share it belongs to in its index (`share`: the service, the share's id,
 * the recipient's return token, the generation), so the file, double-clicked wherever it landed,
 * opens linked to its share. The service names the id and the token only once it was told the
 * file's exact size, so the index is kept at a fixed size (`indexRoom`) and filled in afterwards:
 * the file's size does not change by it.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { PACKAGE_EXT, type ShareTag } from '../handover/package.js';
import { replaceStoredMember } from '../handover/zip-file.js';
import type { ShareClient, ShareStatus, Target } from './client.js';
import { ShareServiceError } from './client.js';
import { SHARE_LIMITS } from './limits.js';

export type Phase = 'pack' | 'upload' | 'download';
export type Progress = (p: { phase: Phase; done: number; total: number }) => void;

/** Refused before the service is asked: the file is past one of the service's limits. */
export class ShareLimitError extends Error {
  /** `max`: the byte limit that was passed (a share's, or a return's, which is far smaller). */
  constructor(readonly limit: 'bytes', readonly value: number, readonly max: number = SHARE_LIMITS.bytes, readonly isReturn = false) {
    super(`${isReturn ? 'Die Rücksendung' : 'Die Freigabe-Datei'} ist ${Math.round(value / 1024 / 1024)} MB gross: der Dienst nimmt höchstens ${max >= 1024 ** 3 ? `${max / 1024 ** 3} GB` : `${Math.round(max / 1024 / 1024)} MB`} ${isReturn ? 'pro Rücksendung' : 'pro Link'}.`);
  }
}

/** A placeholder as long as the longest tag the service can name: the index keeps room for the real one. */
const PLACEHOLDER = (service: string): ShareTag => ({ service, id: 'a'.repeat(26), returnToken: 'x'.repeat(200), generation: 999_999 });
/** Spare bytes in index.json beside the placeholder. */
const SPARE = 64;

/**
 * Builds and uploads one file, packed once. A hand-over (`hand` given) is packed with a placeholder
 * tag in an index of fixed size (`indexRoom`, learnt from the placeholder's index text); once
 * `start` asked the service for the share (a new one, its next generation, or a return) with that
 * size, the share's own tag is written into that index in place (replaceStoredMember): same size,
 * no second packing. The file is in memory once.
 */
export async function sendPackage(opts: {
  client: ShareClient;
  /** A hand-over: its service, its index's text for a tag, and its file with the index kept at `room` bytes. A return carries no tag. */
  hand?: { service: string; index(tag: ShareTag): string; build(tag: ShareTag, room: number): Uint8Array };
  /** A return: its file. */
  build?(): Uint8Array;
  start(bytes: number): Promise<{ id: string; revokeToken: string; returnToken?: string; generation?: number }>;
  isReturn?: boolean;
  progress?: Progress;
}): Promise<{ id: string; revokeToken: string; returnToken?: string; generation: number; status: ShareStatus; bytes: Uint8Array }> {
  const { client, hand } = opts;
  opts.progress?.({ phase: 'pack', done: 0, total: 0 });
  const room = hand ? Buffer.byteLength(hand.index(PLACEHOLDER(hand.service))) + SPARE : 0;
  const file = hand ? hand.build(PLACEHOLDER(hand.service), room) : opts.build!();
  const size = file.byteLength;
  const max = opts.isReturn ? SHARE_LIMITS.returnBytes : SHARE_LIMITS.bytes;
  if (size > max) throw new ShareLimitError('bytes', size, max, !!opts.isReturn);

  const made = await opts.start(size);
  const generation = made.generation ?? 1;
  if (hand) {
    const text = Buffer.from(hand.index({ service: hand.service, id: made.id, ...(made.returnToken ? { returnToken: made.returnToken } : {}), generation }));
    if (text.length > room) throw new ShareServiceError(`Das Verzeichnis der Freigabe-Datei hat ${text.length} Bytes statt höchstens ${room}.`, 'internal', 500);
    const padded = Buffer.alloc(room, 0x20);
    text.copy(padded);
    replaceStoredMember(file, 'index.json', padded);
  }
  opts.progress?.({ phase: 'upload', done: 0, total: size });
  // An upload URL lives a few minutes; one retry with a fresh URL covers a dropped connection.
  for (let attempt = 1; ; attempt++) {
    const { target } = await client.upload(made.id, made.revokeToken);
    try {
      await client.put(target, file, (sent) => opts.progress?.({ phase: 'upload', done: sent, total: size }));
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
  const status = await client.complete(made.id, made.revokeToken);
  return { id: made.id, revokeToken: made.revokeToken, ...(made.returnToken ? { returnToken: made.returnToken } : {}), generation, status, bytes: file };
}

/** A download URL goes to the storage or the service itself, over https (http only on this computer, for the service's development server). */
function checkedTarget(target: Target): Target {
  let url: URL;
  try { url = new URL(target.url); } catch { throw new ShareServiceError('Die Download-Adresse ist unlesbar.', 'internal', 500); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new ShareServiceError(`Download-Adresse ohne https: ${url.origin}`, 'internal', 500);
  return target;
}

/** The download's own file name, as the service names it, made safe for a folder: no path, the share file's extension. */
export function safeFileName(name: string | undefined): string {
  // Bidirectional controls too: «Rechnung\u202Eexe.vanillashare» would show as another kind of file.
  const plain = basename((name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '')).trim().replace(/^\.+/, '');
  const stem = plain.slice(0, 180).replace(/\.(vanillashare|vanilla)$/i, '') || 'Buchhaltung';
  return `${stem}${PACKAGE_EXT}`;
}

/** «<name>.vanillashare», then «<name> 2.vanillashare», as Finder names them. */
const nth = (dir: string, name: string, n: number) => { const ext = extname(name), stem = name.slice(0, -ext.length); return join(dir, n === 1 ? name : `${stem} ${n}${ext}`); };

/**
 * The first free name in `dir`, taken at once: its `.part` is created exclusively, so two downloads
 * of the same share at the same time never write into one file (review of PR #559).
 */
function reserveName(dir: string, name: string): { path: string; part: string; fd: number } {
  for (let n = 1; ; n++) {
    const path = nth(dir, name, n);
    if (existsSync(path)) continue;
    try { return { path, part: `${path}.part`, fd: openSync(`${path}.part`, 'wx', 0o644) }; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Where a whole download goes: its reserved name, or the next free one if a file took that name meanwhile. */
function finalName(dir: string, name: string, path: string): string {
  if (!existsSync(path)) return path;
  for (let n = 2; ; n++) { const p = nth(dir, name, n); if (!existsSync(p) && !existsSync(`${p}.part`)) return p; }
}

/**
 * One opening (counted for the sharer's card), then the file, read with its progress and never past
 * the size the opening named (at most a share's 1 GB). `saveTo`: the folder the file is also saved
 * in, as a real file (written beside under `.part`, renamed when whole): the person's Downloads, so
 * the copy she works on has its Freigabe-Datei. `token`: the sharer's revoke token, which a return takes.
 */
export async function receivePackage(opts: { client: ShareClient; id: string; token?: string; progress?: Progress; saveTo?: string; isReturn?: boolean }): Promise<{ bytes: Uint8Array; filename: string; path?: string; generation: number; updatedAt?: string }> {
  const opened = await opts.client.open(opts.id, opts.token);
  const max = Math.min(opened.bytes, opts.isReturn ? SHARE_LIMITS.returnBytes : SHARE_LIMITS.bytes);
  if (opened.bytes > max) throw new ShareLimitError('bytes', opened.bytes, max, !!opts.isReturn);
  const filename = safeFileName(opened.filename);
  const bytes = new Uint8Array(opened.bytes);
  let at = 0;
  opts.progress?.({ phase: 'download', done: 0, total: opened.bytes });
  let path: string | undefined, part: string | undefined, fd: number | undefined;
  if (opts.saveTo) {
    mkdirSync(opts.saveTo, { recursive: true });
    ({ path, part, fd } = reserveName(opts.saveTo, filename));
  }
  try {
    const got = await opts.client.download(checkedTarget(opened.download), max, (chunk) => {
      bytes.set(chunk, at);
      at += chunk.byteLength;
      if (fd !== undefined) writeSync(fd, chunk);
      opts.progress?.({ phase: 'download', done: at, total: opened.bytes });
    });
    if (got !== opened.bytes) throw new ShareServiceError(`Der Download brach nach ${got} von ${opened.bytes} Bytes ab.`, 'downloadCut', 502);
    if (fd !== undefined) { fsyncSync(fd); closeSync(fd); fd = undefined; path = finalName(opts.saveTo!, filename, path!); renameSync(part!, path); }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (part) rmSync(part, { force: true });
    throw e;
  }
  return { bytes, filename, ...(path ? { path } : {}), generation: opened.generation ?? 1, ...(opened.updatedAt ? { updatedAt: opened.updatedAt } : {}) };
}
