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
  | { key: 'collected' | 'read' | 'booked' | 'waiting'; n: number }
  /** Payments of the period booked, `n` of `of`, a person's by hand among them: a fact of its own, beside the receipts (#365). */
  | { key: 'payments'; n: number; of: number }
  /** Booked by the app with nobody's change, in % of the bookings whose author the books record. */
  | { key: 'withoutYou'; pct: number };

export interface DockWidget {
  state: WidgetState;
  /**
   * The figures stacked in the narrow bar and in a row in the wide one: receipts read, receipts booked,
   * waiting; or, when more payments are booked than receipts (bookings by hand, wages, the bank's fee,
   * receipts no AI read), the payments booked of the period's payments in words, then waiting (#385).
   */
  stack: WidgetFigure[];
  /** The summary card's figures: collected, read, booked, and the share without the person only when the books record it. */
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

/**
 * Whether the bar says the payments booked rather than the receipts: the books hold more booked payments
 * than booked receipts, so «0 gebucht» beside eleven bookings would read as «nothing happened» (#385).
 */
export const paymentsMatter = (f: Pick<HomeFigures, 'booked' | 'payments' | 'paymentsBooked'>): boolean => f.payments > 0 && f.paymentsBooked > f.booked;

/** `view` is absent while the automation is not loaded (the static export): the figures stand, nothing runs. */
export function dockWidget(f: HomeFigures, view: View | undefined, forMe: number, now: Date): DockWidget {
  const waiting = (view ? openCount(view) : 0) + forMe;
  const run = view?.runs.find((r) => r.mode === 'live' && (r.status === 'running' || r.status === 'queued'));
  const next = view?.workflows
    .flatMap((w) => { const at = workflowState(w, view, now).next; return at ? [{ workflow: w.id, at }] : []; })
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  return {
    state: run ? 'running' : waiting ? 'waiting' : 'idle',
    stack: paymentsMatter(f)
      ? [{ key: 'payments', n: f.paymentsBooked, of: f.payments }, { key: 'waiting', n: waiting }]
      : [{ key: 'read', n: f.read }, { key: 'booked', n: f.booked }, { key: 'waiting', n: waiting }],
    card: [
      { key: 'collected', n: f.collected },
      { key: 'read', n: f.read },
      { key: 'booked', n: f.booked },
      ...(f.payments ? [{ key: 'payments' as const, n: f.paymentsBooked, of: f.payments }] : []),
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
