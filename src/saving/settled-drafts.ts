/**
 * How each rules draft ended, kept on this computer (data/draft-settled.json, outside git): the
 * card's «Behalten» or «Verwerfen», by the draft's path, with when. The AI sidebar reads it to tell
 * the model, as a fact from code, what became of a rule it drafted earlier in a conversation
 * (src/assistant/proposals.ts): a draft that is gone can be kept or discarded, and only this says which.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';

export type DraftOutcome = { state: 'kept' | 'discarded'; at: string };

const fileOf = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.data, 'draft-settled.json');

export function settledDrafts(ws: Pick<Workspace, 'paths'>): Record<string, DraftOutcome> {
  try { return JSON.parse(readFileSync(fileOf(ws), 'utf8')) as Record<string, DraftOutcome>; } catch { return {}; }
}

export function recordSettled(ws: Pick<Workspace, 'paths'>, path: string, state: DraftOutcome['state'], at = new Date().toISOString()): void {
  const all = settledDrafts(ws);
  all[path] = { state, at };
  mkdirSync(ws.paths.data, { recursive: true });
  writeFileSync(fileOf(ws), JSON.stringify(all, null, 2) + '\n');
}
