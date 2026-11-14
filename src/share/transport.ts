/**
 * The hand-over package (src/handover/package.ts) over the share service: every file of the package
 * sealed on its own under the share's key, the encrypted index naming them (docs/share-protocol.md
 * §3). The share's index carries the package's own index whole (`package`), a return's change set
 * is its file `changes.json`, and the recipient's return token rides in the index (§5).
 *
 * The receiving side decrypts every file, checks it against the share's index, and puts the
 * package together as the `.vanilla` file it would be on disk: the hand-over code then checks it
 * as it checks a file (paths, sizes, every file's SHA-256, the version's checksum). The link and the
 * file are one format with two transports.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { PackageIndex, ReturnChange } from '../handover/package.js';
import type { ShareClient, ShareStatus, Target } from './client.js';
import { ShareServiceError } from './client.js';
import {
  decryptFile, decryptIndex, encryptedSize, encryptFile, encrypt, INDEX_OBJECT, newObjectId, openProof, sha256Hex,
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
/** Room kept in the index for the return token the service names only once the share exists. */
const TOKEN_ROOM = 256;
const BATCH = 100;
const STABLE_TIME = new Date('2000-01-01T00:00:00Z');

export type Phase = 'encrypt' | 'upload' | 'download' | 'decrypt';
export type Progress = (p: { phase: Phase; done: number; total: number }) => void;

/** Refused before the service is asked: the package is past one of the service's limits. */
export class ShareLimitError extends Error {
  constructor(readonly limit: 'bytes' | 'objects', readonly value: number) {
    super(limit === 'bytes'
      ? `Die Übergabe ist verschlüsselt ${Math.round(value / 1024 / 1024)} MB gross: der Dienst nimmt höchstens ${SHARE_LIMITS.bytes / 1024 / 1024 / 1024} GB pro Link.`
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
 * Seals the package and uploads it: `start` asks the service for the share (or the return) with the
 * exact bytes and object count, `finish` names what completing it takes (a return's wrapped key).
 * Files are sealed one by one just before their upload, so the package is never twice in memory.
 */
export async function sendPackage(opts: {
  client: ShareClient;
  key: Uint8Array;
  out: Outgoing;
  /** A hand-over makes room for the return token in its index. */
  carriesReturnToken: boolean;
  start(sizes: { bytes: number; objects: number; openProof: string }): Promise<{ id: string; revokeToken: string; returnToken?: string; batch?: number }>;
  finish?(id: string): Promise<Record<string, unknown>>;
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
  if (bytes > SHARE_LIMITS.bytes) throw new ShareLimitError('bytes', bytes);

  const made = await opts.start({ bytes, objects, openProof: await openProof(key) });
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
  const status = await client.complete(made.id, made.revokeToken, opts.finish ? await opts.finish(made.id) : {});
  return { id: made.id, revokeToken: made.revokeToken, ...(made.returnToken ? { returnToken: made.returnToken } : {}), status };
}

async function pool<T>(items: readonly T[], width: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Opens a share (one opening, protocol §4.5), decrypts its index and every file, and puts the
 * package together as the `.vanilla` file's bytes. `token`: the sharer's revoke token, which opening
 * one of her returns takes.
 */
export async function receivePackage(opts: { client: ShareClient; id: string; key: Uint8Array; token?: string; progress?: Progress }): Promise<{ bytes: Uint8Array; index: PackageShareIndex }> {
  const { client, id, key } = opts;
  const proof = await openProof(key);
  const opened = await client.open(id, proof, opts.token);
  const index = (await decryptIndex(key, await client.get(opened.index))) as PackageShareIndex;
  const pkg = index.package;
  if (!pkg || typeof pkg !== 'object' || pkg.kind !== index.kind) throw new ShareCryptoError('header', 'the share holds no hand-over of this app');
  const total = index.files.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  const zip: Zippable = { 'index.json': [strToU8(JSON.stringify(pkg)), { level: 6 }] };
  for (let i = 0; i < index.files.length; i += BATCH) {
    const batch = index.files.slice(i, i + BATCH);
    const { targets } = await client.urls(id, opened.ticket, batch.map((f) => f.object), proof);
    const byObject = new Map<string, Target>(targets.map((t) => [t.object, t]));
    await pool(batch, 4, async (f) => {
      const target = byObject.get(f.object);
      if (!target) throw new ShareServiceError(`Keine Lese-Adresse für ${f.object}`, 'internal', 500);
      const data = await decryptFile(key, f, await client.get(target));
      if (f.path === CHANGES_FILE) {
        if (index.kind !== 'return') throw new ShareCryptoError('header', 'a hand-over carries no change set');
        zip[CHANGES_FILE] = [data, { level: 6 }];
      } else zip[`files/${f.path}`] = [data, { level: 0 }];
      done += f.bytes;
      opts.progress?.({ phase: 'download', done, total });
    });
  }
  // The same share gives the same bytes: a return fetched twice is one return (src/handover/returns.ts receiveReturn).
  const sorted: Zippable = Object.fromEntries(Object.keys(zip).sort().map((k) => [k, zip[k]]));
  return { bytes: zipSync(sorted, { mtime: STABLE_TIME }), index };
}
