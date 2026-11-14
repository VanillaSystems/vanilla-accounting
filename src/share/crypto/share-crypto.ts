// The share format, version 1: AES-256-GCM in fixed-size chunks (docs/protocol.md).
// Runs on WebCrypto only: Node 20+, browsers, Workers. No dependency.
//
//   blob  = header (40 bytes) || chunk_0 || … || chunk_{n-1}
//   chunk = AES-256-GCM(contentKey, nonce(i, last), aad = header, plaintext_i) (ciphertext || 16-byte tag)
//   contentKey = HKDF-SHA-256(shareKey, salt = header.salt, info = "vanilla-share/v1/<kind>/<name>")
//
// <name> is the blob's object name in the share ("index", or the file's random object id), so a blob
// stored under another name fails authentication: the service cannot swap objects.
// The header is the additional data of every chunk, so a changed header fails the first chunk. The nonce
// carries the chunk's index and a last-chunk flag (the STREAM construction), so reordered, dropped,
// duplicated or appended chunks fail, and a file cut at a chunk boundary is detected.

import { fromBase64url, toBase64url } from './base64url.js';

export const MAGIC = new Uint8Array([0x56, 0x53, 0x48, 0x52]); // "VSHR"
export const FORMAT_VERSION = 1;
export const HEADER_LENGTH = 40;
export const TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
export const SALT_LENGTH = 16;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 64;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_CHUNKS = 0xffffffff;

/**
 * What a sealed blob holds. The kind is in the header and in the key derivation, so one cannot pass for another.
 * meta: the share's small envelope for the page; index: the package's list of files; file: one file;
 * wrap: a key sealed under another key (a return's key under the share's key).
 */
export type Kind = 'meta' | 'index' | 'file' | 'wrap';
const KIND_CODE: Record<Kind, number> = { meta: 2, index: 3, file: 4, wrap: 5 };

/** An object name: "index", "meta", "wrap", or a random object id (26 characters a–z, 2–7). */
export const OBJECT_NAME = /^[a-z0-9-]{1,64}$/;

export type ShareCryptoErrorCode = 'key' | 'header' | 'kind' | 'auth' | 'truncated' | 'trailing' | 'length';

export class ShareCryptoError extends Error {
  constructor(
    readonly code: ShareCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShareCryptoError';
  }
}

export interface Header {
  version: number;
  kind: Kind;
  chunkSize: number;
  plaintextLength: number;
  chunkCount: number;
  salt: Uint8Array;
  /** The 40 header bytes exactly as written: the additional data of every chunk. */
  bytes: Uint8Array<ArrayBuffer>;
}

const subtle = () => crypto.subtle;
const utf8 = new TextEncoder();

// ── keys ──────────────────────────────────────────────────────────────────────

/** A new random 256-bit share key. */
export function generateKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}

/** The key as it travels in the URL fragment: 43 characters of base64url, no padding. */
export function encodeKey(key: Uint8Array): string {
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', `key must be ${KEY_LENGTH} bytes`);
  return toBase64url(key);
}

export function decodeKey(text: string): Uint8Array<ArrayBuffer> {
  let key: Uint8Array;
  try {
    key = fromBase64url(text);
  } catch {
    throw new ShareCryptoError('key', 'key is not base64url');
  }
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', `key must be ${KEY_LENGTH} bytes`);
  return new Uint8Array(key);
}

async function contentKey(key: Uint8Array, salt: Uint8Array, kind: Kind, name: string): Promise<CryptoKey> {
  if (key.length !== KEY_LENGTH) throw new ShareCryptoError('key', `key must be ${KEY_LENGTH} bytes`);
  if (!OBJECT_NAME.test(name)) throw new ShareCryptoError('header', `bad object name ${JSON.stringify(name)}`);
  const ikm = await subtle().importKey('raw', new Uint8Array(key), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: utf8.encode(`vanilla-share/v1/${kind}/${name}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── header ────────────────────────────────────────────────────────────────────

export function chunkCountFor(plaintextLength: number, chunkSize: number): number {
  return plaintextLength === 0 ? 1 : Math.ceil(plaintextLength / chunkSize);
}

/** The ciphertext's exact size for a plaintext of this length. */
export function encryptedSize(plaintextLength: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  return HEADER_LENGTH + plaintextLength + TAG_LENGTH * chunkCountFor(plaintextLength, chunkSize);
}

function checkSizes(plaintextLength: number, chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE)
    throw new ShareCryptoError('header', `chunk size must be ${MIN_CHUNK_SIZE}…${MAX_CHUNK_SIZE} bytes`);
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0)
    throw new ShareCryptoError('length', 'plaintext length must be a non-negative safe integer');
  if (chunkCountFor(plaintextLength, chunkSize) > MAX_CHUNKS) throw new ShareCryptoError('length', 'too many chunks');
}

function writeHeader(kind: Kind, chunkSize: number, plaintextLength: number, salt: Uint8Array): Uint8Array<ArrayBuffer> {
  checkSizes(plaintextLength, chunkSize);
  const bytes = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  bytes[4] = FORMAT_VERSION;
  bytes[5] = KIND_CODE[kind];
  // bytes 6..7 reserved, zero
  view.setUint32(8, chunkSize);
  view.setBigUint64(12, BigInt(plaintextLength));
  view.setUint32(20, chunkCountFor(plaintextLength, chunkSize));
  bytes.set(salt, 24);
  return bytes;
}

/** Reads and checks a header. `expectedKind` guards against one kind of blob passed as another. */
export function parseHeader(input: Uint8Array, expectedKind?: Kind): Header {
  if (input.length < HEADER_LENGTH) throw new ShareCryptoError('truncated', 'shorter than the header');
  const bytes = new Uint8Array(input.subarray(0, HEADER_LENGTH));
  const view = new DataView(bytes.buffer);
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new ShareCryptoError('header', 'not a share file');
  if (bytes[4] !== FORMAT_VERSION) throw new ShareCryptoError('header', `unknown format version ${bytes[4]}`);
  const kind = (Object.keys(KIND_CODE) as Kind[]).find((k) => KIND_CODE[k] === bytes[5]);
  if (!kind) throw new ShareCryptoError('header', `unknown kind ${bytes[5]}`);
  if (expectedKind && kind !== expectedKind) throw new ShareCryptoError('kind', `expected ${expectedKind}, found ${kind}`);
  if (bytes[6] !== 0 || bytes[7] !== 0) throw new ShareCryptoError('header', 'reserved bytes are not zero');
  const chunkSize = view.getUint32(8);
  const big = view.getBigUint64(12);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ShareCryptoError('length', 'plaintext length too large');
  const plaintextLength = Number(big);
  checkSizes(plaintextLength, chunkSize);
  const chunkCount = view.getUint32(20);
  if (chunkCount !== chunkCountFor(plaintextLength, chunkSize))
    throw new ShareCryptoError('header', 'chunk count does not match the length');
  return { version: FORMAT_VERSION, kind, chunkSize, plaintextLength, chunkCount, salt: bytes.slice(24, 40), bytes };
}

function nonce(index: number, last: boolean): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(7, index);
  n[11] = last ? 1 : 0;
  return n;
}

function plainLengthOf(header: Pick<Header, 'chunkSize' | 'plaintextLength' | 'chunkCount'>, index: number): number {
  return index < header.chunkCount - 1 ? header.chunkSize : header.plaintextLength - header.chunkSize * (header.chunkCount - 1);
}

// ── chunk level ───────────────────────────────────────────────────────────────

/** Seals one chunk after the other. For callers that read and write files themselves. */
export class Encryptor {
  private constructor(
    readonly header: Header,
    private readonly key: CryptoKey,
  ) {}

  static async create(
    key: Uint8Array,
    opts: { kind: Kind; name: string; plaintextLength: number; chunkSize?: number; /** Random when absent; test vectors only. */ salt?: Uint8Array },
  ): Promise<Encryptor> {
    const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    if (salt.length !== SALT_LENGTH) throw new ShareCryptoError('header', `salt must be ${SALT_LENGTH} bytes`);
    const bytes = writeHeader(opts.kind, opts.chunkSize ?? DEFAULT_CHUNK_SIZE, opts.plaintextLength, salt);
    const header = parseHeader(bytes, opts.kind);
    return new Encryptor(header, await contentKey(key, salt, opts.kind, opts.name));
  }

  /** Plaintext bytes chunk `index` must hold: chunkSize, the last one the rest. */
  plainLength(index: number): number {
    return plainLengthOf(this.header, index);
  }

  async seal(index: number, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const { chunkCount } = this.header;
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new ShareCryptoError('length', 'chunk index out of range');
    if (plaintext.length !== this.plainLength(index)) throw new ShareCryptoError('length', `chunk ${index} must be ${this.plainLength(index)} bytes`);
    const sealed = await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce(index, index === chunkCount - 1), additionalData: this.header.bytes, tagLength: 128 },
      this.key,
      new Uint8Array(plaintext),
    );
    return new Uint8Array(sealed);
  }
}

/** Opens one chunk after the other, for a header already read. */
export class Decryptor {
  private constructor(
    readonly header: Header,
    private readonly key: CryptoKey,
  ) {}

  static async create(key: Uint8Array, headerBytes: Uint8Array, kind: Kind, name: string): Promise<Decryptor> {
    const header = parseHeader(headerBytes, kind);
    return new Decryptor(header, await contentKey(key, header.salt, kind, name));
  }

  /** Ciphertext bytes of chunk `index`, tag included. */
  sealedLength(index: number): number {
    return plainLengthOf(this.header, index) + TAG_LENGTH;
  }

  /** The total size a complete file of this header has. */
  get totalSize(): number {
    return HEADER_LENGTH + this.header.plaintextLength + TAG_LENGTH * this.header.chunkCount;
  }

  async open(index: number, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const { chunkCount } = this.header;
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new ShareCryptoError('length', 'chunk index out of range');
    if (sealed.length !== this.sealedLength(index)) throw new ShareCryptoError('truncated', `chunk ${index} has the wrong length`);
    try {
      const plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce(index, index === chunkCount - 1), additionalData: this.header.bytes, tagLength: 128 },
        this.key,
        new Uint8Array(sealed),
      );
      return new Uint8Array(plain);
    } catch {
      throw new ShareCryptoError('auth', `chunk ${index} failed authentication (wrong key, or the data was changed)`);
    }
  }
}

// ── whole buffers ─────────────────────────────────────────────────────────────

export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  opts: { kind: Kind; name: string; chunkSize?: number; /** Random when absent; test vectors only. */ salt?: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  const enc = await Encryptor.create(key, { ...opts, plaintextLength: plaintext.length });
  const out = new Uint8Array(encryptedSize(plaintext.length, enc.header.chunkSize));
  out.set(enc.header.bytes, 0);
  let pos = HEADER_LENGTH;
  for (let i = 0, from = 0; i < enc.header.chunkCount; i++) {
    const len = enc.plainLength(i);
    const sealed = await enc.seal(i, plaintext.subarray(from, from + len));
    out.set(sealed, pos);
    pos += sealed.length;
    from += len;
  }
  return out;
}

export async function decrypt(key: Uint8Array, file: Uint8Array, opts: { kind: Kind; name: string }): Promise<Uint8Array<ArrayBuffer>> {
  const dec = await Decryptor.create(key, file, opts.kind, opts.name);
  if (file.length < dec.totalSize) throw new ShareCryptoError('truncated', 'the file is shorter than its header says');
  if (file.length > dec.totalSize) throw new ShareCryptoError('trailing', 'data after the last chunk');
  const out = new Uint8Array(dec.header.plaintextLength);
  let pos = HEADER_LENGTH;
  let to = 0;
  for (let i = 0; i < dec.header.chunkCount; i++) {
    const len = dec.sealedLength(i);
    const plain = await dec.open(i, file.subarray(pos, pos + len));
    out.set(plain, to);
    to += plain.length;
    pos += len;
  }
  return out;
}

// ── streams ───────────────────────────────────────────────────────────────────

/** Reads exactly n bytes from a stream, or fewer at its end. */
class ExactReader {
  private buffered: Uint8Array[] = [];
  private size = 0;
  private done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.size < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value.length) {
        this.buffered.push(value);
        this.size += value.length;
      }
    }
    const take = Math.min(n, this.size);
    const out = new Uint8Array(take);
    let pos = 0;
    while (pos < take) {
      const head = this.buffered[0]!;
      const part = Math.min(head.length, take - pos);
      out.set(head.subarray(0, part), pos);
      pos += part;
      if (part === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(part);
    }
    this.size -= take;
    return out;
  }

  /** True when nothing is left. */
  async atEnd(): Promise<boolean> {
    if (this.size > 0) return false;
    const next = await this.read(1);
    if (next.length === 0) return true;
    this.buffered.unshift(next);
    this.size += 1;
    return false;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.reader.cancel(reason);
  }
}

/**
 * Encrypts a stream of known length. The source must deliver exactly `plaintextLength` bytes;
 * fewer or more fail the output stream.
 */
export function encryptStream(
  key: Uint8Array,
  source: ReadableStream<Uint8Array>,
  opts: { kind: Kind; name: string; plaintextLength: number; chunkSize?: number },
): ReadableStream<Uint8Array> {
  let enc: Encryptor;
  const input = new ExactReader(source.getReader());
  let index = -1;
  // Set up in the first pull, not in start(): workerd may pull before an async start() settles.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === -1) {
        enc = await Encryptor.create(key, opts);
        index = 0;
        controller.enqueue(enc.header.bytes);
        return;
      }
      if (index === enc.header.chunkCount) {
        if (!(await input.atEnd())) throw new ShareCryptoError('length', 'the source is longer than plaintextLength');
        controller.close();
        return;
      }
      const want = enc.plainLength(index);
      const plain = await input.read(want);
      if (plain.length !== want) throw new ShareCryptoError('length', 'the source is shorter than plaintextLength');
      controller.enqueue(await enc.seal(index, plain));
      index++;
    },
    cancel(reason) {
      return input.cancel(reason);
    },
  });
}

/**
 * Decrypts a stream. Each chunk is authenticated before its plaintext is released; a cut, reordered or
 * changed file errors the stream. Keep the output only if the stream closes without an error
 * (write to a temporary file, rename on success).
 */
export function decryptStream(
  key: Uint8Array,
  source: ReadableStream<Uint8Array>,
  opts: { kind: Kind; name: string },
): ReadableStream<Uint8Array> {
  let dec: Decryptor | undefined;
  const input = new ExactReader(source.getReader());
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      dec ??= await Decryptor.create(key, await input.read(HEADER_LENGTH), opts.kind, opts.name);
      // Each pull enqueues or closes: an empty last chunk (an empty file) goes straight on to the end check.
      for (;;) {
        if (index === dec.header.chunkCount) {
          if (!(await input.atEnd())) throw new ShareCryptoError('trailing', 'data after the last chunk');
          controller.close();
          return;
        }
        const want = dec.sealedLength(index);
        const sealed = await input.read(want);
        if (sealed.length !== want) throw new ShareCryptoError('truncated', `the file ends inside chunk ${index}`);
        const plain = await dec.open(index, sealed);
        index++;
        if (plain.length) {
          controller.enqueue(plain);
          return;
        }
      }
    },
    cancel(reason) {
      return input.cancel(reason);
    },
  });
}
