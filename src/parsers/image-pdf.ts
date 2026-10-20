/**
 * A photo or screenshot of a receipt (PNG, JPEG, HEIC) as a one-page PDF, so the inbox holds PDFs
 * only: the page is the image's size in points (72 per inch at the image's pixel size), the
 * image fills it, turned upright by its EXIF orientation. Through pdf-lib, no program outside Node (ADR 0006); a HEIC photo (the iPhone's
 * format) is first decoded by macOS's own `/usr/bin/sips`, which every Mac has.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from 'pdf-lib';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.heic', '.heif'] as const;

export function isImageFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function imageToPdf(image: Uint8Array, filename: string): Promise<Uint8Array> {
  const lower = filename.toLowerCase();
  const doc = await PDFDocument.create();
  // pdf-lib reads a JPEG through a DataView on `.buffer` from offset 0: a small Buffer from
  // readFileSync lies inside Node's shared pool at another offset, so each gets its own copy.
  const bytes = new Uint8Array(/\.hei[cf]$/.test(lower) ? await heicToJpeg(image) : image);
  const png = lower.endsWith('.png');
  const embedded = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const { width: w, height: h } = embedded;
  const orientation = exifOrientation(bytes, png);
  const [a, b, c, d, e, f] = UPRIGHT[orientation](w, h);
  const page = doc.addPage(orientation >= 5 ? [h, w] : [w, h]);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
  page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  page.pushOperators(popGraphicsState());
  return doc.save();
}

type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Per EXIF orientation, the matrix that turns the image as stored (w x h at the origin) upright on the page. */
const UPRIGHT: Record<Orientation, (w: number, h: number) => [number, number, number, number, number, number]> = {
  1: () => [1, 0, 0, 1, 0, 0],
  2: (w) => [-1, 0, 0, 1, w, 0],
  3: (w, h) => [-1, 0, 0, -1, w, h],
  4: (_w, h) => [1, 0, 0, -1, 0, h],
  5: (w, h) => [0, -1, -1, 0, h, w],
  6: (w) => [0, -1, 1, 0, 0, w],
  7: () => [0, 1, 1, 0, 0, 0],
  8: (_w, h) => [0, 1, -1, 0, h, 0],
};

/** The orientation tag (0x0112) of the Exif block: a JPEG's APP1 segment or a PNG's eXIf chunk; 1 when there is none. */
export function exifOrientation(bytes: Uint8Array, png: boolean): Orientation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tiff = png ? pngExif(view) : jpegExif(view);
  if (tiff === undefined || tiff + 8 > view.byteLength) return 1;
  const little = view.getUint16(tiff) === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > view.byteLength) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return 1;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? (value as Orientation) : 1;
  }
  return 1;
}

function jpegExif(view: DataView): number | undefined {
  let at = 2;
  while (at + 4 <= view.byteLength && view.getUint8(at) === 0xff) {
    const marker = view.getUint8(at + 1);
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = view.getUint16(at + 2);
    if (marker === 0xe1 && at + 10 <= view.byteLength && view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0) return at + 10;
    at += 2 + length;
  }
  return undefined;
}

function pngExif(view: DataView): number | undefined {
  let at = 8;
  while (at + 8 <= view.byteLength) {
    const length = view.getUint32(at);
    const type = view.getUint32(at + 4);
    if (type === 0x65584966) return at + 8;
    if (type === 0x49444154) return undefined;
    at += 12 + length;
  }
  return undefined;
}

export async function heicToJpeg(image: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'heic-'));
  try {
    writeFileSync(join(dir, 'in.heic'), image);
    await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', join(dir, 'in.heic'), '--out', join(dir, 'out.jpg')]);
    return readFileSync(join(dir, 'out.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
