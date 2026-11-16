/**
 * A Freigabe-Datei as a zip whose members are taken over as they are (src/handover/package.ts
 * writes it): «Sichern» copies the hand-over's members byte for byte and adds his changes, never
 * unpacking or packing the receipts again, in chunks with awaits between them, so a copy of
 * hundreds of MB saves without holding the app (review of PR #559). Only what fflate's zipSync
 * writes is read: no ZIP64 (a share is at most 1 GB and 20,000 files, package.ts LIMITS).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { inflateSync } from 'fflate';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const CHUNK = 1024 * 1024;

interface Entry {
  name: string;
  /** Where the member's local header starts, and where the next one (or the directory) starts. */
  offset: number; end: number;
  method: number; csize: number;
  /** The member's central directory record, as it was. */
  record: Buffer;
}

class ZipError extends Error {}

/** The end record and the central directory of a zip of `size` bytes, read through `read`. */
async function entriesOf(size: number, read: (at: number, n: number) => Promise<Buffer>): Promise<Entry[]> {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await read(size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === END) { at = i; break; }
  if (at < 0) throw new ZipError('no end record');
  const count = tail.readUInt16LE(at + 10), dirSize = tail.readUInt32LE(at + 12), dirAt = tail.readUInt32LE(at + 16);
  if (count === 0xffff || dirAt === 0xffffffff || dirAt + dirSize > size) throw new ZipError('ZIP64 or a damaged directory');
  const dir = await read(dirAt, dirSize);
  const out: Entry[] = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (dir.readUInt32LE(p) !== CENTRAL) throw new ZipError('damaged directory');
    const nameLength = dir.readUInt16LE(p + 28), extra = dir.readUInt16LE(p + 30), comment = dir.readUInt16LE(p + 32);
    const length = 46 + nameLength + extra + comment;
    out.push({
      name: dir.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      offset: dir.readUInt32LE(p + 42), end: 0, method: dir.readUInt16LE(p + 10), csize: dir.readUInt32LE(p + 20),
      record: Buffer.from(dir.subarray(p, p + length)),
    });
    p += length;
  }
  // A member ends where the next begins (a data descriptor, if any, comes along); the last where the directory begins.
  const byOffset = [...out].sort((a, b) => a.offset - b.offset);
  byOffset.forEach((e, i) => { e.end = byOffset[i + 1]?.offset ?? dirAt; });
  return out;
}

const fileReader = (fh: FileHandle) => async (at: number, n: number): Promise<Buffer> => {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, at + got);
    if (!bytesRead) throw new ZipError('file ends early');
    got += bytesRead;
  }
  return buf;
};

/** One member of the zip file at `path`, unpacked; none when it holds no such member or is no zip. */
export async function readZipMember(path: string, name: string): Promise<Uint8Array | undefined> {
  const fh = await open(path, 'r');
  try {
    const read = fileReader(fh);
    const entry = (await entriesOf((await fh.stat()).size, read)).find((e) => e.name === name);
    if (!entry) return undefined;
    const head = await read(entry.offset, 30);
    if (head.readUInt32LE(0) !== LOCAL) throw new ZipError('damaged member');
    const data = await read(entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), entry.csize);
    if (entry.method === 0) return new Uint8Array(data);
    if (entry.method === 8) return inflateSync(new Uint8Array(data));
    throw new ZipError(`method ${entry.method}`);
  } catch (e) {
    if (e instanceof ZipError) return undefined;
    throw e;
  } finally { await fh.close(); }
}

/** A member stored (not deflated), as its local header and its directory record. */
function stored(name: string, data: Uint8Array, offset: number): { local: Buffer; record: Buffer } {
  const n = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30 + n.length);
  local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.byteLength, 18); local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
  n.copy(local, 30);
  const record = Buffer.alloc(46 + n.length);
  record.writeUInt32LE(CENTRAL, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(0, 10);
  record.writeUInt16LE(0, 12); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(data.byteLength, 20); record.writeUInt32LE(data.byteLength, 24); record.writeUInt16LE(n.length, 28);
  record.writeUInt32LE(offset, 42);
  n.copy(record, 46);
  return { local, record };
}

/**
 * The zip at `source` again, its members copied as they are except those `drop` names, with `add`
 * stored at the end, written chunk by chunk through `write`. The directory is written anew.
 */
export async function rewriteZip(source: string, write: (chunk: Uint8Array) => Promise<void>, opts: { drop(name: string): boolean; add: ReadonlyArray<{ name: string; data: Uint8Array }> }): Promise<void> {
  const fh = await open(source, 'r');
  try {
    const read = fileReader(fh);
    const kept = (await entriesOf((await fh.stat()).size, read)).filter((e) => !opts.drop(e.name)).sort((a, b) => a.offset - b.offset);
    const records: Buffer[] = [];
    let at = 0;
    for (const e of kept) {
      const record = Buffer.from(e.record);
      record.writeUInt32LE(at, 42);
      records.push(record);
      for (let p = e.offset; p < e.end; p += CHUNK) {
        const chunk = await read(p, Math.min(CHUNK, e.end - p));
        await write(chunk);
        at += chunk.length;
      }
    }
    for (const a of opts.add) {
      const { local, record } = stored(a.name, a.data, at);
      await write(local); await write(a.data);
      at += local.length + a.data.byteLength;
      records.push(record);
    }
    const dir = Buffer.concat(records);
    if (at + dir.length > 0xffffffff || records.length >= 0xffff) throw new ZipError('too large for a zip without ZIP64');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
    end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16);
    await write(dir); await write(end);
  } finally { await fh.close(); }
}

/**
 * Puts `data` in place of the stored member `name` of the zip `bytes`, which must be exactly as long
 * (an index kept at a fixed size, src/share/transport.ts): its bytes and its CRC in the local header
 * and the directory. The zip is changed in place and returned.
 */
export function replaceStoredMember(bytes: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === END) { end = i; break; }
  if (end < 0) throw new Error('no zip');
  const count = buf.readUInt16LE(end + 10);
  for (let p = buf.readUInt32LE(end + 16), i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error('damaged zip directory');
    const nameLength = buf.readUInt16LE(p + 28);
    if (buf.subarray(p + 46, p + 46 + nameLength).toString('utf8') === name) {
      if (buf.readUInt16LE(p + 10) !== 0 || buf.readUInt32LE(p + 20) !== data.byteLength) throw new Error(`${name} is not stored at ${data.byteLength} bytes`);
      const local = buf.readUInt32LE(p + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      buf.set(data, start);
      const crc = crc32(data) >>> 0;
      buf.writeUInt32LE(crc, local + 14);
      buf.writeUInt32LE(crc, p + 16);
      return bytes;
    }
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`${name} is not in the zip`);
}
