/**
 * A file the person gives the AI sidebar with a message: dropped on the chat, pasted, or picked
 * with «+» › «Datei anhängen …». It is no receipt: it lives beside the conversation
 * (data/assistant/attachments/<conversation>/, src/assistant/attachments.ts), never in the books
 * or the inbox, until «Als Beleg übernehmen» hands it to the drop. The browser and the server
 * check it by the same rules, so a refusal reads the same before and after the upload.
 */

/** What the model reads by path (images and PDFs); a HEIC photo is kept as a JPEG, which it can read. */
export const ATTACHMENT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
} as const;

export type AttachmentType = keyof typeof ATTACHMENT_TYPES;

export const ATTACHMENT_MAX_MB = 20;
export const ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_MB * 1024 * 1024;

/** A stored attachment, as a message and its turn name it. */
export interface Attachment { id: string; name: string; type: AttachmentType; size: number }

export type AttachmentRefusal =
  | { code: 'attachment'; params: { reason: 'type' | 'empty' | 'gone'; name: string } }
  | { code: 'attachment'; params: { reason: 'size'; name: string; mb: number } };

/** The type of a file by its MIME type or else its name (a HEIC, or a file from Finder, often comes without one). */
export function attachmentType(file: { type: string; name: string }): AttachmentType | undefined {
  if (file.type in ATTACHMENT_TYPES) return file.type as AttachmentType;
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'jpeg') return 'image/jpeg';
  return Object.entries(ATTACHMENT_TYPES).find(([, e]) => e === ext)?.[0] as AttachmentType | undefined;
}

/** Why a file cannot be attached, before a byte is sent; undefined when it can. */
export function attachmentRefusal(file: { type: string; name: string; size: number }): AttachmentRefusal | undefined {
  const name = file.name || '?';
  if (!attachmentType(file)) return { code: 'attachment', params: { reason: 'type', name } };
  if (file.size === 0) return { code: 'attachment', params: { reason: 'empty', name } };
  if (file.size > ATTACHMENT_MAX_BYTES) return { code: 'attachment', params: { reason: 'size', name, mb: Math.ceil(file.size / 1024 / 1024) } };
  return undefined;
}

/** Whether the browser shows the type in an <img> (a thumbnail on the chip). */
export const showsAsImage = (type: AttachmentType): boolean => type === 'image/png' || type === 'image/jpeg' || type === 'image/gif' || type === 'image/webp';
