/**
 * What the UI reads from a workspace besides books.json, as the API answers it
 * (src/server/routes/config.ts) and the static audit export writes it (src/cli/build-audit.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFiledReturn } from '../accounting/filed-return.js';
import type { ReturnFigures } from '../accounting/return-figures.js';
import type { Workspace } from './workspace.js';

/** Where a receipt's PDF lies: beleg-import/ until it is matched, receipts/ after. */
export function receiptDirOf(ws: Workspace, location?: string): string {
  return location === 'staged' ? ws.paths.inbox : ws.paths.receipts;
}

export function accountsOf(ws: Workspace): unknown[] {
  return existsSync(ws.paths.accounts) ? JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) : [];
}

/** The VAT returns as filed with the ESTV (filings/<year>/), in quarter order. */
export function filedReturnsOf(ws: Workspace, year: string): ReturnFigures[] {
  const dir = join(ws.paths.filings, year);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^mwst-ech0217-\d{4}-Q[1-4]\.xml$/.test(f))
    .sort()
    .map((f) => parseFiledReturn(readFileSync(join(dir, f), 'utf8')));
}

/** Who the company is and which ledger account each bank books on (belege.workspace.yaml). */
export const workspaceInfo = (ws: Workspace): Pick<Workspace, 'company' | 'bankAccounts'> => ({
  company: ws.company,
  bankAccounts: ws.bankAccounts,
});
