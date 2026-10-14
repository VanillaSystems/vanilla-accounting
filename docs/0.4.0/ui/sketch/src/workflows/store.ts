/**
 * The run store (D3: outside the workspace, one JSON per run), grown from today's store.ts:
 * written after EVERY step (atomic rename), not only at the end, so a crash loses at most the
 * step in flight, whose effect key makes its rerun a no-op.
 *
 * Single writer: only the engine of the process that holds `<runsDir>/engine.lock` writes here.
 * The server holds it while it is up; the CLI holds it when no server runs, and otherwise sends
 * its command to the server (cli/workflow.ts). No two processes ever write a run.
 *
 * The in-memory index is built once at open (≈ one file per booked transaction: a few thousand,
 * read in well under a second) and kept by the same writer; it is the structure every snapshot
 * reads, not a cache added later.
 */
import type { Workspace } from '../workspace/workspace.js';
import type { Run, RunId, RunSummary, WorkflowId } from './model.js';

export interface RunStore {
  get(id: RunId): Run | undefined;
  /** Newest first. `before` pages the Läufe tab. */
  list(q: { workflow?: WorkflowId; status?: Run['state']['status'][]; before?: string; limit: number }): RunSummary[];
  /** Live runs whose effects booked this entry: "Warum so gebucht?" (screen 4). From effect records, so the books need no run id field. */
  runOfEntry(entryId: string): RunId | undefined;
  /** Every run whose applied effects wrote records not yet saved (saving.ts joins these against the git diff). */
  writers(): Array<{ run: RunId; wrote: Run['steps'][number]['effects'][number]['wrote'] }>;
  /** Writes the run file and updates the index. The only write. */
  put(run: Run): void;
  /** App-local flags of the engine: paused, last fire per schedule trigger. Outside the workspace like the runs. */
  flags(): { paused: boolean; lastFire: Record<string, string> };
  setFlags(f: Partial<{ paused: boolean; lastFire: Record<string, string> }>): void;
  close(): void;
}

export class EngineBusyError extends Error {}

/** Opens the store for `ws` and takes the engine lock; EngineBusyError when another process holds it. */
export function openRunStore(ws: Workspace): RunStore {
  // TODO runsDir(ws) as today (sha16 of ws.paths.root); lock file with pid, stale when the pid is gone
  // TODO read every *.json; migrate old-shape runs (status 'waiting' without task → stuck 'no-outcome'; no `state` → derived)
  //      in memory only; they are rewritten when touched. Old runs stay readable: the CLI's booking runs show on screen 3.
  throw new Error('not implemented');
}
