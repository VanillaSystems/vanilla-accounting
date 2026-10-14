/**
 * Where a run's detail lives (docs/0.4.0/ui/design.md, "Runs, in two tiers"): one JSON per run in
 * the user's application data, outside the workspace and its git, saved after every step. The
 * short history that travels with the books is the run log (runlog.ts). A run saved by the
 * 0.4.0 pilot (status, no state) is read as a run of today's shape.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { EffectRecord, Run, RunState, StepRecord } from './model.js';

/** VANILLA_RUNS_DIR, else the user's application data, one folder per workspace path. */
export function runsDir(ws: Pick<Workspace, 'paths'>): string {
  const base = process.env.VANILLA_RUNS_DIR
    ?? (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Vanilla Accounting', 'runs') : join(homedir(), '.local', 'state', 'vanilla-accounting', 'runs'));
  return join(base, createHash('sha256').update(ws.paths.root).digest('hex').slice(0, 16));
}

export function saveRun(ws: Pick<Workspace, 'paths'>, run: Run): void {
  const dir = runsDir(ws);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(run, null, 2));
  renameSync(`${path}.tmp`, path);
}

export function loadRun(ws: Pick<Workspace, 'paths'>, id: string): Run | undefined {
  const path = join(runsDir(ws), `${id}.json`);
  return existsSync(path) ? fromDisk(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

/** Every stored run, oldest first. */
export function listRuns(ws: Pick<Workspace, 'paths'>): Run[] {
  const dir = runsDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => fromDisk(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

interface PilotRun {
  id: string; workflow: string; version: string; item: { kind: 'transaction'; ref: string }; mode: 'live' | 'replay'; of?: string;
  startedAt: string; finishedAt: string; status: 'done' | 'waiting' | 'stuck';
  steps: Array<{ step: string; outcome?: string; output?: Record<string, unknown>; llm: Array<{ promptSha: string; answer: string }>; effects: Array<{ effect: string; key: string; applied: boolean; value: unknown }>; error?: string }>;
}

/** Today's run, or a pilot run read as one: its last step is where it waits or stuck. */
function fromDisk(raw: Run | PilotRun): Run {
  if ('schema' in raw && raw.schema === 2) return raw;
  const r = raw as PilotRun;
  const last = r.steps.at(-1)?.step ?? 'open';
  const state: RunState = r.status === 'done' ? { status: 'done', finishedAt: r.finishedAt }
    : r.status === 'waiting' ? { status: 'waiting', at: last, since: r.finishedAt }
    : { status: 'stuck', at: last, since: r.finishedAt, reason: r.steps.at(-1)?.error ?? 'no outcome led on' };
  const steps: StepRecord[] = r.steps.map((s) => ({
    step: s.step, startedAt: r.startedAt, input: {}, llm: s.llm,
    ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.output ? { output: s.output } : {}), ...(s.error ? { error: s.error } : {}),
    effects: s.effects.map((e): EffectRecord => (e.applied
      ? { effect: e.effect, key: e.key, applied: true, wrote: { entries: e.value as string[] } }
      : { effect: e.effect, key: e.key, applied: false, wrote: {}, would: e.value })),
  }));
  return {
    schema: 2, id: r.id, workflow: r.workflow, version: r.version, item: { kind: 'transaction', id: r.item.ref },
    mode: r.mode, startedBy: r.of ? { kind: 'replay', of: r.of } : { kind: 'manual' }, startedAt: r.startedAt, state, steps,
  };
}
