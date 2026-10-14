/**
 * Reads the workflow declarations (docs/0.4.0/ui/design.md): the app's workflows/<id>/ with its
 * workflow.yaml and one <step>/step.yaml per step, and the company's workflows/ in the workspace,
 * merged onto the app's per step and per field (or a workflow of its own). The runner, the lint,
 * the server and the screens all read this one parsed form, so the graph that is drawn is the one
 * that runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { mergeOverlay } from '../core/modules/load.js';
import { ACTIONS } from './actions.js';
import {
  ITEM_FACTS, ITEM_KINDS, PHASES, RESERVED_WORKFLOW_IDS, STEP_CAP,
  type ItemFact, type ItemKind, type Phase, type StepBody, type StepDecl, type StepKind, type Target, type TaskDecl, type Text, type Trigger, type WorkflowDecl,
} from './model.js';

export class WorkflowError extends Error {}

export interface Loaded {
  workflows: WorkflowDecl[];
  /** Declarations that do not load, by workflow: the workflow is left out and the reason shown. */
  problems: Array<{ workflow: string; message: string }>;
  /** Readability notes that do not stop a workflow, such as more steps on one level than the cap. */
  warnings: Array<{ workflow: string; message: string }>;
}

type Raw = Record<string, unknown>;

const readYaml = (path: string): Raw | undefined => (existsSync(path) ? (parse(readFileSync(path, 'utf8')) ?? {}) as Raw : undefined);
const folders = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort() : []);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Every workflow the app ships, with the company's overlays and own workflows from `workspaceRoot`. */
export function loadWorkflows(appRoot: string, workspaceRoot?: string): Loaded {
  const appDir = join(appRoot, 'workflows');
  const companyDir = workspaceRoot ? join(workspaceRoot, 'workflows') : undefined;
  const ids = [...new Set([...folders(appDir), ...(companyDir ? folders(companyDir) : [])])];
  const out: Loaded = { workflows: [], problems: [], warnings: [] };
  const parsed: WorkflowDecl[] = [];
  for (const id of ids) {
    try {
      parsed.push(readWorkflow(id, existsSync(join(appDir, id)) ? join(appDir, id) : undefined, companyDir && existsSync(join(companyDir, id)) ? join(companyDir, id) : undefined));
    } catch (e) {
      out.problems.push({ workflow: id, message: (e as Error).message });
    }
  }
  for (const w of parsed) {
    const problems = checkWorkflow(w, parsed);
    if (problems.length) out.problems.push(...problems.map((message) => ({ workflow: w.id, message })));
    else out.workflows.push(w);
    if (w.steps.length > STEP_CAP) out.warnings.push({ workflow: w.id, message: `${w.steps.length} steps on one level, more than ${STEP_CAP}: group some into a step that calls a workflow of its own` });
  }
  const byId = new Map(out.workflows.map((w) => [w.id, w]));
  for (const w of out.workflows) w.runnable = runnableOf(w, byId, new Set());
  return out;
}

/** One workflow, for the runner and the CLI: throws with every reason it does not load. */
export function loadWorkflow(appRoot: string, id: string, workspaceRoot?: string): WorkflowDecl {
  const loaded = loadWorkflows(appRoot, workspaceRoot);
  const mine = loaded.problems.filter((p) => p.workflow === id);
  if (mine.length) throw new WorkflowError(`workflows/${id}: ${mine.map((p) => p.message).join('; ')}`);
  const w = loaded.workflows.find((x) => x.id === id);
  if (!w) throw new WorkflowError(`workflows/${id}: no workflow.yaml`);
  return w;
}

function readWorkflow(id: string, appDir: string | undefined, companyDir: string | undefined): WorkflowDecl {
  const fail = (msg: string): never => { throw new WorkflowError(msg); };
  if ((RESERVED_WORKFLOW_IDS as readonly string[]).includes(id)) fail(`"${id}" names a page of Automatisierung; choose another folder name`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`"${id}": a workflow folder is lower case letters, digits and dashes`);
  const sources: string[] = [];
  const merged = (dir: string, file: string): Raw | undefined => {
    const app = appDir ? readYaml(join(appDir, dir, file)) : undefined;
    const own = companyDir ? readYaml(join(companyDir, dir, file)) : undefined;
    for (const d of [appDir, companyDir]) if (d && existsSync(join(d, dir, file))) sources.push(readFileSync(join(d, dir, file), 'utf8'));
    return app === undefined ? own : mergeOverlay(app, own);
  };
  const w = merged('', 'workflow.yaml') ?? fail('no workflow.yaml');
  const stepIds = list(w.steps);
  if (!stepIds.length) fail('steps: the list of step folders is empty');
  const steps = stepIds.map((sid) => readStep(sid, merged(sid, 'step.yaml') ?? fail(`step ${sid} has no step.yaml`)));
  const phase = String(w.phase ?? fail('phase missing'));
  if (!(PHASES as readonly string[]).includes(phase)) fail(`phase "${phase}" is none of ${PHASES.join(', ')}`);
  const forKind = String(w.for ?? fail('for missing'));
  if (!(ITEM_KINDS as readonly string[]).includes(forKind)) fail(`for "${forKind}" is none of ${ITEM_KINDS.join(', ')}`);
  return {
    id,
    label: text(w.label, 'label'),
    desc: text(w.desc ?? { en: '' }, 'desc'),
    phase: phase as Phase,
    cadence: text(w.cadence ?? { en: '' }, 'cadence'),
    for: forKind as ItemKind,
    triggers: (Array.isArray(w.triggers) ? w.triggers : []).map((t) => trigger(t as Raw)),
    emits: list(w.emits),
    start: String(w.start ?? stepIds[0]),
    steps,
    ...(w.guide ? { guide: String(w.guide) } : {}),
    ...(w.lane === 'account' ? { lane: 'account' as const } : {}),
    ...(w.deadline ? { deadline: String(w.deadline) } : {}),
    version: createHash('sha256').update(sources.join('\n---\n')).digest('hex').slice(0, 16),
    origin: !appDir ? 'company' : companyDir ? 'overlaid' : 'app',
    runnable: { ok: true },
  };
}

function readStep(id: string, s: Raw): StepDecl {
  const fail = (msg: string): never => { throw new WorkflowError(`${id}/step.yaml: ${msg}`); };
  const body = bodyOf(s, fail);
  const effects = list(s.effects);
  const outcomes: Record<string, Target> = {};
  for (const [outcome, to] of Object.entries((s.outcomes ?? fail('outcomes missing')) as Raw)) {
    outcomes[outcome] = to === 'done' ? { to: 'end' } : { to: 'step', step: String(to) };
  }
  return {
    id,
    label: text(s.label ?? { en: id }, `${id}/step.yaml label`),
    body,
    kind: kindOf(body, effects, Object.keys(outcomes)),
    reads: list(s.reads),
    emits: list(s.emits),
    effects,
    outcomes,
    ...(s.guide ? { guide: String(s.guide) } : {}),
    knowledge: list(s.knowledge),
    ...(s['for-each'] ? { forEach: String(s['for-each']) } : {}),
    ...(s.retry ? { retry: s.retry as StepDecl['retry'] } : {}),
  };
}

function bodyOf(s: Raw, fail: (msg: string) => never): StepBody {
  const bodies: StepBody[] = [];
  if (s.uses) bodies.push({ kind: 'action', uses: String(s.uses) });
  if (s.run) bodies.push({ kind: 'code', file: 'run.ts' });
  if (s.by === 'person') bodies.push({ kind: 'person', task: task(s.task ?? fail('a person step needs a task'), fail) });
  if (s.calls) bodies.push({ kind: 'call', workflow: String(s.calls) });
  if (s.wait) {
    const w = s.wait as Raw;
    const timeout = w.timeout as Raw | undefined;
    bodies.push({ kind: 'wait', for: String(w.for), ...(timeout ? { timeout: { after: String(timeout.after), outcome: String(timeout.outcome) } } : {}) });
  }
  if (bodies.length !== 1) fail(bodies.length ? 'a step does exactly one of uses, run, by: person, calls, wait' : 'say what the step does: uses, run, by: person, calls or wait');
  return bodies[0];
}

function task(t: unknown, fail: (msg: string) => never): TaskDecl {
  const r = t as Raw;
  return {
    title: text(r.title ?? fail('task.title missing'), 'task.title'),
    ...(r.why ? { why: text(r.why, 'task.why') } : {}),
    ...(r.do ? { do: r.do as TaskDecl['do'] } : {}),
    ...(r.due ? { due: String(r.due) } : {}),
  };
}

/** The graph's kind of a step, from its body and its action: never chosen by hand. */
function kindOf(body: StepBody, effects: string[], outcomes: string[]): StepKind {
  switch (body.kind) {
    case 'person': return 'human';
    case 'call': return 'call';
    case 'wait': return 'wait';
    case 'code': return 'decision';
    case 'action': {
      if (ACTIONS[body.uses]?.ai) return 'agent';
      if (effects.length) return 'effect';
      return outcomes.length > 1 ? 'decision' : 'step';
    }
  }
}

function trigger(t: Raw): Trigger {
  const fail = (msg: string): never => { throw new WorkflowError(msg); };
  const [kind, v] = Object.entries(t)[0] ?? [];
  const o = (v ?? {}) as Raw;
  const off = o.off === true ? { off: true } : {};
  switch (kind) {
    case 'manual': {
      const when = o.when === undefined ? {} : (ITEM_FACTS as readonly string[]).includes(String(o.when)) ? { when: String(o.when) as ItemFact } : fail(`manual trigger: when "${o.when}" is none of ${ITEM_FACTS.join(', ')}`);
      return { kind: 'manual', for: String(o.for) as ItemKind, label: text(o.label, 'manual trigger label'), ...when, ...off };
    }
    case 'event': return { kind: 'event', name: String(o.name), ...off };
    case 'schedule': return { kind: 'schedule', cron: String(o.cron), ...off };
    case 'outside': return { kind: 'outside', accepts: list(o.accepts) as Array<'receipt' | 'statement'>, ...off };
    default: throw new WorkflowError(`trigger "${kind}" is none of manual, event, schedule, outside`);
  }
}

function text(v: unknown, where: string): Text {
  if (typeof v === 'string') return { en: v };
  const t = v as Raw;
  if (!t || typeof t.en !== 'string') throw new WorkflowError(`${where}: a text needs at least "en"`);
  return t as Text;
}

/** The rules of docs/0.4.0/workflows.md that the declarations alone can break. */
export function checkWorkflow(w: WorkflowDecl, all: readonly WorkflowDecl[]): string[] {
  const out: string[] = [];
  const ids = new Set(w.steps.map((s) => s.id));
  if (!ids.has(w.start)) out.push(`start "${w.start}" is not a step`);
  for (const s of w.steps) {
    for (const [outcome, t] of Object.entries(s.outcomes)) {
      if (t.to === 'step' && !ids.has(t.step)) out.push(`${s.id}: outcome ${outcome} leads to "${t.step}", no such step`);
    }
    const body = s.body;
    if (body.kind === 'call' && !all.some((x) => x.id === body.workflow)) out.push(`${s.id}: calls "${body.workflow}", no such workflow`);
    if (body.kind !== 'action') continue;
    const action = ACTIONS[body.uses];
    if (!action) { out.push(`${s.id}: action "${body.uses}" is not registered`); continue; }
    for (const outcome of Object.keys(s.outcomes)) if (!action.outcomes.includes(outcome)) out.push(`${s.id}: ${body.uses} never returns outcome ${outcome}`);
    for (const outcome of action.outcomes) if (!(outcome in s.outcomes)) out.push(`${s.id}: outcome ${outcome} of ${body.uses} leads nowhere`);
    for (const e of action.effects) if (!s.effects.includes(e)) out.push(`${s.id}: ${body.uses} needs effect ${e}, not declared`);
  }
  return out;
}

/** Runnable when every action is built, no step is unsupported code, and every called workflow is runnable. */
function runnableOf(w: WorkflowDecl, byId: Map<string, WorkflowDecl>, seen: Set<string>): WorkflowDecl['runnable'] {
  seen.add(w.id);
  const missing: Array<{ step: string; action: string }> = [];
  for (const s of w.steps) {
    const body = s.body;
    if (body.kind === 'action' && !ACTIONS[body.uses]?.run) missing.push({ step: s.id, action: body.uses });
    if (body.kind === 'code') missing.push({ step: s.id, action: 'run.ts' });
    if (body.kind === 'call') {
      const called = byId.get(body.workflow);
      if (called && !seen.has(called.id) && !runnableOf(called, byId, seen).ok) missing.push({ step: s.id, action: `workflow ${called.id}` });
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}
