/**
 * A staged receipt's file leaves beleg-import/ for its year's receipts/ once the books have a place
 * for it: when the model's match step names it (src/intake/match.ts), or when a person links it by
 * hand (src/server/routes/mappings.ts, r9n-26). Only an archived file is part of the books a save commits.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Receipt } from '../types/index.js';
import { findFile, type Workspace } from '../workspace/workspace.js';
import { moveOnSave, pendingMoves, receiptHome, type Books } from './store.js';

/** `desiredName`, or with -2, -3, … when a year folder already holds that name. */
export function resolveCollision(desiredName: string, taken: (name: string) => boolean): string {
  if (!taken(desiredName)) return desiredName;
  const base = desiredName.replace(/\.pdf$/i, '');
  let i = 2;
  while (taken(`${base}-${i}.pdf`)) i++;
  return `${base}-${i}.pdf`;
}

/**
 * Marks the staged `receipt` archived under `desired` (its own name by default, -2 on a collision),
 * in the same synchronous change as the caller's; its file moves into its year's receipts/ with the
 * save that writes the change (moveOnSave). Returns the file name, or undefined when the receipt is
 * not staged or its file is gone.
 */
export function archiveReceipt(ws: Workspace, books: Books, receipt: Receipt, desired = receipt.filename): string | undefined {
  const srcPath = join(ws.paths.inbox, receipt.filename);
  if (receipt.location !== 'staged' || !existsSync(srcPath)) return undefined;
  const pending = new Set(pendingMoves(books).map((to) => basename(to)));
  const target = resolveCollision(desired, (name) => pending.has(name) || !!findFile(ws.paths, 'receipts', name));
  Object.assign(receipt, { filename: target, location: 'archived' });
  moveOnSave(books, srcPath, join(receiptHome(ws, books, receipt), target));
  return target;
}
