/**
 * The receipts' trash: each deletion of a receipt waits in data/trash/<id>/<deletion>/ for
 * TRASH_DAYS with its file and what the books held of it, so a restore (the toast's «Rückgängig»,
 * Änderungen) puts both back. The same file dropped and deleted again is another deletion; only
 * the latest one can come back. Beside it lies data/trash/entries/, the deleted bookings
 * (src/saving/changes.ts recordDeletion), which this module leaves alone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JournalEntry, Mapping, Receipt } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';

type Ws = Pick<Workspace, 'paths'>;

export interface Trashed {
  deletedAt: string; receipt: Receipt; mappings: Mapping[]; file: string;
  /** The entries the deletion took with it (a record from before this field has none). */
  entries?: JournalEntry[];
  /** The entries it kept (a person's) that named the receipt as seen: the restore names it there again. */
  named?: string[];
}

export const TRASH_DAYS = 30;
const ID = /^[\w-]+$/;

export const trashDir = (ws: Ws): string => join(ws.paths.data, 'trash');

/** The deletions of a receipt in the trash, oldest first (a deletion's name sorts by its time). */
export function deletionsOf(ws: Ws, id: string): string[] {
  const dir = join(trashDir(ws), id);
  return ID.test(id) && existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'trashed.json'))).sort() : [];
}

export const readTrashed = (ws: Ws, id: string, deletion: string): Trashed =>
  JSON.parse(readFileSync(join(trashDir(ws), id, deletion, 'trashed.json'), 'utf8')) as Trashed;

/** The file of a deletion as the trash holds it. */
export const trashedFile = (ws: Ws, id: string, deletion: string, t: Trashed): string => join(trashDir(ws), id, deletion, basename(t.file));

/** Records a deletion and moves the receipt's file into it; returns the deletion's name. */
export function trashReceipt(ws: Ws, trashed: Trashed, pdfPath: string): string {
  emptyOldTrash(ws);
  const deletion = `${trashed.deletedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 4)}`;
  const into = join(trashDir(ws), trashed.receipt.id, deletion);
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, 'trashed.json'), JSON.stringify(trashed, null, 2));
  if (existsSync(pdfPath)) renameSync(pdfPath, join(into, basename(pdfPath)));
  return deletion;
}

/** Once a receipt is back, the trash holds nothing of it any more. */
export const dropFromTrash = (ws: Ws, id: string): void => rmSync(join(trashDir(ws), id), { recursive: true, force: true });

/** The latest deletion of every receipt in the trash. */
export function latestDeletions(ws: Ws): Array<{ id: string; deletion: string; trashed: Trashed }> {
  const dir = trashDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => {
    const deletion = deletionsOf(ws, id).at(-1);
    return deletion ? [{ id, deletion, trashed: readTrashed(ws, id, deletion) }] : [];
  });
}

/** Deletions older than TRASH_DAYS go; a folder that held none (the deleted bookings) stays. */
export function emptyOldTrash(ws: Ws): void {
  const dir = trashDir(ws);
  if (!existsSync(dir)) return;
  const before = new Date(Date.now() - TRASH_DAYS * 864e5).toISOString();
  for (const id of readdirSync(dir)) {
    const had = deletionsOf(ws, id);
    for (const d of had) if (readTrashed(ws, id, d).deletedAt < before) rmSync(join(dir, id, d), { recursive: true, force: true });
    if (had.length && !deletionsOf(ws, id).length) rmSync(join(dir, id), { recursive: true, force: true });
  }
}
