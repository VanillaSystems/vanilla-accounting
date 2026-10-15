/** A one-page PDF holding these lines as text (pdftotext reads them back): a made-up document for a test. */
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function textPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 790 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
