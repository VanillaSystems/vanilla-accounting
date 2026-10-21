/**
 * The figures of Automatisierung's home (docs/0.4.0/mockups/automation-leitstand.html), computed
 * from what the books and the runs record and nothing else: no estimate, no figure the books
 * cannot show. Pure, so the area and a dock widget read the same numbers (tests/automation-home.test.ts).
 *
 * The receipts of one filing period go through five stages: collected, read, matched to their
 * payment, booked, filed. A receipt belongs to the period of its date, or of the day it came in
 * while it is not read yet.
 */
import { addDays, type IsoDate } from '../../accounting/periods.js';
import type { Index, JournalEntry, Receipt } from '../../types/index.js';
import { nextRun } from '../../workflows/cron.js';
import type { AutomationView, WorkflowDecl } from '../../workflows/model.js';

/** Who made a booking as it stands, read from the entry's `run`, `origin` and `by`. */
export type Author =
  /** The app (a workflow run, the classifier, a rule, a check, the AI, an invoice's payment), untouched since. */
  | 'app'
  /** The app booked it as a person answered when its run asked her («Übernehmen»). */
  | 'asked'
  /** The app booked it, a person (or the AI sidebar on her wish) changed it since. */
  | 'changed'
  /** A person booked it. */
  | 'person'
  /** The entry does not say: booked before the books recorded it, or by another writer. */
  | 'unknown';

const madeByApp = (e: JournalEntry) => !!e.run || e.origin === 'classify' || e.origin === 'invoice'
  || e.by?.kind === 'rule' || e.by?.kind === 'code' || e.by?.kind === 'model';
const byPerson = (e: JournalEntry) => e.origin === 'manual' || e.by?.kind === 'person' || e.by?.kind === 'assistant';

/** `asked`: the runs that waited for a person before they booked (askedRuns). */
export function authorOf(e: JournalEntry, asked: ReadonlySet<string> = new Set()): Author {
  // A person's change keeps the fields as they were in `was`: someone else had decided them first.
  const was = (e.by?.kind === 'person' || e.by?.kind === 'assistant') && !!e.by.was;
  if (madeByApp(e) || was) return byPerson(e) ? 'changed' : e.run && asked.has(e.run) ? 'asked' : 'app';
  return byPerson(e) ? 'person' : 'unknown';
}

/** One payment's bookings as one author: the app only if every known line is the app's and untouched. */
export function authorOfBooking(entries: readonly JournalEntry[], asked?: ReadonlySet<string>): Author {
  const known = entries.map((e) => authorOf(e, asked)).filter((a) => a !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.every((a) => a === 'app')) return 'app';
  if (known.every((a) => a === 'person')) return 'person';
  if (known.every((a) => a === 'app' || a === 'asked')) return 'asked';
  return 'changed';
}

/** The runs that went through a step of a person (a question, «Übernehmen»): what they booked was not booked without her. */
export function askedRuns(view: Pick<AutomationView, 'runs' | 'workflows'>): Set<string> {
  const personSteps = new Map(view.workflows.map((w) => [w.id, new Set(w.steps.filter((s) => s.body.kind === 'person').map((s) => s.id))]));
  return new Set(view.runs.filter((r) => r.path.some((s) => personSteps.get(r.workflow)?.has(s))).map((r) => r.id));
}

/** Kinds that are paid by a payment, so matching and booking apply; a kind not set yet is taken for one. */
const payable = (r: Receipt) => r.kind === undefined || r.kind === 'invoice' || r.kind === 'sales-record';
/** Not a document of the books: the same document twice, or mail that is no receipt. */
const counted = (r: Receipt) => r.kind !== 'duplicate' && r.kind !== 'noise';
const isRead = (r: Receipt) => r.amount !== undefined;
export const receiptDay = (r: Receipt): IsoDate => r.date ?? r.indexedAt.slice(0, 10);

export type FilingStage =
  /** The period's return is filed (or, for a firm not registered, the period is sealed). */
  | { kind: 'filed' }
  /** The period is not over yet. */
  | { kind: 'running'; ends: IsoDate }
  /** Over and not filed: due on `due`. A firm not registered has no due day. */
  | { kind: 'due'; due?: IsoDate; overdue: boolean };

export interface PeriodRange { key: string; from: IsoDate; to: IsoDate }

export interface HomeFigures {
  period: PeriodRange;
  /** Receipts of the period, duplicates and noise left out. */
  collected: number;
  /** Of those, the ones whose figures are read (an amount). */
  read: number;
  /** Of the read ones, those that show Swiss VAT. */
  withVat: number;
  /** Receipts paid by a payment (invoices, sales records, kind not set yet). */
  payable: number;
  /** Of those, linked to their payment (or to one in a filed quarter). */
  matched: number;
  /** Of the matched ones, those whose payment is booked. */
  booked: number;
  /** The booked receipts by who booked their payment. */
  authors: Record<Author, number>;
  /**
   * The booked receipts the app booked and no person changed, in % of the booked receipts whose
   * author the books record; undefined when none of them records it.
   */
  withoutYou?: number;
  filing: FilingStage;
}

export interface HomeContext {
  today: IsoDate;
  /** The firm files VAT returns. */
  vatRegistered: boolean;
  /** Days after a period's end its return is due (filing().dueDays). */
  dueDays: number;
}

export function homeFigures(books: Index, period: PeriodRange, ctx: HomeContext, asked: ReadonlySet<string> = new Set()): HomeFigures {
  const inPeriod = books.receipts.filter((r) => counted(r) && receiptDay(r) >= period.from && receiptDay(r) <= period.to);
  const read = inPeriod.filter(isRead);
  const refsOf = new Map<string, string[]>();
  for (const m of books.mappings) refsOf.set(m.receiptId, [...(refsOf.get(m.receiptId) ?? []), m.transactionRef]);
  const entriesOf = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) entriesOf.set(e.transactionRef, [...(entriesOf.get(e.transactionRef) ?? []), e]);
  const paymentsOf = (r: Receipt) => [...(refsOf.get(r.id) ?? []), ...(r.filedPayment ? [r.filedPayment] : [])];
  const toPay = inPeriod.filter(payable);
  const matched = toPay.filter((r) => paymentsOf(r).length > 0);
  const authors: Record<Author, number> = { app: 0, asked: 0, changed: 0, person: 0, unknown: 0 };
  let booked = 0;
  for (const r of matched) {
    const entries = paymentsOf(r).flatMap((ref) => entriesOf.get(ref) ?? []);
    if (!entries.length) continue;
    booked++;
    authors[authorOfBooking(entries, asked)]++;
  }
  const known = booked - authors.unknown;
  return {
    period,
    collected: inPeriod.length,
    read: read.length,
    withVat: read.filter((r) => r.hasSwissVat === true).length,
    payable: toPay.length,
    matched: matched.length,
    booked,
    authors,
    ...(known > 0 ? { withoutYou: Math.round((authors.app / known) * 100) } : {}),
    filing: filingStage(books.config?.closedThrough, period, ctx),
  };
}

function filingStage(closedThrough: IsoDate | undefined, period: PeriodRange, ctx: HomeContext): FilingStage {
  if (closedThrough && closedThrough >= period.to) return { kind: 'filed' };
  if (period.to >= ctx.today) return { kind: 'running', ends: period.to };
  if (!ctx.vatRegistered) return { kind: 'due', overdue: false };
  const due = addDays(period.to, ctx.dueDays);
  return { kind: 'due', due, overdue: due < ctx.today };
}

/** A workflow's dot in the list: running, waiting for a person or stuck, last run fine, never run, cannot run yet. */
export type Dot = 'run' | 'warn' | 'ok' | 'idle' | 'off';

export interface WorkflowState {
  dot: Dot;
  /** Open tasks and stuck runs. */
  open: number;
  /** The step it is on, when a run of it is running. */
  at?: string;
  /** Its next scheduled start, when a schedule is on and the automation is not paused. */
  next?: Date;
  /** Steps that cannot execute yet (runnable.missing). */
  missing: number;
}

export function workflowState(w: WorkflowDecl, view: Pick<AutomationView, 'runs' | 'tasks' | 'paused' | 'pending'>, now: Date): WorkflowState {
  const runs = view.runs.filter((r) => r.workflow === w.id && r.mode === 'live');
  const missing = w.runnable.ok ? 0 : w.runnable.missing.length;
  const open = view.tasks.filter((x) => x.workflow === w.id).length + runs.filter((r) => r.status === 'stuck').length;
  const running = runs.find((r) => r.status === 'running' || r.status === 'queued' || r.status === 'parked');
  const held = view.paused || view.pending.some((p) => p.workflow === w.id);
  const next = !w.runnable.ok || held ? undefined : w.triggers
    .flatMap((tr) => (tr.kind === 'schedule' && !tr.off ? [nextRun(tr.cron, now)] : []))
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  // Newest first: the last run that came to rest says whether it went well.
  const last = runs.find((r) => r.status === 'done' || r.status === 'stuck' || r.status === 'discarded');
  const dot: Dot = !w.runnable.ok ? 'off' : running ? 'run' : open ? 'warn' : last ? 'ok' : 'idle';
  return { dot, open, missing, ...(running?.at ? { at: running.at } : {}), ...(next ? { next } : {}) };
}
