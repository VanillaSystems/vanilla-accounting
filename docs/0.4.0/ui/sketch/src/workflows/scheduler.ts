/**
 * Which queued runs start now, and why the others wait. Pure: the engine calls it after every
 * run change and acts on the answer. The queue the UI shows is this function's output, so the
 * reason a row gives ("wartet auf einen freien KI-Platz") is the reason it actually waits.
 */
import type { IsoTime, QueueReason, RunId, RunSummary, WorkflowDecl, WorkflowId } from './model.js';

export interface Limits { ai: number; other: number }
export const LIMITS: Limits = { ai: 2, other: 4 };

export interface Plan {
  /** Start these now, in this order. */
  start: RunId[];
  /** Everything else queued, in the order it will start, with its reason. */
  waiting: Array<{ run: RunId; reason: QueueReason }>;
}

/**
 * Slots are per STEP, not per run: a run about to enter an agent step needs an AI slot, any other
 * step an ordinary one. Lanes: runs of a workflow with `lane: account` and the same account run
 * one at a time, in item date order (a transaction's booking waits for the earlier one).
 * Paused: nothing starts; running runs finish their current step and queue.
 */
export function plan(input: {
  queued: RunSummary[];
  running: RunSummary[];
  workflows: ReadonlyMap<WorkflowId, WorkflowDecl>;
  limits: Limits;
  paused: boolean;
  laneOf(run: RunSummary): string | undefined;
}): Plan {
  // TODO count slots taken by running runs by the kind of their `at` step
  // TODO walk queued in (lane order, enqueue time); assign reason: paused | lane(behind) | ai-slot | slot
  throw new Error('not implemented');
}

/** Schedule triggers due now (with catch-up after a pause or a closed app: one run per missed trigger, not one per missed tick). */
export function dueSchedules(workflows: WorkflowDecl[], lastFire: Record<string, string>, now: IsoTime, paused: boolean): Array<{ workflow: WorkflowId; cron: string; next: IsoTime; due: boolean }> {
  throw new Error('not implemented');
}
