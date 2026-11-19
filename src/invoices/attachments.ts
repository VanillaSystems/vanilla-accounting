/**
 * The PDFs that go with documents (docs/specs/invoicing.md 4.4.11): a Vorlage's letterhead and fixed
 * attachment (the firm's terms), a document's own (a Rapport). Each is stored once under
 * invoices/files/ of the year it came in, named by its checksum, and never replaced: the same bytes
 * again are the same file, so a Vorlage changed later never changes what a document went out with.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Workspace } from '../workspace/workspace.js';
import type { Attachment } from './model.js';
import { InvoiceRuleError } from './rules.js';
import { readPdf, sha256, storePdf } from './store.js';

/** At most this many own attachments per document, and this many bytes per file; each named when hit. */
export const ATTACHMENT_LIMIT = { count: 10, bytes: 10 * 1024 * 1024 } as const;

const FILE = /^transactional-data\/\d{4}\/invoices\/files\/[0-9a-f]{12}-[^/\\]+\.pdf$/;

/** A file name as a person sees it, safe on every file system: «Rapport März.pdf» → «Rapport-März.pdf». */
export function safeName(name: string): string {
  const base = name.replace(/\.pdf$/i, '').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Anhang';
  return `${base}.pdf`;
}

/** Stores a PDF a person gave (refused when it is no PDF or too large) and says where it lies. */
export function storeAttachment(ws: Pick<Workspace, 'paths'>, name: string, bytes: Buffer, today: string): Attachment {
  if (bytes.length > ATTACHMENT_LIMIT.bytes) throw new InvoiceRuleError('attachmentTooLarge', `${name}: ${Math.ceil(bytes.length / 1024 / 1024)} MB, höchstens ${ATTACHMENT_LIMIT.bytes / 1024 / 1024} MB pro Anhang.`, undefined, { name, limit: String(ATTACHMENT_LIMIT.bytes / 1024 / 1024) });
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new InvoiceRuleError('attachmentNotPdf', `${name} ist kein PDF.`, undefined, { name });
  const sum = sha256(bytes);
  const file = safeName(name);
  const stored = storePdf(ws, today.slice(0, 4), `files/${sum.slice(0, 12)}-${file}`, bytes);
  return { name: file, ...stored };
}

/** Whether `a` is an attachment as storeAttachment gave it: a file under invoices/files/, with a checksum. */
export function isAttachment(a: unknown): a is Attachment {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.name === 'string' && !!x.name.trim() && typeof x.file === 'string' && FILE.test(x.file) && typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256);
}

/** Whether a Vorlage may name `file` (a letterhead, a fixed attachment): one storeAttachment wrote. */
export const isStoredFile = (ws: Pick<Workspace, 'paths'>, file: string): boolean => FILE.test(file) && existsSync(join(ws.paths.root, file));

/** A Vorlage's file as an attachment with its checksum now: what an issued document freezes. */
export function frozen(ws: Pick<Workspace, 'paths'>, name: string, file: string): Attachment {
  const path = join(ws.paths.root, file);
  if (!existsSync(path)) throw new InvoiceRuleError('attachmentGone', `${file} fehlt: die Vorlage nennt eine Datei, die es nicht mehr gibt.`, undefined, { file });
  return { name, file, sha256: sha256(readFileSync(path)) };
}

/** The bytes of each attachment, checked against its checksum, as they go out. */
export const attachmentBytes = (ws: Pick<Workspace, 'paths'>, list: readonly Attachment[] | undefined): Array<{ filename: string; content: Buffer }> =>
  (list ?? []).map((a) => ({ filename: a.name, content: readPdf(ws, a) }));

/**
 * The printed PDF laid on the letterhead: the letterhead's first page under every page, the
 * document's sheets (see-through on a letterhead, src/invoices/sheet.ts) on top. The dates are the
 * document's own, so the same print gives the same bytes.
 */
export async function onLetterhead(content: Buffer, letterhead: Buffer, at: string): Promise<Buffer> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const [paper] = await out.embedPdf(letterhead, [0]);
  const src = await PDFDocument.load(content, { updateMetadata: false });
  const pages = await out.embedPdf(content, src.getPageIndices());
  for (const p of pages) {
    const page = out.addPage([p.width, p.height]);
    page.drawPage(paper, { x: 0, y: 0, width: p.width, height: p.height });
    page.drawPage(p, { x: 0, y: 0 });
  }
  const when = new Date(at);
  out.setCreationDate(when);
  out.setModificationDate(when);
  out.setProducer('Vanilla Accounting');
  out.setTitle(src.getTitle() ?? '');
  return Buffer.from(await out.save({ useObjectStreams: false }));
}
