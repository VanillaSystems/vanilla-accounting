/**
 * What the app keeps of the setup cards beside the books (src/payroll/setup-documents.ts): the AI's reading of a
 * document, once asked, and a card kept or set aside, by receipt id, in the workspace's data/payroll-setup.json. It
 * changes no figure: payroll.json holds what the person kept.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { writeAtomic } from '../invoices/store.js';
import type { SetupState } from './setup-documents.js';

export const SETUP_FILE = 'payroll-setup.json';
const fileOf = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.data, SETUP_FILE);

export function loadSetupState(ws: Pick<Workspace, 'paths'>): SetupState {
  const f = fileOf(ws);
  if (!existsSync(f)) return {};
  try { const v = JSON.parse(readFileSync(f, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v as SetupState : {}; } catch { return {}; }
}

export function updateSetupState(ws: Pick<Workspace, 'paths'>, fn: (s: SetupState) => void): SetupState {
  const s = loadSetupState(ws);
  fn(s);
  mkdirSync(ws.paths.data, { recursive: true });
  writeAtomic(fileOf(ws), JSON.stringify(s, null, 2) + '\n');
  return s;
}
