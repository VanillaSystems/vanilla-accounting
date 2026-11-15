/**
 * The hand-over package (src/handover/package.ts) over the share service: every file of the package
 * sealed on its own under the share's key, the encrypted index naming them (docs/share-protocol.md
 * §3). The share's index carries the package's own index whole (`package`), a return's change set
 * is its file `changes.json`, and the recipient's return token rides in the index (§5).
 *
 * The receiving side decrypts every file, checks it against the share's index, and hands the
 * package to the same checks a `.vanilla` file passes (paths, sizes, every file's SHA-256, the
 * version's checksum). The link and the file are one format with two transports.
 */
import { checkPackage, LIMITS, PackageError, type PackageContents, type PackageIndex, type ReturnChange } from '../handover/package.js';
import type { ShareClient, ShareStatus, Target } from './client.js';
import { ShareServiceError } from './client.js';
import {
  decodeKey, decryptFile, decryptIndex, encryptedSize, encryptFile, encrypt, INDEX_OBJECT, newObjectId, sha256Hex,
  ShareCryptoError, type IndexFile, type ShareIndex,
} from './crypto/index.js';
import { SHARE_LIMITS } from './service.js';

/** The share's index: the protocol's fields, the package's own index, and for a hand-over the recipient's return token. */
export interface PackageShareIndex extends ShareIndex {
  package: PackageIndex;
  returnToken?: string;
}

/** The package as it goes out: its index and its files by path, and a return's change set. */
export interface Outgoing { index: PackageIndex; files: ReadonlyMap<string, Uint8Array>; changes?: ReturnChange[] }

/** A return's change set travels as this file of the share. */
export const CHANGES_FILE = 'changes.json';
/** Room kept in the index for what the service names only once the share exists: the return token. */
const TOKEN_ROOM = 1024;
const BATCH = 100;

export type Phase = 'encrypt' | 'upload' | 'download' | 'decrypt';
export type Progress = (p: { phase: Phase; done: number; total: number }) => void;

/** Refused before the service is asked: the package is past one of the service's limits. */
export class ShareLimitError extends Error {
  /** `max`: the byte limit that was passed (a share's, or a return's, which is far smaller). */
  constructor(readonly limit: 'bytes' | 'objects', readonly value: number, readonly max: number = limit === 'bytes' ? SHARE_LIMITS.bytes : SHARE_LIMITS.objects, readonly isReturn = false) {
    super(limit === 'bytes'
      ? `${isReturn ? 'Die Rücksendung' : 'Die Übergabe'} ist verschlüsselt ${Math.round(value / 1024 / 1024)} MB gross: der Dienst nimmt höchstens ${max >= 1024 ** 3 ? `${max / 1024 ** 3} GB` : `${Math.round(max / 1024 / 1024)} MB`} ${isReturn ? 'pro Rücksendung' : 'pro Link'}.`
      : `Die Übergabe hat ${value} Dateien: der Dienst nimmt höchstens ${SHARE_LIMITS.objects} pro Link.`);
  }
}

interface Planned { path: string; object: string; data: Uint8Array; entry: IndexFile }

const indexBlobSize = (text: Uint8Array) => encryptedSize(text.length);
const enc = new TextEncoder();

/** The index's text, padded with spaces to `size` bytes (JSON reads past them). */
function indexText(index: PackageShareIndex, size?: number): Uint8Array {
  const text = enc.encode(JSON.stringify(index));
  if (size === undefined) return text;
  if (text.length > size) throw new ShareCryptoError('length', 'the return token is longer than the room kept for it');
  const out = new Uint8Array(size).fill(0x20);
  out.set(text);
  return out;
}

/**
 * Seals the package and uploads it: `start` asks the service for the share (a new one, its next
 * generation, or a return) with the exact bytes and object count; the caller adds the key.
 * Files are sealed one by one just before their upload, so the package is never twice in memory.
 */
export async function sendPackage(opts: {
  client: ShareClient;
  key: Uint8Array;
  out: Outgoing;
  /** A hand-over makes room for the return token in its index. */
  carriesReturnToken: boolean;
  start(sizes: { bytes: number; objects: number }): Promise<{ id: string; revokeToken: string; returnToken?: string; batch?: number }>;
  progress?: Progress;
}): Promise<{ id: string; revokeToken: string; returnToken?: string; status: ShareStatus }> {
  const { client, key, out } = opts;
  const planned: Planned[] = [];
  const all: Array<[string, Uint8Array]> = [...out.files];
  if (out.changes) all.push([CHANGES_FILE, enc.encode(JSON.stringify(out.changes))]);
  for (const [path, data] of all) {
    const object = newObjectId();
    planned.push({ path, object, data, entry: { path, object, bytes: data.byteLength, sha256: await sha256Hex(data) } });
  }
  const shareIndex: PackageShareIndex = { format: 1, kind: out.index.kind, files: planned.map((p) => p.entry), package: out.index };
  const room = opts.carriesReturnToken ? indexText({ ...shareIndex, returnToken: '' }).length + TOKEN_ROOM : undefined;
  const indexBytes = indexBlobSize(room === undefined ? indexText(shareIndex) : new Uint8Array(room));
  const bytes = indexBytes + planned.reduce((n, p) => n + encryptedSize(p.data.byteLength), 0);
  const objects = planned.length + 1;
  if (objects > SHARE_LIMITS.objects) throw new ShareLimitError('objects', objects);
  const max = out.index.kind === 'return' ? SHARE_LIMITS.returnBytes : SHARE_LIMITS.bytes;
  if (bytes > max) throw new ShareLimitError('bytes', bytes, max, out.index.kind === 'return');

  const made = await opts.start({ bytes, objects });
  const index = indexText({ ...shareIndex, ...(made.returnToken && opts.carriesReturnToken ? { returnToken: made.returnToken } : {}) }, room);
  const blobs: Array<{ name: string; bytes: number; seal: () => Promise<Uint8Array> }> = [
    { name: INDEX_OBJECT, bytes: indexBytes, seal: () => encrypt(key, index, { kind: 'index', name: INDEX_OBJECT }) },
    ...planned.map((p) => ({ name: p.object, bytes: encryptedSize(p.data.byteLength), seal: () => encryptFile(key, p.object, p.data) })),
  ];
  const step = Math.max(1, Math.min(made.batch ?? BATCH, BATCH));
  let done = 0;
  opts.progress?.({ phase: 'upload', done, total: bytes });
  for (let i = 0; i < blobs.length; i += step) {
    const batch = blobs.slice(i, i + step);
    const { targets } = await client.uploads(made.id, made.revokeToken, batch.map((b) => ({ name: b.name, bytes: b.bytes })));
    const byName = new Map(targets.map((t) => [t.object, t]));
    // A few at a time: the service's upload URLs live ten minutes, a batch of a hundred receipts is done well within.
    await pool(batch, 4, async (b) => {
      const target = byName.get(b.name);
      if (!target) throw new ShareServiceError(`Keine Upload-Adresse für ${b.name}`, 'internal', 500);
      await client.put(target, await b.seal());
      done += b.bytes;
      opts.progress?.({ phase: 'upload', done, total: bytes });
    });
  }
  const status = await client.complete(made.id, made.revokeToken, {});
  return { id: made.id, revokeToken: made.revokeToken, ...(made.returnToken ? { returnToken: made.returnToken } : {}), status };
}

async function pool<T>(items: readonly T[], width: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** The most an encrypted index may be: entries for far more files than the service's 5000 objects. */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;

/**
 * Opens a share (one opening, protocol §4.5; the service hands the key over with it), decrypts its
 * index and every file, and checks the package as a `.vanilla` file is checked
 * (src/handover/package.ts checkPackage). `token`: the sharer's revoke token, which opening one of
 * her returns takes. The checks that catch real damage stay: every file's size and SHA-256 and the
 * version's checksum.
 *
 * Nothing the service sends is trusted for its size: the index is read up to MAX_INDEX_BYTES, its
 * count and totals are held to the limits before the first file is fetched, and each file is read
 * only up to the size its sealed form must have. Each file is kept once, decrypted; its ciphertext
 * goes as soon as it is open, and no zip is built on the way.
 */
export async function receivePackage(opts: { client: ShareClient; id: string; token?: string; progress?: Progress }): Promise<{ contents: PackageContents; index: PackageShareIndex; generation: number; updatedAt?: string }> {
  const { client, id } = opts;
  const opened = await client.open(id, opts.token);
  const key = decodeKey(opened.key);
  const index = (await decryptIndex(key, await client.get(opened.index, MAX_INDEX_BYTES))) as PackageShareIndex;
  const pkg = index.package;
  if (!pkg || typeof pkg !== 'object' || pkg.kind !== index.kind) throw new ShareCryptoError('header', 'the share holds no hand-over of this app');
  const total = index.files.reduce((n, f) => n + f.bytes, 0);
  const tooLarge = (why: string, limit: string) => new PackageError(why, 'shareTooLarge', { limit });
  if (index.files.length + 1 > SHARE_LIMITS.objects) throw tooLarge(`Die Freigabe nennt ${index.files.length} Dateien: höchstens ${SHARE_LIMITS.objects}.`, String(SHARE_LIMITS.objects));
  if (total > Math.min(SHARE_LIMITS.bytes, LIMITS.totalBytes)) throw tooLarge(`Die Freigabe nennt ${Math.round(total / 1024 / 1024)} MB: höchstens 1 GB.`, '1 GB');
  if (index.kind === 'return' && total > SHARE_LIMITS.returnBytes) throw tooLarge(`Die Rücksendung nennt ${Math.round(total / 1024 / 1024)} MB: höchstens ${SHARE_LIMITS.returnBytes / 1024 / 1024} MB.`, `${SHARE_LIMITS.returnBytes / 1024 / 1024} MB`);
  for (const f of index.files) {
    const max = f.path === CHANGES_FILE ? LIMITS.jsonBytes : LIMITS.fileBytes;
    if (f.bytes > max) throw tooLarge(`${f.path} ist ${Math.round(f.bytes / 1024 / 1024)} MB gross: höchstens ${Math.round(max / 1024 / 1024)} MB pro Datei.`, `${Math.round(max / 1024 / 1024)} MB`);
  }
  let done = 0;
  const files = new Map<string, Uint8Array>();
  let changes: Uint8Array | undefined;
  for (let i = 0; i < index.files.length; i += BATCH) {
    const batch = index.files.slice(i, i + BATCH);
    const { targets } = await client.urls(id, opened.ticket, batch.map((f) => f.object));
    const byObject = new Map<string, Target>(targets.map((t) => [t.object, t]));
    await pool(batch, 4, async (f) => {
      const target = byObject.get(f.object);
      if (!target) throw new ShareServiceError(`Keine Lese-Adresse für ${f.object}`, 'internal', 500);
      const data = await decryptFile(key, f, await client.get(target, encryptedSize(f.bytes)));
      if (f.path === CHANGES_FILE) {
        if (index.kind !== 'return') throw new ShareCryptoError('header', 'a hand-over carries no change set');
        changes = data;
      } else files.set(f.path, data);
      done += f.bytes;
      opts.progress?.({ phase: 'download', done, total });
    });
  }
  return { contents: checkPackage(pkg, files, changes), index, generation: opened.generation ?? 1, ...(opened.updatedAt ? { updatedAt: opened.updatedAt } : {}) };
}
