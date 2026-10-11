/**
 * The one owner of invoices.json and the invoice PDFs: load (with the schema ladder of
 * src/workspace/schema.ts), save atomically, write a PDF once. The layout of the workspace:
 *
 *   invoices.json               customers, invoices (drafts and issued), sent documents
 *   invoices/<number>.pdf       an issued invoice or credit note, as issued
 *   invoices/sent/<id>.pdf      a reminder or cancellation notice, as sent
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { versionOf, wrote } from '../workspace/own-writes.js';
import type { Workspace } from '../workspace/workspace.js';
import { INVOICES_MIGRATIONS, INVOICES_SCHEMA, climb, schemaOf } from '../workspace/schema.js';
import type { Envelope, InvoiceBook } from './model.js';

export const emptyInvoiceBook = (): InvoiceBook => ({ schema: INVOICES_SCHEMA, customers: [], invoices: [], sent: [] });

export function loadInvoices(ws: Pick<Workspace, 'paths'>): InvoiceBook {
  const path = ws.paths.invoices;
  if (!existsSync(path)) return emptyInvoiceBook();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const current = climb<Record<string, unknown>>(raw, schemaOf(raw.schema, path), INVOICES_SCHEMA, INVOICES_MIGRATIONS, path, (d) => structuredClone(d));
  return { ...emptyInvoiceBook(), ...current, schema: INVOICES_SCHEMA } as InvoiceBook;
}

/** Write to a temp file beside the target, then rename: a crash never leaves half a file. */
export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
  wrote(path, versionOf(data));
}

export function saveInvoices(ws: Pick<Workspace, 'paths'>, book: InvoiceBook): void {
  const { schema: _, ...rest } = book;
  writeAtomic(ws.paths.invoices, JSON.stringify({ schema: INVOICES_SCHEMA, ...rest }, null, 2) + '\n');
}

/** Load, change, save; nothing is saved when `fn` throws. */
export function updateInvoices<T>(ws: Pick<Workspace, 'paths'>, fn: (book: InvoiceBook) => T): T {
  const book = loadInvoices(ws);
  const result = fn(book);
  saveInvoices(ws, book);
  return result;
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Stores a document's PDF under invoices/ and returns its path relative to the workspace and its
 * checksum. A file once written is never replaced: the same bytes again are fine, other bytes refused.
 */
export function storePdf(ws: Pick<Workspace, 'paths'>, name: string, pdf: Buffer): { file: string; sha256: string } {
  const path = join(ws.paths.invoiceFiles, name);
  if (existsSync(path) && !readFileSync(path).equals(pdf)) throw new Error(`${relative(ws.paths.root, path)} exists with other content; a sent document is never replaced.`);
  if (!existsSync(path)) writeAtomic(path, pdf);
  return { file: relative(ws.paths.root, path), sha256: sha256(pdf) };
}

/** The stored PDF, checked against its checksum. */
export function readPdf(ws: Pick<Workspace, 'paths'>, doc: { file: string; sha256: string }): Buffer {
  const bytes = readFileSync(join(ws.paths.root, doc.file));
  if (sha256(bytes) !== doc.sha256) throw new Error(`${doc.file}: the file no longer matches its checksum (${doc.sha256.slice(0, 12)}…).`);
  return bytes;
}

/** Where random ids come from; the demo generator seeds it so the same seed gives the same files. */
export const idSource = { bytes: (n: number): Buffer => randomBytes(n) };

/** ADR 0004: a random id (never sequential, so two clones cannot collide), the creation time, the origin. */
export function newEnvelope(prefix: 'cu' | 'in' | 'sd' | 'co', now = new Date().toISOString(), origin: Envelope['origin'] = 'manual'): Envelope {
  return { id: `${prefix}_${idSource.bytes(9).toString('base64url')}`, createdAt: now, origin, deleted: false };
}
