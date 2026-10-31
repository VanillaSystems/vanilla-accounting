/**
 * The files a person gives the AI sidebar with a message (src/types/attachment.ts), kept on this
 * computer beside the conversations and outside the books: an upload waits under
 * data/assistant/attachments/pending/<id>/<name> until its message is sent, then moves to
 * data/assistant/attachments/<conversation>/<id>/<name>, where the model reads it by path and the
 * sidebar shows it. Nothing here touches the books or the inbox.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { ATTACHMENT_TYPES, attachmentRefusal, attachmentType, type Attachment, type AttachmentRefusal, type AttachmentType } from '../types/attachment.js';
import { heicToJpeg } from '../parsers/image-pdf.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING = 'pending';

type Ws = Pick<Workspace, 'paths'>;
const root = (ws: Ws) => join(ws.paths.data, 'assistant', 'attachments');

export class AttachmentError extends Error {
  constructor(readonly refusal: AttachmentRefusal) { super(refusalText(refusal)); }
}

function refusalText({ params: p }: AttachmentRefusal): string {
  switch (p.reason) {
    case 'type': return `«${p.name}»: nur Bilder (PNG, JPG, HEIC, GIF, WebP) und PDF.`;
    case 'empty': return `«${p.name}» ist leer.`;
    case 'size': return `«${p.name}» ist ${p.mb} MB gross, höchstens 20 MB.`;
    case 'gone': return `«${p.name}» ist nicht mehr da: noch einmal anhängen.`;
  }
}

/** The name as the person knows it, safe as one file name: no folders, no control or reserved characters, the type's extension. */
export function safeName(raw: string, type: AttachmentType): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const clean = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').trim();
  const ext = ATTACHMENT_TYPES[type];
  const stem = (clean.replace(/\.[^.]*$/, '') || 'datei').slice(0, 100);
  return `${stem}.${ext}`;
}

/** Whether the bytes are what the type says (the first bytes of each format), so a renamed file is not taken for one. */
function bytesAre(type: AttachmentType, b: Uint8Array): boolean {
  const ascii = (at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  switch (type) {
    case 'image/png': return b[0] === 0x89 && ascii(1, 'PNG');
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif': return ascii(0, 'GIF8');
    case 'image/webp': return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'image/heic': case 'image/heif': return ascii(4, 'ftyp');
    case 'application/pdf': return ascii(0, '%PDF');
  }
}

/** Keeps an upload until its message is sent. A HEIC photo is kept as a JPEG: the model reads that, not HEIC. */
export async function saveAttachment(ws: Ws, name: string, declared: string, bytes: Uint8Array): Promise<Attachment> {
  const refused = attachmentRefusal({ name, type: declared, size: bytes.length });
  if (refused) throw new AttachmentError(refused);
  let type = attachmentType({ name, type: declared })!;
  if (!bytesAre(type, bytes)) throw new AttachmentError({ code: 'attachment', params: { reason: 'type', name } });
  let data = bytes;
  if (type === 'image/heic' || type === 'image/heif') {
    try { data = await heicToJpeg(bytes); } catch { throw new AttachmentError({ code: 'attachment', params: { reason: 'type', name } }); }
    type = 'image/jpeg';
  }
  sweepPending(ws);
  const id = randomUUID();
  const file = safeName(name, type);
  const dir = join(root(ws), PENDING, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), data);
  return { id, name: file, type, size: data.length };
}

/** An upload taken off the composer before its message was sent. A sent one stays with its conversation. */
export function dropPending(ws: Ws, id: string): void {
  if (ID.test(id)) rmSync(join(root(ws), PENDING, id), { recursive: true, force: true });
}

/** Uploads whose message never went (the window closed or reloaded) go after a day. */
function sweepPending(ws: Ws, now = Date.now()): void {
  const dir = join(root(ws), PENDING);
  if (!existsSync(dir)) return;
  for (const id of readdirSync(dir)) if (now - statSync(join(dir, id)).mtimeMs > 86_400_000) dropPending(ws, id);
}

function read(dir: string, id: string): Attachment | undefined {
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((n) => !n.startsWith('.'));
  const type = name && attachmentType({ name, type: '' });
  return type ? { id, name, type, size: statSync(join(dir, name)).size } : undefined;
}

/** The uploads a message names, from the conversation's folder or still waiting; refused when one is gone. */
export function findAttachments(ws: Ws, ids: readonly string[], conversation: string | undefined): Attachment[] {
  return ids.map((id) => {
    const found = ID.test(id) ? (conversation && ID.test(conversation) && read(join(root(ws), conversation, id), id)) || read(join(root(ws), PENDING, id), id) : undefined;
    if (!found) throw new AttachmentError({ code: 'attachment', params: { reason: 'gone', name: id } });
    return found;
  });
}

/** Moves a message's uploads into its conversation's folder (again: a no-op) and returns each file's path. */
export function keepAttachments(ws: Ws, conversation: string, files: readonly Attachment[]): string[] {
  return files.map((a) => {
    const dir = join(root(ws), conversation, a.id);
    const waiting = join(root(ws), PENDING, a.id);
    if (!existsSync(dir) && existsSync(waiting)) {
      mkdirSync(join(root(ws), conversation), { recursive: true });
      renameSync(waiting, dir);
    }
    return join(dir, a.name);
  });
}

/** A sent attachment's file, for the sidebar's thumbnail and «Als Beleg übernehmen». */
export function attachmentFile(ws: Ws, conversation: string, id: string): { path: string; attachment: Attachment } | undefined {
  if (!ID.test(conversation) || !ID.test(id)) return undefined;
  const dir = join(root(ws), conversation, id);
  const attachment = read(dir, id);
  return attachment ? { path: join(dir, attachment.name), attachment } : undefined;
}

/** What the model is told about the files of a message: each by its path, which its Read tool opens. */
export function attachmentsNote(files: readonly Attachment[], paths: readonly string[]): string {
  return [
    'The person attached these files to this message. Read each with the Read tool before you answer (it shows images and PDFs).',
    'They are not in the books nor in the inbox: they are no receipts unless the person presses «Als Beleg übernehmen» on one.',
    ...files.map((a, i) => `- ${a.name}: ${paths[i]}`),
  ].join('\n');
}
