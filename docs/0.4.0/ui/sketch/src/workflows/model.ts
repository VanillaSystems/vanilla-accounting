/**
 * The workflow domain as data: declarations, runs, and every view the screens show, derived by
 * pure functions. Browser-safe (no node imports): the server's engine and the UI import the same
 * types and the same derivations, so the graph that is drawn, the queue that is shown and the
 * badge that is counted cannot disagree with what runs.
 *
 * Load-bearing rule: a Run is the ONLY stored state of the automation. Queue, tasks, the status
 * corner, the dock badge, "Geparkt", the run strip and the entry→run link are all derived from
 * runs plus declarations. Nothing keeps its own list.
 *
 * Layer note: lives where tests/layers allows both src/app and src/server to import it (core or
 * engines side). If the layer lint says otherwise, move the file, not the rule.
 */

// ---------------------------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** Folder name under workflows/: [a-z][a-z0-9-]*, never one of RESERVED_WORKFLOW_IDS. */
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type StepId = Brand<string, 'StepId'>;
export type RunId = Brand<string, 'RunId'>;
export type ActionId = Brand<string, 'ActionId'>;
/** `entry.booked`, `transaction.settled`, `case.no-rule`: dotted, declared in some `emits`. */
export type EventName = Brand<string, 'EventName'>;
export type IsoTime = Brand<string, 'IsoTime'>;

/** Route segments of /automation/<x>: a workflow may not be called like them (load.ts checks). */
export const RESERVED_WORKFLOW_IDS = ['runs', 'map', 'queue', 'tasks'] as const;

// ---------------------------------------------------------------------------------------------
// Declarations (workflow.yaml + <step>/step.yaml), parsed by load.ts
// ---------------------------------------------------------------------------------------------

/** Text in the four UI languages; `en` is the fallback. App-shipped workflows must carry all four (i18n test). */
export type Text = { en: string } & Partial<Record<'de' | 'fr' | 'it', string>>;

/** The order of the year; the process map's columns. Closed set: a new phase is an app change. */
export const PHASES = ['collect', 'book', 'quarter', 'year'] as const;
export type Phase = typeof PHASES[number];

/** What one run is for. `period` and `year` are a filing period token / a year; `company` is "the whole company" (a collection). */
export type ItemKind = 'transaction' | 'receipt' | 'file' | 'statement' | 'entry' | 'period' | 'year' | 'company' | 'case' | 'source';
export interface ItemRef { kind: ItemKind; id: string }

export type Trigger =
  /** A button on every object of kind `for` in the areas (screen 4). */
  | { kind: 'manual'; for: ItemKind; label: Text; off?: boolean }
  /** Another run emitted `name`; the run is for the event's item. */
  | { kind: 'event'; name: EventName; off?: boolean }
  /** cron in the company's time zone; the run is for `company`. */
  | { kind: 'schedule'; cron: string; off?: boolean }
  /** A file arrived in the inbox (ADR 0008); `accepts` names the recognized file kinds. */
  | { kind: 'outside'; accepts: Array<'receipt' | 'statement'>; off?: boolean };

/**
 * What the graph and the AI mark show. Derived from the step's shape, not chosen freely:
 * `uses` an action with ai: true → agent; `by: person` → human; `calls` → call; `wait:` → wait;
 * an action with effects → effect; `run.ts` or an action whose outcomes are a pure choice → decision.
 */
export type StepKind = 'step' | 'decision' | 'effect' | 'human' | 'wait' | 'agent' | 'call';

/** Where an outcome leads: another step of this workflow, or the end (the workflow's `emits` fire). */
export type Target = { to: 'step'; step: StepId } | { to: 'end' };

export interface TaskDecl {
  /** Templates over the run's state: "Bei {source.name} anmelden". */
  title: Text;
  why: Text;
  /** What the task's main button does. `open-login` opens a window that belongs to the person. */
  do?: { kind: 'open-login'; url: string } | { kind: 'decide'; choices: string[] } | { kind: 'open-item' };
  /** `end-of-month`, `end-of-period`, or an ISO duration from when the task appears. */
  due?: string;
  remind: Array<'notification' | 'morning-summary'>;
}

export interface RetryDecl { on: Array<'network' | 'timeout' | 'unavailable'>; times: number; backoff: string }

/** The body of a step: exactly one of these, so a step cannot both call a workflow and use an action. */
export type StepBody =
  | { kind: 'action'; uses: ActionId }
  | { kind: 'code'; file: 'run.ts' }
  | { kind: 'person'; task: TaskDecl }
  | { kind: 'call'; workflow: WorkflowId }
  | { kind: 'wait'; for: EventName; timeout?: { after: string; outcome: string } };

export interface StepDecl {
  id: StepId;
  label: Text;
  body: StepBody;
  /** Derived at load (see StepKind), stored so the UI does not re-derive with the action table. */
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
  id: WorkflowId;
  label: Text;
  desc: Text;
  phase: Phase;
  cadence: Text;
  for: ItemKind;
  triggers: Trigger[];
  emits: EventName[];
  start: StepId;
  /** Declaration order; at most nine (workflows.md rule 5). */
  steps: StepDecl[];
  guide?: string;
  /** Runs of one lane run one after another, in item order (one bank account's transactions by date). */
  lane?: 'account';
  /** sha16 of all declaration files. */
  version: string;
  /** Where it comes from: the app (upstream), or the company's workflows/ (overlay or own). */
  origin: 'app' | 'company';
  /**
   * Whether every step can execute: each action is implemented, each call names a runnable
   * workflow. Derived by load.ts from the action table; a declared-but-not-runnable workflow is
   * drawn, listed and explained, and its Start button says which step is missing.
   */
  runnable: { ok: true } | { ok: false; missing: Array<{ step: StepId; action: ActionId }> };
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export type RunMode =
  /** Writes through the write door. */
  | 'live'
  /** A recorded case on today's (or the draft's) declarations; effects muted, model answers from the recording (D9). */
  | 'replay'
  /** A new case, effects muted; the only mode a draft version may run in. */
  | 'dry';

/** Which declarations a run executes: the saved ones (git HEAD), or the working tree (the draft). */
export type DeclarationSource = 'saved' | 'draft';

export type StuckReason =
  | { kind: 'no-outcome'; step: StepId; outcome: string }
  | { kind: 'error'; step: StepId; message: string }
  | { kind: 'retries-exhausted'; step: StepId; message: string }
  | { kind: 'item-gone'; item: ItemRef }
  | { kind: 'hops'; limit: number };

export type QueueReason =
  | { kind: 'ai-slot'; limit: number }
  | { kind: 'slot'; limit: number }
  | { kind: 'lane'; behind: RunId }
  | { kind: 'paused' };

/**
 * A run's state: one variant per thing the screens distinguish. `at` is the step the run is on
 * (for queued: the step it will run next, so a run can queue mid-way for an AI slot).
 */
export type RunState =
  | { status: 'queued'; at: StepId; since: IsoTime; reason: QueueReason }
  | { status: 'running'; at: StepId; since: IsoTime }
  | { status: 'retrying'; at: StepId; attempt: number; of: number; next: IsoTime; message: string }
  | { status: 'waiting'; at: StepId; since: IsoTime; task: Task }
  | { status: 'parked'; at: StepId; since: IsoTime; until: { event: EventName } | { time: IsoTime } }
  | { status: 'stuck'; at: StepId; since: IsoTime; reason: StuckReason }
  | { status: 'done'; finishedAt: IsoTime }
  | { status: 'discarded'; at: IsoTime };

export type RunStatus = RunState['status'];

/**
 * The legal moves of a run (grafted from candidate C). advance() and every command change a run's
 * state only through transition(), so an illegal move throws instead of writing a corrupt run file.
 */
export const MOVES: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'discarded'],
  running: ['running', 'queued', 'retrying', 'waiting', 'parked', 'stuck', 'done', 'discarded'],
  retrying: ['running', 'stuck', 'discarded'],
  waiting: ['queued', 'running', 'discarded'],
  parked: ['queued', 'discarded'],
  stuck: ['queued', 'discarded'],
  done: ['discarded'],
  discarded: [],
};

export function transition(run: Run, next: RunState): Run {
  throw new Error('not implemented');
  // TODO: if (!MOVES[run.state.status].includes(next.status)) throw new RunStateError(`${run.id}: ${run.state.status} → ${next.status}`); return { ...run, state: next };
}

export interface LlmCall { promptSha: string; answer: string }

export interface EffectRecord {
  effect: string;
  /** `${workflow}:${item}:${step}`: an effect a run already had is skipped on any rerun. */
  key: string;
  applied: boolean;
  /** What it wrote, by record id, per books file: the join key of Änderungen (saving.ts). */
  wrote: Array<{ part: 'entries' | 'mappings' | 'transactions' | 'receipts' | 'files'; ids: string[] }>;
  /** For a muted effect: what it would have written, for the replay banner. */
  would?: unknown;
}

export interface StepRecord {
  step: StepId;
  startedAt: IsoTime;
  finishedAt?: IsoTime;
  /** What it read, abbreviated for the timeline ("transaction: BT-…, CHF 412.35"). */
  input: Record<string, unknown>;
  outcome?: string;
  output?: Record<string, unknown>;
  llm: LlmCall[];
  effects: EffectRecord[];
  error?: string;
  /** A person's answer (task outcome and output), with who and when. */
  answer?: { outcome: string; output?: Record<string, unknown>; at: IsoTime };
}

export interface Run {
  id: RunId;
  workflow: WorkflowId;
  version: string;
  source: DeclarationSource;
  item: ItemRef;
  /** Human words for the item, captured at start ("FedEx Express", "412.35"). */
  title: string;
  amount?: string;
  mode: RunMode;
  /** For a replay, the run it replays; for a part-run, its parent; for a run started by an event, the run that emitted it. */
  of?: RunId;
  parent?: { run: RunId; step: StepId; part: string };
  startedBy: { kind: 'manual'; label?: string } | { kind: 'event'; name: EventName; run: RunId } | { kind: 'schedule'; cron: string } | { kind: 'outside'; file: string } | { kind: 'resume'; of: RunId };
  startedAt: IsoTime;
  state: RunState;
  /** Append-only: one record per executed step, in order. Finished records never change. */
  steps: StepRecord[];
  /** A replay the person confirmed: replayed before every later change of this workflow. */
  testCase?: { keptAt: IsoTime; expected: Array<{ step: StepId; outcome: string }> };
}

/** What a run in a list needs: no step records. */
export type RunSummary = Pick<Run, 'id' | 'workflow' | 'item' | 'title' | 'amount' | 'mode' | 'startedAt' | 'startedBy' | 'parent'> & {
  state: RunState;
  /** Steps done / steps on the declaration's happy path (2/5 · "MWST-Fakten gelesen"). */
  progress: { n: number; of: number; label: string };
  /** The first AI step that decided in this run, for "KI in Schritt …". */
  aiStep?: StepId;
};

// ---------------------------------------------------------------------------------------------
// Tasks: a derived view of a waiting run, never stored on their own
// ---------------------------------------------------------------------------------------------

export interface Task {
  run: RunId;
  step: StepId;
  workflow: WorkflowId;
  title: string;
  why: string;
  do?: TaskDecl['do'];
  due?: IsoTime;
  /** The person step's outcomes are the task's buttons (done / skip / pause, or the decision's choices). */
  outcomes: string[];
  remind: TaskDecl['remind'];
}

// ---------------------------------------------------------------------------------------------
// The snapshot: everything screens 1, 2, 3 (header), 5, 9, the status corner, the sidebar's
// status line, the dock badge and the drop dialog's progress need, in one read.
// ---------------------------------------------------------------------------------------------

export interface AutomationSnapshot {
  /** The one clock: bumped on every run change, declaration change and git index/HEAD change; the poll sends it back as `since`. A lower one (server restart) means "take this". */
  rev: number;
  /** Bumped when a run applied an effect: the shell reloads the books when it changes. */
  booksRev: number;
  workflows: WorkflowDecl[];
  /** Per workflow: the last eight runs (run strip) and the counts. */
  recent: Record<WorkflowId, { strip: RunSummary[]; total: number; open: number }>;
  running: RunSummary[];
  /** In run order: what starts next first. Includes the next due schedule per trigger. */
  queue: Array<RunSummary | { kind: 'scheduled'; workflow: WorkflowId; at: IsoTime }>;
  /** Waiting for a person, by due date. */
  tasks: Task[];
  /** Parked for an event or a time, grouped by what they wait for. */
  parked: Array<{ workflow: WorkflowId; waitsFor: EventName | 'time'; count: number }>;
  stuck: RunSummary[];
  finished: RunSummary[];
  paused: boolean;
  limits: { ai: number; other: number };
}

/** The corner (views.md "Status, top right"): exactly the three states, derived. */
export type Corner =
  | { kind: 'running'; count: number }
  | { kind: 'needs-you'; count: number }
  | { kind: 'quiet' };

// ---------------------------------------------------------------------------------------------
// Commands: the one write surface of the automation (POST /api/automation)
// ---------------------------------------------------------------------------------------------

export type AutomationCommand =
  | { kind: 'start'; workflow: WorkflowId; item: ItemRef; mode?: 'live' | 'dry'; source?: DeclarationSource }
  /** Waiting and stuck runs (and parts) of a workflow continue from their step; finished parts do not run again. */
  | { kind: 'resume-open'; workflow: WorkflowId; source?: DeclarationSource }
  | { kind: 'resume'; run: RunId; source?: DeclarationSource }
  | { kind: 'replay'; run: RunId; source?: DeclarationSource }
  | { kind: 'answer'; run: RunId; step: StepId; outcome: string; output?: Record<string, unknown> }
  | { kind: 'keep-case'; run: RunId }
  /** Inverts the run's applied effects through the write door; receipts go back to the inbox (saving.md "Discarding the run"). */
  | { kind: 'discard'; run: RunId }
  | { kind: 'dequeue'; run: RunId }
  | { kind: 'pause' }
  | { kind: 'unpause' };

export type CommandResult =
  | { ok: true; run?: RunId; rev: number }
  | { ok: false; refusal: 'not-runnable' | 'draft-live' | 'not-waiting' | 'unknown-outcome' | 'closed-period' | 'busy' | 'not-found'; detail?: string };

// ---------------------------------------------------------------------------------------------
// Pure derivations (shared by engine and UI)
// ---------------------------------------------------------------------------------------------

export function corner(s: AutomationSnapshot): Corner {
  // TODO running.length > 0 → running; else tasks.length (+ stuck? no: stuck goes to the maintainer, not "für dich") → needs-you; else quiet
  throw new Error('not implemented');
}

/** The dock badge of Automatisierung: tasks + stuck. */
export function openCount(s: AutomationSnapshot): number {
  throw new Error('not implemented');
}

export function hasAi(w: WorkflowDecl): boolean {
  // TODO w.steps.some(s => s.kind === 'agent'); a `call` to a workflow with AI counts too (needs the list)
  throw new Error('not implemented');
}

/** The steps the first outcome of each step leads through, start to end: the denominator of progress bars. */
export function happyPath(w: WorkflowDecl): StepId[] {
  throw new Error('not implemented');
}

export interface GraphNode { id: StepId; kind: StepKind; ai: boolean; layer: number; slot: number }
export interface GraphEdge { from: StepId | 'trigger'; to: StepId | 'end'; outcome: string; back: boolean }
/** Layered layout (the mockup's layout()): BFS layers from start, back edges marked so the SVG routes them below. */
export function graphOf(w: WorkflowDecl): { nodes: GraphNode[]; edges: GraphEdge[] } {
  throw new Error('not implemented');
}

/** A run drawn on its graph: the path taken, the step it is on, muted effects in a replay. */
export function overlayOf(w: WorkflowDecl, run: Run): { path: StepId[]; at?: StepId; muted: StepId[] } {
  throw new Error('not implemented');
}

/**
 * The process map (screen 2), never hand-drawn: columns from `phase`, arrows from each event in
 * one workflow's `emits` to every workflow with an `event` trigger on it (off triggers dashed),
 * and from a `call` step to the called workflow.
 */
export function processMap(ws: WorkflowDecl[]): {
  phases: Array<{ phase: Phase; workflows: WorkflowId[] }>;
  arrows: Array<{ from: WorkflowId; to: WorkflowId; via: EventName | 'call'; off: boolean }>;
} {
  throw new Error('not implemented');
}

/** "Startet Beleg aufnehmen 2 · Kontoauszug einlesen 2 · danach …": the follow-on chain of an outside trigger (drop dialog). */
export function chainFrom(ws: WorkflowDecl[], start: WorkflowId): Array<{ workflow: WorkflowId; how: 'event' | 'manual' }> {
  throw new Error('not implemented');
}

/** The task a person step shows for a run: templates filled from the run's state. */
export function taskOf(w: WorkflowDecl, run: Run, step: StepDecl & { body: { kind: 'person' } }, lang: keyof Text, now: IsoTime): Task {
  throw new Error('not implemented');
}

/** The manual triggers that put a button on an object of `kind` (screen 4). */
export function buttonsFor(ws: WorkflowDecl[], kind: ItemKind): Array<{ workflow: WorkflowDecl; label: Text; ai: boolean; runnable: boolean }> {
  throw new Error('not implemented');
}

export const textIn = (t: Text, lang: string): string => (t as Record<string, string | undefined>)[lang] ?? t.en;
