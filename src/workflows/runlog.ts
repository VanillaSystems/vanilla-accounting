/**
 * The run log (docs/0.4.0/ui/design.md, "Runs, in two tiers"): the short history of every run that
 * mattered, failures included, in git beside the books, so a cloud instance and the owner's Mac
 * see the same history. One file per fiscal year, transactional-data/<year>/runs.jsonl,
 * append-only, one line per event. Three rules keep it small:
 *   1. only a run that wrote something, waited for a person, got stuck or was discarded leaves lines;
 *   2. a line is appended, never rewritten;
 *   3. no detail: inputs, prompts and answers stay in the run store, with its retention.
 * A closed year's file is never written again: an event after the close goes to the open year.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';
import type { ItemRef, Run } from './model.js';

export interface RunLogLine {
  run: string;
  workflow: string;
  version: string;
  item: ItemRef;
  at: string;
  event: 'done' | 'waiting' | 'stuck' | 'discarded';
  /** The step it waits at or stuck at. */
  step?: string;
  reason?: string;
  /** Record ids written since the run's previous line. */
  wrote?: { entries?: string[]; mappings?: string[]; receipts?: string[] };
  host: 'local' | 'cloud';
}

/** The line a run that came to rest adds, or none when it changed nothing and needed nobody. `logged` is how many step records earlier lines covered. */
export function lineFor(run: Run, logged: number, host: RunLogLine['host'] = 'local'): RunLogLine | undefined {
  if (run.mode !== 'live') return undefined;
  const s = run.state;
  if (s.status !== 'done' && s.status !== 'waiting' && s.status !== 'stuck' && s.status !== 'discarded') return undefined;
  const fresh = run.steps.slice(logged);
  const wrote: Record<string, string[]> = {};
  for (const step of fresh) for (const e of step.effects) {
    if (!e.applied) continue;
    for (const [part, ids] of Object.entries(e.wrote)) wrote[part] = [...(wrote[part] ?? []), ...(ids ?? [])];
  }
  const wroteSomething = Object.values(wrote).some((ids) => ids.length);
  // Rule 1: a run that finished without writing, and never needed anyone before, leaves no line.
  if (!wroteSomething && s.status === 'done' && logged === 0) return undefined;
  return {
    run: run.id, workflow: run.workflow, version: run.version, item: run.item,
    at: s.status === 'done' ? s.finishedAt : s.status === 'discarded' ? s.at : s.since,
    event: s.status,
    ...(s.status === 'waiting' || s.status === 'stuck' ? { step: s.at } : {}),
    ...(s.status === 'stuck' || s.status === 'discarded' ? { reason: s.reason } : {}),
    ...(wroteSomething ? { wrote: wrote as NonNullable<RunLogLine['wrote']> } : {}),
    host,
  };
}

/** The year file an event goes to: its own year, or the first open year after it. */
export function logYear(at: string, closedThrough: string | undefined): string {
  let year = Number(at.slice(0, 4));
  while (closedThrough && closedThrough >= `${year}-12-31`) year++;
  return String(year);
}

/** Appends `line` to its year's runs.jsonl and returns the file it wrote. */
export function appendLine(ws: Pick<Workspace, 'paths'>, line: RunLogLine, closedThrough: string | undefined): string {
  const path = yearPaths(ws.paths, logYear(line.at, closedThrough)).runLog;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  return path;
}

/** Every line of every year, oldest first: the history that survives the run store's retention. */
export function readLog(ws: Pick<Workspace, 'paths'>): RunLogLine[] {
  return yearsOf(ws.paths).flatMap((y) => {
    const path = yearPaths(ws.paths, y).runLog;
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunLogLine) : [];
  });
}
