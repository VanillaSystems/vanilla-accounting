/**
 * The inbox as runs (docs/0.4.0/ui/design.md unit 9): a drop, Belege's button or a new statement
 * starts the workflow that processes the inbox; a run already under way is that run. When a run
 * comes to rest the shell loads the books again, and says what the inbox's did.
 */
import { useAutomation, automationCommand, automationNow, subscribe } from './store.js';
import type { RunSummary } from '../../workflows/model.js';

export const INTAKE = 'receipt-intake';
const OPEN = new Set(['queued', 'running']);

export async function startIntake(): Promise<void> {
  await automationCommand({ kind: 'start', workflow: INTAKE, item: { kind: 'company', id: 'inbox' } });
}

export function useIntakeRunning(): boolean {
  return !!useAutomation().view?.runs.some((r) => r.workflow === INTAKE && OPEN.has(r.status));
}

/**
 * Calls `onRest` once for every run that comes to rest while the page is open, also one that
 * started and finished between two polls (seen first at rest). The runs already at rest in the
 * first view stay quiet. Every run may have written the books (the inbox, a booking, a filing's
 * seal), so the shell loads them again on each (r8f-45); what it says is the inbox's alone.
 */
export function watchRuns(onRest: (run: RunSummary) => void): () => void {
  const open = new Set<string>();
  let seen: Set<string> | undefined;
  const check = () => {
    const view = automationNow();
    if (!view) return;
    const first = !seen;
    seen ??= new Set();
    for (const r of view.runs) {
      const fresh = !seen.has(r.id);
      seen.add(r.id);
      if (OPEN.has(r.status)) open.add(r.id);
      else if (open.delete(r.id) || (fresh && !first)) onRest(r);
    }
  };
  check();
  return subscribe(check);
}

/**
 * Calls `onStep` whenever a live run still under way finished a step since the last poll: the
 * step may have written the books (the inbox's reading puts each file in as a receipt still being
 * processed), so the screens show it at once and not only when the run comes to rest (#218).
 */
export function watchSteps(onStep: () => void): () => void {
  const done = new Map<string, number>();
  let first = true;
  const check = () => {
    const view = automationNow();
    if (!view) return;
    let moved = false;
    for (const r of view.runs) {
      if (r.mode !== 'live' || !OPEN.has(r.status)) { done.delete(r.id); continue; }
      // A run first seen with steps behind it (it started between two polls) moved as well, but not on the page's first view.
      if (r.path.length > (done.get(r.id) ?? (first ? r.path.length : 0))) moved = true;
      done.set(r.id, r.path.length);
    }
    first = false;
    if (moved) onStep();
  };
  check();
  return subscribe(check);
}
