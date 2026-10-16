/**
 * An own photo or scan made smaller before it gets its id (docs/0.4.0/intake.md): each large JPEG
 * image in the PDF is scaled to at most 3000 pixels on its long side and saved again at quality 75,
 * which keeps a till receipt's small print readable. Done by macOS's own `/usr/bin/sips`, as for
 * HEIC (image-pdf.ts); without it, or for anything it cannot do safely (a signed or encrypted PDF,
 * an image in another encoding), the bytes stay as they are. The page keeps its size: an image is
 * drawn into the box the page gives it, whatever its pixels.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { JpegEmbedder, PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';

const SIPS = '/usr/bin/sips';
/** Below this a PDF is left alone. */
const PDF_BYTES = 1_500_000;
/** Below this, and within LONG_SIDE, an image is left alone. */
const IMAGE_BYTES = 400_000;
const LONG_SIDE = 3000;

export async function smallerPdf(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < PDF_BYTES || !existsSync(SIPS)) return bytes;
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (/\/Encrypt\b|\/ByteRange\b/.test(raw)) return bytes;
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); } catch { return bytes; }
  const dir = mkdtempSync(join(tmpdir(), 'smaller-'));
  let changed = false;
  try {
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image') || !isJpeg(obj)) continue;
      const w = (obj.dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const h = (obj.dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0;
      if (!w || !h || (obj.contents.length < IMAGE_BYTES && Math.max(w, h) <= LONG_SIDE)) continue;
      const out = await resample(dir, obj.contents, Math.min(LONG_SIDE, Math.max(w, h)));
      if (!out || out.length >= obj.contents.length) continue;
      const jpeg = await JpegEmbedder.for(out);
      // sips must not have turned the pixels (by an Exif tag): the image keeps its proportions.
      if (Math.abs(jpeg.width / jpeg.height - w / h) > 0.02) continue;
      obj.dict.set(PDFName.of('Width'), PDFNumber.of(jpeg.width));
      obj.dict.set(PDFName.of('Height'), PDFNumber.of(jpeg.height));
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(out.length));
      doc.context.assign(ref, PDFRawStream.of(obj.dict, out));
      changed = true;
    }
    if (!changed) return bytes;
    const saved = await doc.save();
    return saved.length < bytes.length ? saved : bytes;
  } catch {
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stream stored as JPEG: /Filter /DCTDecode, alone or as the only filter. */
function isJpeg(s: PDFRawStream): boolean {
  const f = s.dict.get(PDFName.of('Filter'));
  return f === PDFName.of('DCTDecode') || (f instanceof PDFArray && f.size() === 1 && f.get(0) === PDFName.of('DCTDecode'));
}

async function resample(dir: string, jpeg: Uint8Array, longSide: number): Promise<Uint8Array | undefined> {
  const [src, dst] = [join(dir, 'in.jpg'), join(dir, 'out.jpg')];
  writeFileSync(src, jpeg);
  try {
    await promisify(execFile)(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', String(longSide), src, '--out', dst]);
    return new Uint8Array(readFileSync(dst));
  } catch {
    return undefined;
  } finally {
    rmSync(dst, { force: true });
  }
}
