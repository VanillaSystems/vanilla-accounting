/**
 * The automation in the browser: ONE module store (the close/data.ts pattern, grown by one cheap
 * poll of GET /api/automation?since=rev: 2 s while something runs or a panel is open, 10 s when quiet,
 * paused while the page is hidden, at once on focus). It lives in src/app/automation/ so it imports
 * neither the shell nor an area (import-cycle test); SSE from feat/live-reload can replace the poll
 * behind these hooks later without touching a consumer. read by the area, the corner, the sidebar's status line, the dock badge, the
 * trigger buttons in other areas and the drop dialog. Started once by the shell; survives the
 * Shell remount on a language change because it is module state.
 *
 *   const snap = useAutomation();                    // AutomationSnapshot | undefined
 *   const run = useRun(id);                          // Run | undefined, refetched when snap.rev moves and the run is open
 *   const runs = useRuns({ workflow, before });      // Läufe tab, paged
 *   const result = await automationCommand({ kind: 'start', workflow, item });
 *
 * Replaces shell/Intake.tsx's watchIntake (1 s / 10 s polling of /api/intake) in unit 9, and the
 * shell's books reload after an intake job: when snapshot.booksRev moves, the store calls the
 * shell's refresh() once.
 */
import type { AutomationCommand, AutomationSnapshot, CommandResult, Run, RunSummary } from '../../workflows/model.js';

/** Starts the poll (GET /api/automation?since=rev, 2 s busy / 10 s quiet, paused when hidden); backs off to 30 s while the API is down; stops on STATIC_EXPORT. */
export function startAutomation(onBooksChanged: () => void): () => void {
  throw new Error('not implemented');
}

export function useAutomation(): AutomationSnapshot | undefined {
  throw new Error('not implemented');
}

export function useRun(id: string): { run?: Run; error?: string } {
  throw new Error('not implemented');
}

export function useRuns(q: { workflow: string; before?: string }): { rows: RunSummary[]; more: boolean; error?: string } {
  throw new Error('not implemented');
}

/** POST /api/automation; the next snapshot arrives through the poll, so callers do not refresh by hand. */
export function automationCommand(cmd: AutomationCommand): Promise<CommandResult> {
  throw new Error('not implemented');
}
