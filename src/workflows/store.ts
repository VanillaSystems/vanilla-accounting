/**
 * Where runs live (decisions.md, D3): a local store outside the workspace, one JSON file per run.
 * Runs hold private inputs and grow fast, so they stay out of the workspace's Git; the books hold
 * no run ids yet, and a run lists the entries it booked.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Run } from './runner.js';

/** VANILLA_RUNS_DIR, else the user's application data, one folder per workspace path. */
export function runsDir(ws: Workspace): string {
  const base = process.env.VANILLA_RUNS_DIR
    ?? (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Vanilla Accounting', 'runs') : join(homedir(), '.local', 'state', 'vanilla-accounting', 'runs'));
  return join(base, createHash('sha256').update(ws.paths.root).digest('hex').slice(0, 16));
}

export function saveRun(ws: Workspace, run: Run): string {
  const dir = runsDir(ws);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(run, null, 2));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadRun(ws: Workspace, id: string): Run {
  const path = join(runsDir(ws), `${id}.json`);
  if (!existsSync(path)) throw new Error(`no run ${id} in ${runsDir(ws)}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Run;
}

/** Every stored run, oldest first. */
export function listRuns(ws: Workspace): Run[] {
  const dir = runsDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Run)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
