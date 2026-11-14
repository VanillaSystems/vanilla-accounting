// A share is a set of objects, each sealed on its own (docs/protocol.md «The package»):
//
//   index        the encrypted index: which file is which object (kind index, name "index")
//   <object id>  one file each (kind file, name = its random object id)
//
// The service sees object ids and sizes, never paths. A reader fetches the index, then only the files
// it shows (a browser viewer loads receipts lazily).

import { fromBase64url, toBase64url } from './base64url.js';
import { decrypt, encrypt, KEY_LENGTH, ShareCryptoError } from './share-crypto.js';

export const INDEX_OBJECT = 'index';
/** A random object id: 26 characters a–z and 2–7 (130 bits), usable as a DNS label too. */
export const OBJECT_ID = /^[a-z2-7]{26}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return [...bytes].map((b) => BASE32[b & 31]).join('');
}

/** One file of the package as the index names it. */
export interface IndexFile {
  /** Relative path with forward slashes: "transactional-data/2026/receipts/coop.pdf". */
  path: string;
  /** The object holding it. */
  object: string;
  /** Plaintext bytes. */
  bytes: number;
  /** Hex SHA-256 of the plaintext. */
  sha256: string;
  [more: string]: unknown;
}

/**
 * The index. Only `format` and `files` are checked here; the app adds what the spec names (kind, company,
 * sharer, recipient, version, base, omitted, tree objects …) and checks it itself.
 */
export interface ShareIndex {
  format: 1;
  kind: 'full' | 'update' | 'return';
  files: IndexFile[];
  [more: string]: unknown;
}

/** A path that cannot leave the folder it is unpacked into. */
export function checkPath(path: string): void {
  const bad =
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (bad) throw new ShareCryptoError('header', `unsafe path in the index: ${JSON.stringify(path)}`);
}

export function checkIndex(index: ShareIndex): void {
  if (index?.format !== 1 || !Array.isArray(index.files) || !['full', 'update', 'return'].includes(index.kind))
    throw new ShareCryptoError('header', 'unknown index format');
  const paths = new Set<string>();
  const objects = new Set<string>();
  for (const f of index.files) {
    checkPath(f.path);
    if (!OBJECT_ID.test(f.object)) throw new ShareCryptoError('header', `bad object id for ${f.path}`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) throw new ShareCryptoError('header', `bad size for ${f.path}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new ShareCryptoError('header', `bad sha256 for ${f.path}`);
    if (paths.has(f.path)) throw new ShareCryptoError('header', `path twice in the index: ${f.path}`);
    if (objects.has(f.object)) throw new ShareCryptoError('header', `object twice in the index: ${f.object}`);
    paths.add(f.path);
    objects.add(f.object);
  }
}

export async function encryptIndex(key: Uint8Array, index: ShareIndex, opts: { chunkSize?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
  checkIndex(index);
  return encrypt(key, new TextEncoder().encode(JSON.stringify(index)), { kind: 'index', name: INDEX_OBJECT, ...opts });
}

export async function decryptIndex(key: Uint8Array, blob: Uint8Array): Promise<ShareIndex> {
  const plain = await decrypt(key, blob, { kind: 'index', name: INDEX_OBJECT });
  let index: ShareIndex;
  try {
    index = JSON.parse(new TextDecoder().decode(plain)) as ShareIndex;
  } catch {
    throw new ShareCryptoError('header', 'the index is not JSON');
  }
  checkIndex(index);
  return index;
}

export function encryptFile(key: Uint8Array, object: string, data: Uint8Array, opts: { chunkSize?: number } = {}) {
  if (!OBJECT_ID.test(object)) throw new ShareCryptoError('header', 'bad object id');
  return encrypt(key, data, { kind: 'file', name: object, ...opts });
}

/** Decrypts one file and checks it against its index entry (size and SHA-256). */
export async function decryptFile(key: Uint8Array, entry: IndexFile, blob: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await decrypt(key, blob, { kind: 'file', name: entry.object });
  if (plain.length !== entry.bytes || (await sha256Hex(plain)) !== entry.sha256)
    throw new ShareCryptoError('auth', `${entry.path} does not match the index`);
  return plain;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A return's key sealed under the share's key (base64url), bound to the return's id: a wrapped key moved to
 * another return fails. The sharer's app unwraps it with the key from her own link; the service stores
 * only this ciphertext.
 */
export async function wrapKey(shareKey: Uint8Array, key: Uint8Array, returnId: string): Promise<string> {
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', `key must be ${KEY_LENGTH} bytes`);
  return toBase64url(await encrypt(shareKey, key, { kind: 'wrap', name: returnId }));
}

/**
 * The open proof (protocol.md §1): HKDF-SHA-256(key, salt = empty, info = "vanilla-share/v1/open"), 32 bytes,
 * base64url. Shown to the service to open a share, so the id alone spends no opening; it reveals nothing
 * about the key. The service stores only a keyed hash of it.
 */
export async function openProof(key: Uint8Array): Promise<string> {
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', `key must be ${KEY_LENGTH} bytes`);
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(key), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode('vanilla-share/v1/open') }, ikm, 256);
  return toBase64url(new Uint8Array(bits));
}

export async function unwrapKey(shareKey: Uint8Array, wrapped: string, returnId: string): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(wrapped);
  } catch {
    throw new ShareCryptoError('key', 'the wrapped key is not base64url');
  }
  const key = await decrypt(shareKey, bytes, { kind: 'wrap', name: returnId });
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', 'the wrapped key has the wrong length');
  return key;
}
