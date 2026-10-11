/**
 * A photo or screenshot of a receipt (PNG, JPEG) as a one-page PDF, so the inbox holds PDFs
 * only: the page is the image's size in points (72 per inch at the image's pixel size), the
 * image fills it. Through pdf-lib, no program outside Node (ADR 0006).
 */
import { PDFDocument } from 'pdf-lib';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export function isImageFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function imageToPdf(image: Uint8Array, filename: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const embedded = filename.toLowerCase().endsWith('.png') ? await doc.embedPng(image) : await doc.embedJpg(image);
  const page = doc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  return doc.save();
}
