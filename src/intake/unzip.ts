/**
 * Unpacking a dropped ZIP (docs/0.4.0/intake.md, "ZIP files"): a container, not a document. Its
 * files come out byte for byte; a ZIP inside is unpacked too, three levels at most; an archive
 * that would unpack beyond the limit is refused as a zip bomb, before anything is unpacked. A
 * password (ZipCrypto or AES) is used here, in memory, and never stored.
 */
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

export const MAX_DEPTH = 3;
/** What one drop may unpack in all. */
export const MAX_UNPACKED = 300 * 1024 * 1024;
/** A file this many times its packed size is a bomb's, not a document's. */
const MAX_RATIO = 1000;

export type Unzipped =
  | { ok: true; files: Array<{ name: string; bytes: Buffer }> }
  | { ok: false; locked: true; reason?: 'wrong-password' }
  | { ok: false; locked?: false; reason: 'too-deep' | 'too-big' | 'damaged' };

/** The files of a ZIP, a ZIP inside it unpacked in turn; `depth` is this archive's level, from 1. */
export async function unzip(bytes: Buffer, password?: string, depth = 1, budget = { left: MAX_UNPACKED }): Promise<Unzipped> {
  if (depth > MAX_DEPTH) return { ok: false, reason: 'too-deep' };
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { password, checkSignature: true });
  try {
    let entries;
    try { entries = await reader.getEntries(); } catch { return { ok: false, reason: 'damaged' }; }
    const files = entries.filter((e) => !e.directory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.filename));
    const total = files.reduce((n, e) => n + e.uncompressedSize, 0);
    if (total > budget.left || files.some((e) => e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > MAX_RATIO)) {
      return { ok: false, reason: 'too-big' };
    }
    if (files.some((e) => e.encrypted) && !password) return { ok: false, locked: true };
    budget.left -= total;
    const out: Array<{ name: string; bytes: Buffer }> = [];
    for (const e of files) {
      let data: Uint8Array;
      try {
        data = await e.getData!(new Uint8ArrayWriter(), { password });
      } catch (err) {
        if (/password/i.test(String((err as Error).message))) return { ok: false, locked: true, reason: 'wrong-password' };
        return { ok: false, reason: 'damaged' };
      }
      const name = e.filename.split('/').pop()!;
      const inner = Buffer.from(data);
      if (inner[0] === 0x50 && inner[1] === 0x4b && inner[2] === 0x03 && inner[3] === 0x04) {
        const nested = await unzip(inner, password, depth + 1, budget);
        if (!nested.ok) return nested;
        out.push(...nested.files);
      } else out.push({ name, bytes: inner });
    }
    return { ok: true, files: out };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

