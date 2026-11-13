/**
 * The figures of Automatisierung's home (docs/0.4.0/mockups/automation-leitstand.html), computed
 * from what the books and the runs record and nothing else: no estimate, no figure the books
 * cannot show. Pure, so the area and a dock widget read the same numbers (tests/automation-home.test.ts).
 *
 * The receipts of one filing period go through five stages: collected, read, matched to their
 * payment, booked, filed. Which period a receipt belongs to is `placeDay`, the one rule the dock,
 * this page and Belege share (#385).
 */
import { addDays, beforeBooks, type DatedBooks, type IsoDate } from '../../accounting/periods.js';
import { waitingForReceipt } from '../../accounting/receipt-due.js';
import type { Index, JournalEntry, Receipt } from '../../types/index.js';
import { nextRun } from '../../workflows/cron.js';
import type { AutomationView, WorkflowDecl } from '../../workflows/model.js';
import { isNoReceipt } from '../../books/discard.js';
import { receiptRead } from '../shell/drop-summary.js';

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

export const receiptDay = (r: Receipt): IsoDate => r.date ?? r.indexedAt.slice(0, 10);

/** A date in the file name the app gives a receipt (YYYYMMDD-…), Belege's date for one the reading left undated. */
const FILE_DATE = /^(20\d\d)(\d\d)(\d\d)-/;
/** A receipt's own date: the one read («» is none, an old answer of the model), else its file name's; undefined: undated. */
export function receiptDate(r: Pick<Receipt, 'date' | 'filename'>): IsoDate | undefined {
  const file = FILE_DATE.exec(r.filename);
  return r.date || (file ? `${file[1]}-${file[2]}-${file[3]}` : undefined);
}

/**
 * The day that puts a receipt in a period: the one rule of the dock, Automatisierung and Belege (#385).
 * Once it has a payment, its payment's day (the earliest of several); else its own date; a receipt with
 * neither, or dated before the working period (`openFrom`) and not in a filed quarter, is the working
 * period's: the books record no period it was dropped for, and what is still to do with it is done there.
 */
export function placeDay(paid: readonly IsoDate[], date: IsoDate | undefined, openFrom: IsoDate, closedThrough?: IsoDate): IsoDate {
  if (paid.length) return [...paid].sort()[0];
  if (date && (date >= openFrom || (!!closedThrough && date <= closedThrough))) return date;
  return openFrom;
}

/** The days of the payments a receipt is linked to, or points to in a filed quarter: what `placeDay` takes first. */
export function paidDays(r: Pick<Receipt, 'filedPayment'>, links: readonly string[], dayOf: (ref: string) => IsoDate | undefined): IsoDate[] {
  return [...links, ...(r.filedPayment ? [r.filedPayment] : [])].flatMap((ref) => dayOf(ref) ?? []);
}

export type FilingStage =
  /** The period's return is filed (or, for a firm not registered, the period is sealed). */
  | { kind: 'filed' }
  /** The period is not over yet. */
  | { kind: 'running'; ends: IsoDate }
  /** Over and not filed: due on `due`. A firm not registered has no due day. */
  | { kind: 'due'; due?: IsoDate; overdue: boolean }
  /** Over before the books begin (periods.ts beforeBooks, #345): neither owed nor overdue here. */
  | { kind: 'before' };

export interface PeriodRange { key: string; from: IsoDate; to: IsoDate }

export interface HomeFigures {
  period: PeriodRange;
  /** Receipts of the period (`placeDay`), the files that are none left out: Belege's «alle». */
  collected: number;
  /** Of those, the ones read: linked to their payment, or with their date and amount (the drop's «gelesen», receiptStateOf). */
  read: number;
  /** Of the read ones, those that show Swiss VAT. */
  withVat: number;
  /** Receipts linked to their payment (or to one in a filed quarter): Belege's «zugeordnet». */
  matched: number;
  /** Of the matched ones, those whose payment is booked. */
  booked: number;
  /** Payments of the period that moved money, each once by its ref (a charge split over two legs is one): the dock card's «von … Zahlungen» (#365). */
  payments: number;
  /** Of those, the ones with a booking, by the app or by hand, with a receipt or without (wages, the bank's fee). */
  paymentsBooked: number;
  /** The booked receipts by who booked their payment. */
  authors: Record<Author, number>;
  /**
   * The booked receipts the app booked and no person changed, in % of the booked receipts whose
   * author the books record; undefined when none of them records it.
   */
  withoutYou?: number;
  /** Payments of the period the app does not book yet because their receipt has not come (issue #29): the app's work, not the person's. */
  waitingReceipt: number;
  filing: FilingStage;
}

export interface HomeContext {
  today: IsoDate;
  /** The firm files VAT returns. */
  vatRegistered: boolean;
  /** Days after a period's end its return is due (filing().dueDays). */
  dueDays: number;
}

/** The figures need the working period's first day too (booksOpenPeriod): undated receipts without a payment are its (`placeDay`). */
export interface FigureContext extends HomeContext { openFrom: IsoDate }

/** The period's payments by ref, once each, and how many of them have a booking. */
function paymentCount(books: Index, period: PeriodRange, booked: (ref: string) => boolean): { payments: number; paymentsBooked: number } {
  const refs = new Set(books.transactions.filter((t) => t.amount !== 0 && t.date >= period.from && t.date <= period.to).map((t) => t.ref));
  return { payments: refs.size, paymentsBooked: [...refs].filter(booked).length };
}

export function homeFigures(books: Index, period: PeriodRange, ctx: FigureContext, asked: ReadonlySet<string> = new Set()): HomeFigures {
  const refsOf = new Map<string, string[]>();
  for (const m of books.mappings) refsOf.set(m.receiptId, [...(refsOf.get(m.receiptId) ?? []), m.transactionRef]);
  const entriesOf = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) entriesOf.set(e.transactionRef, [...(entriesOf.get(e.transactionRef) ?? []), e]);
  const dayOf = new Map(books.transactions.map((t) => [t.ref, t.date]));
  const paymentsOf = (r: Receipt) => [...(refsOf.get(r.id) ?? []), ...(r.filedPayment ? [r.filedPayment] : [])];
  const placed = (r: Receipt) => placeDay(paidDays(r, refsOf.get(r.id) ?? [], (ref) => dayOf.get(ref)), receiptDate(r), ctx.openFrom, books.config?.closedThrough);
  const inPeriod = books.receipts.filter((r) => !isNoReceipt(r, refsOf.get(r.id)?.length ?? 0)).filter((r) => { const d = placed(r); return d >= period.from && d <= period.to; });
  const read = inPeriod.filter((r) => receiptRead(r, paymentsOf(r).length));
  const matched = inPeriod.filter((r) => paymentsOf(r).length > 0);
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
    matched: matched.length,
    booked,
    ...paymentCount(books, period, (ref) => entriesOf.has(ref)),
    authors,
    ...(known > 0 ? { withoutYou: Math.round((authors.app / known) * 100) } : {}),
    waitingReceipt: waitingForReceipt(books, (ref) => entriesOf.has(ref), ctx.today)
      .filter((w) => w.tx.date >= period.from && w.tx.date <= period.to).length,
    filing: filingStage(books, period, ctx),
  };
}

/** Where a period's return stands today: filed, still running, over before the books begin, or over and due. */
export function filingStage(books: DatedBooks, period: Pick<PeriodRange, 'to'>, ctx: HomeContext): FilingStage {
  const closedThrough = books.config?.closedThrough;
  if (closedThrough && closedThrough >= period.to) return { kind: 'filed' };
  if (period.to >= ctx.today) return { kind: 'running', ends: period.to };
  if (beforeBooks(books, period.to)) return { kind: 'before' };
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
