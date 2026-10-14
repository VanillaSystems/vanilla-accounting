/**
 * Reads a workflow folder (docs/0.4.0/workflows.md): workflow.yaml and one step.yaml per step.
 * The runner and the lint use the same parsed form, so the graph that is drawn is the one that runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ACTIONS } from './actions.js';

/** Where an outcome leads: the next step, the end, or a person (the run waits for them). */
export type Target = string | 'done' | 'wait';

export interface Step {
  id: string;
  label: string;
  uses: string;
  reads: string[];
  emits: string[];
  effects: string[];
  outcomes: Record<string, Target>;
  guide?: string;
}

export interface Workflow {
  id: string;
  label: string;
  /** The kind of item one run is for. */
  for: string;
  on: { manual?: { label: string }; event?: { name: string; off?: boolean } };
  emits: string[];
  start: string;
  steps: Record<string, Step>;
  /** sha256 of the declarations: a run records the version it ran on. */
  version: string;
}

export class WorkflowError extends Error {}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function loadWorkflow(root: string, id: string): Workflow {
  const dir = join(root, 'workflows', id);
  const fail = (msg: string): never => { throw new WorkflowError(`workflows/${id}: ${msg}`); };
  if (!existsSync(join(dir, 'workflow.yaml'))) fail('no workflow.yaml');
  const sources: string[] = [readFileSync(join(dir, 'workflow.yaml'), 'utf8')];
  const w = parse(sources[0]) as Record<string, unknown>;
  const stepIds = list(w.steps);
  const steps: Record<string, Step> = {};
  for (const sid of stepIds) {
    const file = join(dir, sid, 'step.yaml');
    if (!existsSync(file)) fail(`step ${sid} has no step.yaml`);
    const text = readFileSync(file, 'utf8');
    sources.push(text);
    const s = parse(text) as Record<string, unknown>;
    steps[sid] = {
      id: sid,
      label: String(s.label ?? sid),
      uses: String(s.uses ?? fail(`${sid}/step.yaml: uses missing`)),
      reads: list(s.reads),
      emits: list(s.emits),
      effects: list(s.effects),
      outcomes: (s.outcomes ?? fail(`${sid}/step.yaml: outcomes missing`)) as Record<string, Target>,
      ...(s.guide ? { guide: String(s.guide) } : {}),
    };
  }
  const workflow: Workflow = {
    id,
    label: String(w.label ?? id),
    for: String(w.for ?? fail('for missing')),
    on: (w.on ?? {}) as Workflow['on'],
    emits: list(w.emits),
    start: String(w.start ?? stepIds[0]),
    steps,
    version: createHash('sha256').update(sources.join('\n---\n')).digest('hex').slice(0, 16),
  };
  const problems = checkWorkflow(workflow);
  if (problems.length) fail(problems.join('; '));
  return workflow;
}

/** The rules of docs/0.4.0/workflows.md the declarations alone can break. */
export function checkWorkflow(w: Workflow): string[] {
  const out: string[] = [];
  if (!w.steps[w.start]) out.push(`start "${w.start}" is not a step`);
  const ids = Object.keys(w.steps);
  if (ids.length > 9) out.push(`${ids.length} steps on one level: at most nine, group the rest`);
  for (const s of Object.values(w.steps)) {
    const action = ACTIONS[s.uses];
    if (!action) { out.push(`${s.id}: action "${s.uses}" is not registered`); continue; }
    for (const [outcome, target] of Object.entries(s.outcomes)) {
      if (target !== 'done' && target !== 'wait' && !w.steps[target]) out.push(`${s.id}: outcome ${outcome} leads to "${target}", no such step`);
      if (!action.outcomes.includes(outcome)) out.push(`${s.id}: ${s.uses} never returns outcome ${outcome}`);
    }
    for (const outcome of action.outcomes) if (!(outcome in s.outcomes)) out.push(`${s.id}: outcome ${outcome} of ${s.uses} leads nowhere`);
    for (const e of action.effects) if (!s.effects.includes(e)) out.push(`${s.id}: ${s.uses} needs effect ${e}, not declared`);
  }
  return out;
}
