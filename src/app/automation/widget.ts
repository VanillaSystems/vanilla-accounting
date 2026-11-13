/**
 * What the Automatisierung widget at the foot of the dock shows (src/app/shell/Dock.tsx): the
 * open period's figures from homeFigures, what waits for the person, and what runs or starts
 * next. Pure, so the collapsed bar, the expanded bar and the summary card read the same values
 * (tests/dock-widget.test.ts). A figure the books cannot show is not here: no estimate.
 */
import { openCount, type AutomationView, type RunSummary } from '../../workflows/model.js';
import { workflowState, type HomeFigures } from './home.js';

/** The workflow «Jetzt ausführen» starts: it fetches every source that is due, and the inbox's run reads and books what arrives. */
export const RUN_NOW = 'collection';

export type WidgetState = 'running' | 'waiting' | 'idle';

export type WidgetFigure =
  | { key: 'waiting'; n: number }
  /** Payments of the period booked, `n` of `of`, a person's by hand among them: how far the period is (#365, #398). */
  | { key: 'payments'; n: number; of: number }
  /** The period's receipts read, and of them those whose payment is booked («verbucht», #398). */
  | { key: 'receipts'; collected: number; read: number; booked: number }
  /** Booked by the app with nobody's change, in % of the bookings whose author the books record. */
  | { key: 'withoutYou'; pct: number };

export interface DockWidget {
  state: WidgetState;
  /**
   * The figures stacked in the narrow bar and in a row in the wide one: the payments booked of the
   * period's payments, with their unit, then what waits. One unit in every state (#398): the bar never
   * switches to receipts under the same word.
   */
  stack: WidgetFigure[];
  /** The summary card's lines, each naming its unit: receipts read and booked, payments booked, and the share without the person only when the books record it. */
  card: WidgetFigure[];
  /** Tasks, stuck runs and the questions for the viewer: the count the dock always showed. */
  waiting: number;
  /** The live run going now, newest first. */
  run?: RunSummary;
  /** The next scheduled start, when one is on and nothing is paused. */
  next?: { workflow: string; at: Date };
  paused: boolean;
  /** «Jetzt ausführen» can start RUN_NOW: it is declared and every step of it can execute. */
  canRun: boolean;
  /** The automation's view is loaded: only then does anything about runs and schedules hold. */
  loaded: boolean;
}

type View = Pick<AutomationView, 'runs' | 'tasks' | 'paused' | 'pending' | 'workflows'>;

/** `view` is absent while the automation is not loaded (the static export): the figures stand, nothing runs. */
export function dockWidget(f: HomeFigures, view: View | undefined, forMe: number, now: Date): DockWidget {
  const waiting = (view ? openCount(view) : 0) + forMe;
  const run = view?.runs.find((r) => r.mode === 'live' && (r.status === 'running' || r.status === 'queued'));
  const next = view?.workflows
    .flatMap((w) => { const at = workflowState(w, view, now).next; return at ? [{ workflow: w.id, at }] : []; })
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  return {
    state: run ? 'running' : waiting ? 'waiting' : 'idle',
    stack: [{ key: 'payments', n: f.paymentsBooked, of: f.payments }, { key: 'waiting', n: waiting }],
    card: [
      { key: 'receipts', collected: f.collected, read: f.read, booked: f.booked },
      { key: 'payments', n: f.paymentsBooked, of: f.payments },
      ...(f.withoutYou !== undefined ? [{ key: 'withoutYou' as const, pct: f.withoutYou }] : []),
    ],
    waiting,
    ...(run ? { run } : {}),
    ...(next ? { next } : {}),
    paused: !!view?.paused,
    canRun: !!view?.workflows.some((w) => w.id === RUN_NOW && w.runnable.ok),
    loaded: !!view,
  };
}
