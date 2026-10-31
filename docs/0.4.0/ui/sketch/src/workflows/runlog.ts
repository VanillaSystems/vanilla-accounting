/**
 * The run log: a short, durable, shared history of every run that mattered, failures included.
 * One file per fiscal year, transactional-data/<year>/runs.jsonl, append-only, one line per event,
 * never edited. Committed with the records the run wrote (saving/records.ts), so a cloud run and
 * the owner's Mac see the same history. A closed year's file is never written again: an event
 * after the close goes into the open year's file.
 *
 * Three rules keep it small (the CI-log trap):
 * 1. Only runs that wrote something, got stuck, waited for a person or were discarded leave lines.
 *    A run that changed nothing and needed nobody (a schedule that found nothing, a booking run on
 *    a booked transaction) stays in the local run store only.
 * 2. Append-only: a state change is a new line, never a rewrite of an old one.
 * 3. No detail: inputs, prompts, model answers and receipt text stay in the run store (store.ts),
 *    with retention (RETENTION). The log names what happened, the store shows how.
 */
import type { ItemRef, RunId, StepId, WorkflowId } from './model.js';

export type RunLogEvent =
  | { event: 'started'; by: 'manual' | 'event' | 'schedule' | 'outside'; person?: string }
  | { event: 'stuck'; step: StepId; reason: string }
  | { event: 'waiting'; step: StepId; task: string }
  | { event: 'answered'; step: StepId; outcome: string; person?: string }
  | { event: 'resumed'; step: StepId; version: string }
  | { event: 'done' }
  | { event: 'discarded'; reason: string; person?: string };

export type RunLogLine = RunLogEvent & {
  run: RunId;
  workflow: WorkflowId;
  /** Declaration version the event happened on. */
  version: string;
  item: ItemRef;
  at: string;
  /** Where it ran: this Mac or the cloud instance; both write the same log. */
  host: 'local' | 'cloud';
  /** Record ids written since the run's previous line, per books part (the commit holds them). */
  wrote?: Partial<Record<'entries' | 'mappings' | 'transactions' | 'receipts', string[]>>;
};

/** How long the run store keeps a run's detail after the run came to rest. App-local setting. */
export const RETENTION = { days: 90, atLeastUntilYearClose: true } as const;

/** Whether a run's events so far belong in the log (rule 1). Pure. */
export function worthLogging(events: RunLogEvent[], wrote: boolean): boolean {
  throw new Error('not implemented');
  // TODO: wrote || events.some((e) => e.event === 'stuck' || e.event === 'waiting' || e.event === 'discarded')
}

/** The year file a line goes to: the event's year, or the first open year after it. */
export function logYear(at: string, closedThrough: string | undefined): string {
  throw new Error('not implemented');
}

/** A run's history for screen 3 and RunLink, from the log alone (the detail may have expired). */
export function historyOf(lines: RunLogLine[], run: RunId): RunLogLine[] {
  throw new Error('not implemented');
}
