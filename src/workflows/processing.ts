/**
 * Where a receipt (or an inbox file, or the open payments) stands in the inbox's processing (#218),
 * derived from the runs of receipt-intake and the books, never stored. A receipt is in processing
 * while a run that will still work on it is queued or running: the run its file arrived with, or,
 * for a receipt not read to the end yet (staged), any open run that has not passed the matching
 * step. Only once that run came to rest does the receipt need the person, and a run that stopped
 * says so. Browser-safe and pure: Belege, the drop dialog and Bank read the same answer.
 */
import type { Refusal } from '../types/refusal.js';
import type { QueueReason, RunSummary } from './model.js';

export const INTAKE_WORKFLOW = 'receipt-intake';

/** The inbox run's steps in order (workflows/receipt-intake/workflow.yaml); a company's own step is unknown here and named by its label. */
export const INTAKE_STEPS = ['read', 'facts', 'match', 'book'] as const;

export type Processing =
  /** Its run waits: `ahead` files came in with the open runs before it; `reason` why it does not run yet; `at` the step it stopped before, once it started. */
  | { kind: 'queued'; run: string; ahead: number; reason?: QueueReason; at?: string }
  /** Its run works on it now, at `step`. */
  | { kind: 'running'; run: string; step: string }
  /** Its run stopped (stuck): the person sees why, and the run is linked. Not in processing any more. */
  | { kind: 'stuck'; run: string; step?: string; error?: string; why?: Refusal };

/** Still being worked on: the list keeps it out of «Braucht dich» and the badge does not count it. */
export const inProcess = (p: Processing | undefined): p is Extract<Processing, { kind: 'queued' | 'running' }> => p?.kind === 'queued' || p?.kind === 'running';

const isOpen = (r: RunSummary) => r.status === 'queued' || r.status === 'running';
const arrivedIds = (r: RunSummary) => (r.arrived ?? []).flatMap((a) => (a.kind === 'receipt' ? [a.id] : []));
/** Whether the run still comes to step `step` (or stands on it): a queued run that has not started, or one at it or before it. */
const before = (r: RunSummary, step: string) => {
  const at = r.at ? INTAKE_STEPS.indexOf(r.at as typeof INTAKE_STEPS[number]) : 0;
  return at === -1 || at <= INTAKE_STEPS.indexOf(step as typeof INTAKE_STEPS[number]);
};

function stateOf(run: RunSummary, open: readonly RunSummary[]): Processing {
  if (run.status === 'running') return { kind: 'running', run: run.id, step: run.at ?? INTAKE_STEPS[0] };
  if (run.status === 'stuck') return { kind: 'stuck', run: run.id, ...(run.at ? { step: run.at } : {}), ...(run.error ? { error: run.error } : {}), ...(run.why ? { why: run.why } : {}) };
  // Queued: the files of the open runs before it go first.
  const ahead = open.filter((r) => r.id !== run.id && (r.startedAt < run.startedAt || (r.startedAt === run.startedAt && r.id < run.id))).reduce((n, r) => n + arrivedIds(r).length, 0);
  return { kind: 'queued', run: run.id, ahead, ...(run.reason ? { reason: run.reason } : {}), ...(run.path.length && run.at ? { at: run.at } : {}) };
}

/**
 * Each receipt or inbox file the inbox's runs still work on, or whose run stopped, by id: the
 * newest live run its file arrived with decides while it is open or stuck; a staged receipt (not
 * read to the end yet) is worked on by any open run that has not passed the matching step, the
 * running one first, and is stuck when the newest run stopped and none is open.
 */
export function processingOf(runs: readonly RunSummary[], receipts: ReadonlyArray<{ id: string; location: 'staged' | 'archived' }>): Map<string, Processing> {
  const intake = runs.filter((r) => r.workflow === INTAKE_WORKFLOW && r.mode === 'live').sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const open = intake.filter(isOpen);
  const out = new Map<string, Processing>();
  for (const run of [...intake].reverse()) {
    for (const id of arrivedIds(run)) {
      if (isOpen(run) || run.status === 'stuck') out.set(id, stateOf(run, open));
      else out.delete(id);
    }
  }
  const reading = open.filter((r) => before(r, 'match')).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.startedAt.localeCompare(b.startedAt));
  const newest = intake[0];
  for (const r of receipts) {
    if (r.location !== 'staged' || inProcess(out.get(r.id))) continue;
    if (reading[0]) out.set(r.id, stateOf(reading[0], open));
    else if (!open.length && newest?.status === 'stuck' && !out.has(r.id)) out.set(r.id, stateOf(newest, open));
  }
  return out;
}

/** One run of the inbox as Processing (a statement's row in the drop dialog): its step, its place in the queue, or that it stopped; undefined at rest. */
export function runProcessing(run: RunSummary, runs: readonly RunSummary[]): Processing | undefined {
  if (!isOpen(run) && run.status !== 'stuck') return undefined;
  return stateOf(run, runs.filter((r) => r.workflow === run.workflow && r.mode === run.mode && isOpen(r)));
}

/**
 * The open run that will book the payments still without a booking: the inbox's running or
 * queued run (its last step books every open payment). Undefined when none is open: an unbooked
 * payment then waits for the person.
 */
export function bookingRun(runs: readonly RunSummary[]): Processing | undefined {
  const open = runs.filter((r) => r.workflow === INTAKE_WORKFLOW && r.mode === 'live' && isOpen(r));
  const run = open.find((r) => r.status === 'running') ?? [...open].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  return run && stateOf(run, open);
}
