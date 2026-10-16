/**
 * What the UI reads from a workspace besides books.json, as the API answers it
 * (src/server/routes/config.ts) and the static audit export writes it (src/cli/build-audit.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFiledReturn } from '../accounting/filed-return.js';
import { findFile, yearPaths, type Workspace } from './workspace.js';
import type { Receipt } from '../types/index.js';
import type { ReturnFigures } from '../engines/return.js';

/** Where a receipt's PDF lies: beleg-import/ until it is matched, a year folder's receipts/ after; undefined when no file holds it. */
export function receiptPathOf(ws: Workspace, receipt: Pick<Receipt, 'filename' | 'location'>): string | undefined {
  if (receipt.location !== 'staged') return findFile(ws.paths, 'receipts', receipt.filename);
  const path = join(ws.paths.inbox, receipt.filename);
  return existsSync(path) ? path : undefined;
}

export function accountsOf(ws: Workspace): unknown[] {
  return existsSync(ws.paths.accounts) ? JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) : [];
}

/** The VAT returns as filed with the ESTV (transactional-data/<year>/filings/), in quarter order. */
export function filedReturnsOf(ws: Workspace, year: string): ReturnFigures[] {
  const dir = yearPaths(ws.paths, year).filings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^mwst-ech0217-\d{4}-(?:Q[1-4]|H[12])\.xml$/.test(f))
    .sort()
    .map((f) => parseFiledReturn(readFileSync(join(dir, f), 'utf8')));
}
