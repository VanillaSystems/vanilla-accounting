/**
 * The inbox as runs (docs/0.4.0/ui/design.md unit 9): a drop, Belege's button or a new statement
 * starts the workflow that processes the inbox; a run already under way is that run. When one
 * comes to rest the shell loads the books again and says what it did.
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
 * Calls `onRest` once for every inbox run that comes to rest while the page is open, also one
 * that started and finished between two polls (seen first at rest). The runs already at rest in
 * the first view stay quiet.
 */
export function watchIntakeRuns(onRest: (run: RunSummary) => void): () => void {
  const open = new Set<string>();
  let seen: Set<string> | undefined;
  const check = () => {
    const view = automationNow();
    if (!view) return;
    const first = !seen;
    seen ??= new Set();
    for (const r of view.runs) {
      if (r.workflow !== INTAKE) continue;
      const fresh = !seen.has(r.id);
      seen.add(r.id);
      if (OPEN.has(r.status)) open.add(r.id);
      else if (open.delete(r.id) || (fresh && !first)) onRest(r);
    }
  };
  check();
  return subscribe(check);
}
