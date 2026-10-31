/**
 * The automation: one object per workspace that owns runs, the queue, triggers and events. The
 * only public surface of src/workflows besides model.ts (index.ts re-exports exactly these).
 *
 *   const automation = openAutomation(ws, { ask, now });
 *   automation.snapshot()                         // screens 1, 2, 5, 9, corner, badge
 *   automation.run(id)                            // screen 3
 *   automation.runs({ workflow, before })         // Läufe tab
 *   await automation.command({ kind: 'start', … })// every write
 *   automation.emit('transaction.imported', item) // a core event from outside (statement upload, drop)
 *
 * Replaces runner.ts's execute() loop: the loop becomes `advance(run)`, one step per call, the
 * run persisted after each, so waiting, retrying, queueing mid-run and resuming are the same code
 * path as running.
 */
import type { Workspace } from '../workspace/workspace.js';
import type { AskOptions } from '../llm/ask.js';
import type { FileSource } from './load.js';
import type {
  AutomationCommand, AutomationSnapshot, CommandResult, EventName, ItemRef, Run, RunId, RunSummary, WorkflowId,
} from './model.js';

export interface AutomationDeps {
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
  now?: () => string;
  /**
   * The working tree (what is on disk) and git HEAD, from saving.ts so git is read in one place.
   * Live runs execute a declaration version only when approvals.ts approves it (app workflows are
   * approved by definition); any other version runs 'dry' or 'replay' only. HEAD serves replay
   * against the last saved state. (Synthesis: replaces the base's "saved = switched on".)
   */
  sources: { tree: FileSource; saved: FileSource };
  approvals: { isApproved(workflow: WorkflowId, version: string): boolean };
  /** Called when a task appears or a run gets stuck and the person is elsewhere (desktop notification). */
  notify?(n: { title: string; body: string; run: RunId }): void;
}

export interface Automation {
  snapshot(): AutomationSnapshot;
  run(id: RunId): Run | undefined;
  runs(q: { workflow?: WorkflowId; before?: string; limit?: number; entry?: string }): RunSummary[];
  command(cmd: AutomationCommand): Promise<CommandResult>;
  /**
   * Live runs whose applied effects wrote records, with what they wrote (store.writers()):
   * the join saving.ts makes against the git diff. Only runs started since the oldest unsaved
   * change matter; saving filters by the record ids it actually sees in the diff.
   */
  writers(): Array<{ run: RunId; workflow: WorkflowId; title: string; wrote: Run['steps'][number]['effects'][number]['wrote'] }>;
  /** An event from outside the engine (core events: a statement merged by an upload, a file in the inbox). */
  emit(event: EventName, item: ItemRef): void;
  /** Stops scheduling; running steps finish; releases the lock. */
  close(): Promise<void>;
}

/**
 * Opens the store, reloads declarations (saved + draft), and recovers: every run persisted as
 * `running` (the app was closed or crashed mid-step) is re-queued at that step; its effect keys
 * make the rerun write nothing twice. Then starts the scheduler tick (1 s) and the schedule clock.
 */
export function openAutomation(ws: Workspace, deps: AutomationDeps): Automation {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Internals (not exported from index.ts; tests reach them through the Automation only)
// ---------------------------------------------------------------------------------------------

/**
 * One step of one run, then persist. The whole state machine:
 *
 *   step body = action  → run the action with reads-only input and declared effect handles
 *                          TransientError + retry left → retrying(next = now + backoff)
 *                          other throw                 → stuck(error)
 *                          outcome unmapped            → stuck(no-outcome)
 *   step body = code    → import run.ts (app workflows; D7), same as action without effects
 *   step body = person  → waiting(task = taskOf(...)); notify if remind has 'notification'
 *   step body = wait    → parked(until event | time); an emit() of that event for this item resumes it
 *   step body = call    → start a child run of the called workflow (parent = this run/step); this run
 *                          parks until the child ends; the child's end outcome is this step's outcome
 *   forEach             → one part-run per element (parent = this run, part = element key); the
 *                          parent parks; when all parts ended, the parent continues with outcome 'ok'
 *                          (or the step's declared aggregate). A waiting part holds no other part.
 *   next target end     → done; emit each of the workflow's `emits` for this item
 *   mode replay|dry     → effect handles record `would`, write nothing; ask answers from the recording (replay)
 *   live && source draft → refused at command time (CommandResult 'draft-live'), never reached here
 *
 * Effects: each handle wraps `update(loadBooks(ws), { kind: 'run', id, workflow }, fn)` + saveBooks,
 * keyed `${workflow}:${item}:${step}`; a key already applied in this run (or the run it resumes) is skipped.
 * Every applied effect bumps booksRev.
 */
declare function advance(run: Run): Promise<Run>;

/**
 * The event bus: on `emit(name, item)` start one run of every workflow with an `event` trigger on
 * `name` that is not off (in the SAVED declarations), unless a run of that workflow for that item
 * is already open (idempotent: the same event twice starts one run). Parked runs waiting for `name`
 * on this item resume.
 */
declare function dispatch(name: EventName, item: ItemRef, from?: RunId): void;
