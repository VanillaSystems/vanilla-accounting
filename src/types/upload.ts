/**
 * What the receipt drop, the add button and the phone send to POST /api/upload: PDFs, and photos
 * the inbox processing wraps into PDFs (src/parsers/image-pdf.ts). The file in the inbox keeps
 * the extension of its type.
 */
export const RECEIPT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
} as const;

export type ReceiptType = keyof typeof RECEIPT_TYPES;

/** The type of a dropped or picked file, by its MIME type or else its name (a HEIC often comes without one). */
export function receiptType(file: { type: string; name: string }): ReceiptType | undefined {
  if (file.type in RECEIPT_TYPES) return file.type as ReceiptType;
  const ext = file.name.toLowerCase().split('.').pop();
  const byExt = Object.entries(RECEIPT_TYPES).find(([, e]) => e === ext || (ext === 'jpeg' && e === 'jpg'));
  return byExt?.[0] as ReceiptType | undefined;
}
