/**
 * The workflow domain as data (docs/0.4.0/ui/design.md): declarations, runs, and the views the
 * screens show, derived by pure functions. Browser-safe: no node import. The server and the UI
 * use the same types and the same derivations, so the graph that is drawn, the map that is shown
 * and the buttons in other areas cannot disagree with what runs.
 */

/** Route segments of /automation/<x>: no workflow may take these ids (load.ts checks). */
export const RESERVED_WORKFLOW_IDS = ['runs', 'map', 'queue', 'tasks'] as const;

/** Text in the four UI languages; `en` is the fallback. App workflows carry all four (tests/workflows.test.ts). */
export type Text = { en: string } & Partial<Record<'de' | 'fr' | 'it', string>>;
export const LANGUAGES = ['de', 'en', 'fr', 'it'] as const;
export const textIn = (t: Text, lang: string): string => (t as Record<string, string | undefined>)[lang] ?? t.en;

/** The order of the year: the process map's columns. A new phase is an app change. */
export const PHASES = ['collect', 'book', 'quarter', 'year'] as const;
export type Phase = typeof PHASES[number];

/** What one run is for. `company` is "the whole company" (a collection round). */
export const ITEM_KINDS = ['transaction', 'receipt', 'file', 'statement', 'entry', 'period', 'year', 'company', 'case', 'source'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
export interface ItemRef { kind: ItemKind; id: string }

export type Trigger =
  /** A button on every object of kind `for` in the areas (screen 4). */
  | { kind: 'manual'; for: ItemKind; label: Text; off?: boolean }
  /** Another run emitted `name`. */
  | { kind: 'event'; name: string; off?: boolean }
  /** cron in the company's time zone; the run is for `company`. */
  | { kind: 'schedule'; cron: string; off?: boolean }
  /** A file arrived in the inbox (ADR 0008). */
  | { kind: 'outside'; accepts: Array<'receipt' | 'statement'>; off?: boolean };

/**
 * What the graph and the AI mark show, derived from the step's body, never chosen freely: an
 * action with ai → agent; a person → human; a call → call; a wait → wait; an action with
 * effects → effect; an action whose outcomes are a choice → decision; else step.
 */
export type StepKind = 'step' | 'decision' | 'effect' | 'human' | 'wait' | 'agent' | 'call';

/** Where an outcome leads: another step of this workflow, or the end (the workflow's `emits` fire). */
export type Target = { to: 'step'; step: string } | { to: 'end' };

export interface TaskDecl {
  /** Templates over the run's state: "Bei {source} anmelden". */
  title: Text;
  why?: Text;
  /** What the task's main button does. `open-login` opens a window that belongs to the person. */
  do?: 'open-login' | 'open-secret' | 'decide' | 'open-item';
  /** `end-of-month`, `end-of-period`, or an ISO duration from when the task appears. */
  due?: string;
}

export interface RetryDecl { on: Array<'network' | 'timeout' | 'unavailable'>; times: number; backoff: string }

/** The body of a step: exactly one of these, so a step cannot both call a workflow and use an action. */
export type StepBody =
  | { kind: 'action'; uses: string }
  | { kind: 'code'; file: 'run.ts' }
  | { kind: 'person'; task: TaskDecl }
  | { kind: 'call'; workflow: string }
  | { kind: 'wait'; for: string; timeout?: { after: string; outcome: string } };

export interface StepDecl {
  id: string;
  label: Text;
  body: StepBody;
  /** Derived at load (see StepKind). */
  kind: StepKind;
  reads: string[];
  emits: string[];
  effects: string[];
  outcomes: Record<string, Target>;
  /** `booking.guide.yaml#classify`: app guide and company rules, in that order. */
  guide?: string;
  /** Knowledge the step reads: `suppliers/*` means the run item's own counterparty. */
  knowledge: string[];
  /** One part-run per element of the named state list (screen 5: one per source). */
  forEach?: string;
  retry?: RetryDecl;
}

export interface WorkflowDecl {
  id: string;
  label: Text;
  desc: Text;
  phase: Phase;
  cadence: Text;
  for: ItemKind;
  triggers: Trigger[];
  emits: string[];
  start: string;
  /** Declaration order. */
  steps: StepDecl[];
  guide?: string;
  /** Runs of one lane run one after another, in item order (one bank account's transactions by date). */
  lane?: 'account';
  /** sha16 of all declaration files, the company's overlay included. */
  version: string;
  /** Where it comes from: the app alone, or the app with the company's overlay, or the company alone. */
  origin: 'app' | 'overlaid' | 'company';
  /** Every step can execute: each action is implemented, each call names a runnable workflow. */
  runnable: { ok: true } | { ok: false; missing: Array<{ step: string; action: string }> };
}

/** At most this many steps on one level before the lint asks for a group (a readability rule, not a law). */
export const STEP_CAP = 9;

// ---------------------------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------------------------

export const stepOf = (w: WorkflowDecl, id: string): StepDecl | undefined => w.steps.find((s) => s.id === id);

/** Whether an AI decides anywhere in the workflow, a called workflow's AI included. */
export function hasAi(w: WorkflowDecl, all: readonly WorkflowDecl[] = [], seen = new Set<string>()): boolean {
  if (seen.has(w.id)) return false;
  seen.add(w.id);
  return w.steps.some((s) => s.kind === 'agent' || (s.body.kind === 'call' && hasAi(all.find((x) => x.id === (s.body as { workflow: string }).workflow) ?? w, all, seen)));
}

/** The steps the first outcome of each step leads through, start to end: the denominator of progress bars. */
export function happyPath(w: WorkflowDecl): string[] {
  const path: string[] = [];
  for (let at: string | undefined = w.start; at && !path.includes(at);) {
    path.push(at);
    const first: Target | undefined = Object.values(stepOf(w, at)?.outcomes ?? {})[0];
    at = first?.to === 'step' ? first.step : undefined;
  }
  return path;
}

export interface GraphNode { id: string; kind: StepKind; layer: number; row: number }
export interface GraphEdge { from: string; to: string; outcome: string; back: boolean }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; layers: number; rows: number }

/** `end`: the node every outcome that finishes the run points to. */
export const END = '$end';

/**
 * The mockup's layout(): a depth-first search from the start marks back edges, layers are the
 * longest path over forward edges, and a node takes its first parent's row or the next free one.
 * Deterministic: the same declarations give the same picture every time.
 */
export function graphOf(w: WorkflowDecl): Graph {
  const ids = [...w.steps.map((s) => s.id), END];
  const edges: GraphEdge[] = w.steps.flatMap((s) => Object.entries(s.outcomes).map(([outcome, t]) => ({ from: s.id, to: t.to === 'end' ? END : t.step, outcome, back: false })));
  const out = new Map(ids.map((id) => [id, edges.filter((e) => e.from === id)]));
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      if (state.get(e.to) === 1) e.back = true;
      else if (!state.has(e.to)) dfs(e.to);
    }
    state.set(id, 2);
    order.push(id);
  };
  dfs(w.start);
  for (const id of ids) if (!state.has(id)) dfs(id);
  const topo = order.reverse();
  const layer = new Map<string, number>(topo.map((id) => [id, 0]));
  for (const id of topo) for (const e of out.get(id) ?? []) if (!e.back) layer.set(e.to, Math.max(layer.get(e.to)!, layer.get(id)! + 1));
  const firstParent = new Map<string, string>();
  for (const id of topo) for (const e of out.get(id) ?? []) if (!e.back && !firstParent.has(e.to)) firstParent.set(e.to, id);
  const row = new Map<string, number>();
  const used = new Map<number, Set<number>>();
  for (const id of [...topo].sort((a, b) => layer.get(a)! - layer.get(b)! || topo.indexOf(a) - topo.indexOf(b))) {
    const l = layer.get(id)!;
    const taken = used.get(l) ?? new Set<number>();
    used.set(l, taken);
    let r = firstParent.has(id) ? row.get(firstParent.get(id)!) ?? 0 : 0;
    while (taken.has(r)) r++;
    row.set(id, r);
    taken.add(r);
  }
  const kindOf = (id: string): StepKind => stepOf(w, id)?.kind ?? 'step';
  const nodes = ids.map((id) => ({ id, kind: kindOf(id), layer: layer.get(id)!, row: row.get(id)! }));
  return { nodes, edges, layers: Math.max(...nodes.map((n) => n.layer)) + 1, rows: Math.max(...nodes.map((n) => n.row)) + 1 };
}

/**
 * The process map (screen 2), never hand-drawn: columns from `phase`, arrows from each event in
 * one workflow's `emits` to every workflow with an `event` trigger on it (switched-off triggers
 * dashed), and from a `call` step to the called workflow.
 */
export function processMap(ws: readonly WorkflowDecl[]): {
  phases: Array<{ phase: Phase; workflows: string[] }>;
  arrows: Array<{ from: string; to: string; via: string; off: boolean }>;
} {
  const arrows = ws.flatMap((from) => [
    ...from.emits.flatMap((name) => ws.flatMap((to) => to.triggers
      .filter((t): t is Extract<Trigger, { kind: 'event' }> => t.kind === 'event' && t.name === name)
      .map((t) => ({ from: from.id, to: to.id, via: name, off: !!t.off })))),
    ...from.steps.flatMap((s) => (s.body.kind === 'call' ? [{ from: from.id, to: s.body.workflow, via: 'call', off: false }] : [])),
  ]);
  return { phases: PHASES.map((phase) => ({ phase, workflows: ws.filter((w) => w.phase === phase).map((w) => w.id) })), arrows };
}

/** The manual triggers that put a button on an object of `kind` (screen 4). */
export function buttonsFor(ws: readonly WorkflowDecl[], kind: ItemKind): Array<{ workflow: WorkflowDecl; label: Text; ai: boolean; runnable: boolean }> {
  return ws.flatMap((w) => w.triggers
    .filter((t): t is Extract<Trigger, { kind: 'manual' }> => t.kind === 'manual' && t.for === kind && !t.off)
    .map((t) => ({ workflow: w, label: t.label, ai: hasAi(w, ws), runnable: w.runnable.ok })));
}

// ---------------------------------------------------------------------------------------------
// Runs: the only stored state of the automation (one JSON per run, saved after every step)
// ---------------------------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'waiting' | 'parked' | 'stuck' | 'done' | 'discarded';

/** Why a queued run does not run yet. */
export type QueueReason = 'slot' | 'ai-slot' | 'lane' | 'paused' | 'busy';

/** A run's state: one variant per thing the screens tell apart. `at` is the step the run is on. */
export type RunState =
  | { status: 'queued'; at: string; since: string; reason?: QueueReason }
  | { status: 'running'; at: string; since: string }
  | { status: 'waiting'; at: string; since: string }
  | { status: 'parked'; at: string; since: string; until: { event: string } | { time: string } }
  | { status: 'stuck'; at: string; since: string; reason: string }
  | { status: 'done'; finishedAt: string }
  | { status: 'discarded'; at: string; reason: string };

/** The legal moves of a run: every change of state goes through transition(), so an illegal move throws instead of writing a broken run. */
export const MOVES: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'queued', 'discarded'],
  running: ['running', 'queued', 'waiting', 'parked', 'stuck', 'done', 'discarded'],
  waiting: ['queued', 'done', 'discarded'],
  parked: ['queued', 'done', 'discarded'],
  stuck: ['queued', 'discarded'],
  done: ['discarded'],
  discarded: [],
};

export class RunStateError extends Error {}

export function transition(run: Run, next: RunState): Run {
  if (!MOVES[run.state.status].includes(next.status)) throw new RunStateError(`${run.id}: ${run.state.status} → ${next.status} is not a legal move`);
  return { ...run, state: next };
}

export interface LlmCall { promptSha: string; answer: string }

export interface EffectRecord {
  effect: string;
  /** `${workflow}:${item}:${step}`: an effect a run already applied is skipped on any rerun. */
  key: string;
  applied: boolean;
  /** What it wrote, by record id: the books' link back to the run, and Änderungen's join key. */
  wrote: Partial<Record<'entries' | 'mappings' | 'receipts', string[]>>;
  /** In a dry run or a replay: what it would have written, checked by the write door but not saved. */
  would?: unknown;
  /** The write door refused it (a closed period, an unbalanced entry): shown in a replay instead of written. */
  refused?: string;
}

export interface StepRecord {
  step: string;
  startedAt: string;
  finishedAt?: string;
  /** What it read, in short ("transaction: BT-…, 412.35"). */
  input: Record<string, string>;
  outcome?: string;
  output?: Record<string, unknown>;
  llm: LlmCall[];
  effects: EffectRecord[];
  error?: string;
  /** A person's answer to the step's task. */
  answer?: { outcome: string; at: string };
}

export type StartedBy =
  | { kind: 'manual' }
  | { kind: 'event'; name: string; run: string }
  | { kind: 'schedule'; cron: string }
  | { kind: 'outside'; file: string }
  | { kind: 'parent'; run: string; step: string }
  | { kind: 'replay'; of: string };

export interface Run {
  schema: 2;
  id: string;
  workflow: string;
  /** The declaration version it runs on. */
  version: string;
  item: ItemRef;
  /** live writes through the write door; dry and replay check the same writes and save none. */
  mode: 'live' | 'dry' | 'replay';
  startedBy: StartedBy;
  startedAt: string;
  state: RunState;
  /** Append-only: one record per executed step. Finished records never change. */
  steps: StepRecord[];
}

/** What a step can read: the outputs of the steps before it, in order. Derived, never stored twice. */
export const outputsOf = (run: Run): Record<string, unknown> => Object.assign({}, ...run.steps.map((s) => s.output ?? {}));

// ---------------------------------------------------------------------------------------------
// What GET /api/automation answers, all derived from runs and declarations
// ---------------------------------------------------------------------------------------------

/** A run in a list: where it went and where it is, without its step records. */
export interface RunSummary {
  id: string;
  workflow: string;
  item: ItemRef;
  mode: Run['mode'];
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** The steps it went through, in order. */
  path: string[];
  /** The step it is on or stopped at. */
  at?: string;
  /** Why it stopped, when it is stuck. */
  error?: string;
  reason?: QueueReason;
}

export function summaryOf(run: Run): RunSummary {
  const s = run.state;
  return {
    id: run.id, workflow: run.workflow, item: run.item, mode: run.mode, startedAt: run.startedAt,
    ...(s.status === 'done' ? { finishedAt: s.finishedAt } : {}),
    status: s.status, path: run.steps.map((r) => r.step),
    ...('at' in s && s.status !== 'discarded' ? { at: s.at } : {}),
    ...(s.status === 'stuck' ? { error: s.reason } : s.status === 'discarded' ? { error: s.reason } : {}),
    ...(s.status === 'queued' && s.reason ? { reason: s.reason } : {}),
  };
}

export interface RunDetail extends RunSummary { steps: StepRecord[] }

/** A task: a waiting run seen from the person it waits for. Never stored on its own. */
export interface Task {
  run: string;
  workflow: string;
  step: string;
  item: ItemRef;
  title: Text;
  why?: Text;
  do?: TaskDecl['do'];
  due?: string;
  since: string;
  /** The person step's outcomes: the task's buttons. */
  outcomes: string[];
}

export function taskOf(w: WorkflowDecl, run: Run): Task | undefined {
  if (run.state.status !== 'waiting') return undefined;
  const step = stepOf(w, run.state.at);
  if (step?.body.kind !== 'person') return undefined;
  const task = step.body.task;
  return {
    run: run.id, workflow: w.id, step: step.id, item: run.item, title: task.title, ...(task.why ? { why: task.why } : {}),
    ...(task.do ? { do: task.do } : {}), ...(task.due ? { due: task.due } : {}), since: run.state.since, outcomes: Object.keys(step.outcomes),
  };
}

/** "{transaction}" in a task text becomes the run's item. */
export const fillTask = (text: string, item: ItemRef): string => text.replace(/\{[a-z]+\}/g, item.id);

export interface AutomationView {
  /** Changes whenever a declaration or a run changed: the poll sends it back as `since`. */
  rev: string;
  workflows: WorkflowDecl[];
  problems: Array<{ workflow: string; message: string }>;
  warnings: Array<{ workflow: string; message: string }>;
  /** Newest first. */
  runs: RunSummary[];
  tasks: Task[];
  paused: boolean;
  limits: { ai: number; other: number };
}

/** The status corner (views.md "Status, top right"): exactly three states. */
export type Corner = { kind: 'running'; count: number } | { kind: 'needs-you'; count: number } | { kind: 'quiet' };

export function corner(v: AutomationView): Corner {
  const running = v.runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
  if (running) return { kind: 'running', count: running };
  return v.tasks.length ? { kind: 'needs-you', count: v.tasks.length } : { kind: 'quiet' };
}

/** The dock badge of Automatisierung: what waits for a person, and what is stuck. */
export const openCount = (v: AutomationView): number => v.tasks.length + v.runs.filter((r) => r.status === 'stuck').length;

export type AutomationCommand =
  | { kind: 'start'; workflow: string; item: ItemRef; mode?: 'live' | 'dry' }
  | { kind: 'answer'; run: string; outcome: string }
  | { kind: 'resume'; run: string }
  | { kind: 'replay'; run: string }
  | { kind: 'discard'; run: string; reason?: string }
  | { kind: 'pause'; on: boolean };

export type CommandResult =
  | { ok: true; run?: string }
  | { ok: false; refusal: 'not-runnable' | 'not-found' | 'not-waiting' | 'unknown-outcome' | 'not-approved' | 'illegal'; detail?: string };
