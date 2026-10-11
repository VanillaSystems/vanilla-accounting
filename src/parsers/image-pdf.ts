/**
 * A photo or screenshot of a receipt (PNG, JPEG, HEIC) as a one-page PDF, so the inbox holds PDFs
 * only: the page is the image's size in points (72 per inch at the image's pixel size), the
 * image fills it. Through pdf-lib, no program outside Node (ADR 0006); a HEIC photo (the iPhone's
 * format) is first decoded by macOS's own `/usr/bin/sips`, which every Mac has.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

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
  const embedded = lower.endsWith('.png') ? await doc.embedPng(new Uint8Array(image))
    : await doc.embedJpg(new Uint8Array(/\.hei[cf]$/.test(lower) ? await heicToJpeg(image) : image));
  const page = doc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  return doc.save();
}

async function heicToJpeg(image: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'heic-'));
  try {
    writeFileSync(join(dir, 'in.heic'), image);
    await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', join(dir, 'in.heic'), '--out', join(dir, 'out.jpg')]);
    return readFileSync(join(dir, 'out.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
