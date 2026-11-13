/**
 * The actions a step may `use`, by id. A step receives only the inputs it declares in `reads` and
 * the effect handles it declares in `effects`; the action returns one of its outcomes and only
 * the outputs the step `emits`.
 */
import { clearProgress, noteProgress } from './step-progress.js';
import { classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import { answerSettles, receiptKnowledge, receiptWaitOf } from '../booking/receipt-wait.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT } from '../workspace/workspace.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { bookedState } from '../accounting/payment-entries.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { heldByReconciliation, pending, reconciliationOf } from '../books/reconcile.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AskOptions } from '../llm/ask.js';
import { noteLines, stemOf, type BooksPort, type IntakeNote, type StepContext, type StepRun } from '../intake/pipeline.js';
import { readStep } from '../intake/read.js';
import { vatCandidates, vatStep } from '../intake/vat.js';
import { matchStep } from '../intake/match.js';
import { learnMerchantNames } from '../knowledge/learned-names.js';
import { classifyStep } from '../intake/classify.js';
import { entriesWithoutTheirReceipts } from '../accounting/classify-force.js';
import { FILING_ACTIONS } from './filing.js';
import { YEAR_END_ACTIONS } from './year-end.js';
import { COLLECT_ACTIONS } from './collect.js';
import { madeBetween, madeEntry, type Took } from './summary.js';
import type { Arrival, ItemRef } from './model.js';
import { ASK_WORKFLOW, CLOSED_REASON } from './held.js';
import { askSalesWithoutVat, closeSaleQuestionsHeld } from '../intake/sale-questions.js';
import { bookByRules } from './book-by-rules.js';
import { ordersPaidElsewhere } from '../intake/sales-report-import.js';
import { refuse, type Refused } from '../types/refusal.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ActionContext {
  ws: Workspace;
  /** The run the step belongs to: its id for what it writes, its mode (a dry run delivers nothing). */
  run?: { id: string; mode: 'live' | 'dry' | 'replay' };
  /** The model, recorded by the runner; a replay answers from the recording. */
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
  /** The engine's clock (an ISO time): what «today» is to a step that asks whether a period has ended. */
  now: () => string;
  /** Inbox files that came in with a run of the same workflow still waiting behind this one: that run reads them, not this one (r4c-7). */
  later?: () => ReadonlySet<string>;
  /** Changes the run's arrivals (the files that came in with it): a photo converted to PDF, a file set aside (r8k-9). */
  arrivals?: (change: (arrived: Arrival[]) => Arrival[]) => void;
}

export interface Effects {
  'ledger.book'?: (entries: JournalEntry[]) => void;
  /** Starts a run of another workflow for an item, unless one for it is still open; the starting run goes on (no parking). */
  'runs.start'?: (workflow: string, item: ItemRef) => void;
  /** Closes the run of another workflow waiting for a person on an item, with the reason: its question is answered by what this run did. */
  'runs.close'?: (workflow: string, item: ItemRef, reason: string) => void;
  /** The books through the write door as the run's actor; in a dry run or a replay, a copy that is never saved. */
  'books.write'?: BooksPort;
}

export interface ActionResult {
  outcome: string;
  output?: Record<string, unknown>;
}

export interface Action {
  outcomes: string[];
  /** The effects the action cannot run without. */
  effects: string[];
  /** A model decides in it: the step is an AI step, marked with the bot icon wherever it shows. */
  ai?: boolean;
  /** Absent: declared but not built yet. A workflow that uses it is drawn and explained, but cannot start. */
  run?(input: Record<string, unknown>, effects: Effects, ctx: ActionContext): Promise<ActionResult> | ActionResult;
}

/** An action declared for a workflow whose code does not exist yet (docs/0.4.0/ui/design.md, "runnable"). */
const declared = (outcomes: string[], o: { effects?: string[]; ai?: boolean } = {}): Action => ({ outcomes, effects: o.effects ?? [], ...(o.ai ? { ai: true } : {}) });

/**
 * A step of the inbox processing as an action: it runs on the books through the run's handle, its
 * notes (what waits for the model, what failed) are its output, and a step that stops gets the
 * run stuck with its reason, nothing written.
 */
function batch(step: StepRun, took: (books: Books, ws: Workspace, later?: () => ReadonlySet<string>) => Took[]): NonNullable<Action['run']> {
  return async (_input, effects, { ws, ask, later, arrivals, run }) => {
    const port = effects['books.write']!;
    // How far the step is, for a live run's progress bar (step-progress.ts): in memory only, gone when the step ends.
    const progress = run?.mode === 'live' ? (done: number, total: number) => noteProgress(run.id, done, total) : () => {};
    const before = structuredClone(port.read());
    const todo = took(before, ws, later);
    const start = effects['runs.start'];
    const close = effects['runs.close'];
    // A payment a company rule holds for the person becomes a question of its own (workflows/ask); one booked now closes its question (r7h-21).
    const hold = start && ((refs: string[]) => refs.forEach((id) => start(ASK_WORKFLOW, { kind: 'transaction', id })));
    const release = close && ((refs: string[]) => refs.forEach((id) => close(ASK_WORKFLOW, { kind: 'transaction', id }, CLOSED_REASON)));
    // The row of a dropped file follows what the read step made of it: the PDF a photo became, or quarantine (r8k-9).
    const arrived: StepContext['arrived'] = arrivals && {
      renamed: (inbox, next) => arrivals((all) => all.map((a) => (a.kind === 'receipt' && a.inbox === inbox ? { ...a, ...next } : a))),
      refused: (inbox, reason) => arrivals((all) => all.map((a) => (a.kind === 'receipt' && a.inbox === inbox ? { kind: 'refused', file: a.file, reason } : a))),
    };
    const r = await step({ ws, books: port, ask, progress, log: () => {}, ...(hold ? { hold } : {}), ...(release ? { release } : {}), ...(later ? { later } : {}), ...(arrived ? { arrived } : {}) }).finally(() => { if (run) clearProgress(run.id); });
    if (r.stop) throw stopped(r.notes);
    // What it read and what it made, for the run view (src/workflows/summary.ts).
    return { outcome: 'ok', output: { took: todo, made: madeBetween(before, port.read()), notes: r.notes } };
  };
}

/** After a live run of `run`, the merchant names its confirmed links teach go into the company's business files (#190, src/knowledge/learned-names.ts); a dry run or a replay writes no knowledge. */
function learning(run: NonNullable<Action['run']>): NonNullable<Action['run']> {
  return async (input, effects, ctx) => {
    const out = await run(input, effects, ctx);
    if (ctx.run?.mode === 'live') learnMerchantNames(ctx.ws, effects['books.write']!.read());
    return out;
  };
}

/** The refusal of an inbox step that stopped: the first note that stops it, in the screens' words; the log keeps every note. */
function stopped(notes: IntakeNote[]): Refused {
  const message = noteLines(notes).join('; ');
  const first = notes[0];
  switch (first?.code) {
    case 'unmatched': return refuse('statementsUnmatched', { n: String(first.files.length), files: first.files.join(', ') }, message);
    case 'error': return /two year folders/.test(first.detail) ? refuse('receiptsTwice', { files: first.detail.split(':')[0] }, message) : refuse('stepFailed', { detail: first.detail }, message);
    default: return refuse('stepFailed', { detail: message }, message);
  }
}

/** The documents lying in the inbox (PDFs and photos): what reading has in front of it. */
const inboxFiles = (_b: Books, ws: Workspace, later?: () => ReadonlySet<string>): Took[] => {
  const dir = ws.paths.inbox;
  const theirs = later?.();
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.') && /\.(pdf|png|jpe?g|heic|heif|webp|tiff?)$/i.test(f) && statSync(join(dir, f)).isFile() && !theirs?.has(stemOf(f))).sort() : [];
  return names.length ? [{ kind: 'files', names }] : [];
};
const receiptsWhere = (keep: (r: Books['receipts'][number]) => boolean) => (b: Books): Took[] => {
  const rs = b.receipts.filter(keep);
  return rs.length ? [{ kind: 'receipts', ids: rs.map((r) => r.id), files: rs.map((r) => r.filename) }] : [];
};
/** New payments, and payments booked before a receipt was linked to them (booked again); those an account's reconciliation holds (#254) are named with it, never left out silently. */
export const unbooked = (b: Books): Took[] => {
  const booked = new Set(b.journalEntries.map((e) => e.transactionRef));
  const again = new Set(entriesWithoutTheirReceipts(b.journalEntries, b.mappings, new Set(b.transactions.map((t) => t.ref)), periodLock(b).closedThrough).map((e) => e.transactionRef));
  const open = b.transactions.filter((t) => (!booked.has(t.ref) || again.has(t.ref)) && !periodLock(b).isClosed(t.date) && !t.waitsForPerson);
  const held = heldByReconciliation(b);
  const n = open.filter((t) => !held.has(t.ref)).length;
  const waiting = pending(b).flatMap((r): Took[] => {
    const mine = open.filter((t) => r.read.includes(t.ref) || r.bank.includes(t.ref));
    return mine.length ? [{ kind: 'held', account: r.account, n: mine.length, payment: mine[0].ref, date: mine[0].date }] : [];
  });
  return [...(n ? [{ kind: 'transactions' as const, n }] : []), ...waiting];
};

const tx = (input: Record<string, unknown>) => input.transaction as BankTransaction;
const books = (input: Record<string, unknown>) => input.books as Books;

export const ACTIONS: Record<string, Action> = {
  'ledger.transaction-state': {
    outcomes: ['open', 'booked', 'closed'],
    effects: [],
    run(input, _effects, { ws }) {
      const t = tx(input);
      if (periodLock(books(input)).isClosed(t.date)) return { outcome: 'closed' };
      return { outcome: bookedState(books(input), t.ref, ws.bankAccounts) === 'booked' ? 'booked' : 'open' };
    },
  },

  'accounting.expenses.classification': {
    outcomes: ['decided', 'undecided', 'held'],
    effects: [],
    ai: true,
    // Code first: a rule books without the model; without one and without a model the step says why it waits (r4c-34).
    async run(input, effects, { ws, ask }) {
      const scratch = structuredClone(books(input));
      const before = scratch.journalEntries.length;
      const t = tx(input);
      // A payment a person booked in part (one line of a split undone, r9k-2) is hers to finish: no rule or model books over her lines.
      if (bookedState(scratch, t.ref, ws.bankAccounts) === 'partly') return { outcome: 'undecided', output: { why: 'partlyBooked' } };
      // A movement of an account's reconciliation that waits (#254): booked now, it might count twice.
      if (reconciliationOf(scratch, t.ref)) return { outcome: 'held', output: { why: 'reconcile' } };
      const fx = loadFxResolver();
      const context = loadClassifyContext(ws);
      // No provisional booking: a payment that needs a receipt waits for it, as in the inbox run (issue #29).
      // An answer that only settles (the owner's outlays paid back) has no receipt of its own and is booked (issue #90).
      const wait = receiptWaitOf(scratch, t, context, receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), fx);
      const waits = wait.wait;
      if (wait.wait && wait.unread) return { outcome: 'held', output: { why: 'receiptUnread' } };
      if (waits && (!ask || t.waitsForReceipt?.decided)) return { outcome: 'held', output: { why: 'waitsForReceipt' } };
      const { classified, failed, asked, unasked } = await classifyTransactions(scratch, [t], { ask, fx, context });
      const entries = scratch.journalEntries.slice(before);
      if (waits && !answerSettles(t, entries, context)) return { outcome: 'held', output: { why: 'waitsForReceipt' } };
      if (!failed.length && classified.length) return { outcome: 'decided', output: { entries } };
      // A rule holds the payment for the person: its one question (workflows/ask) is the task, not «Bewegung von Hand buchen» (r7h-27).
      if (asked.length) {
        effects['runs.start']?.(ASK_WORKFLOW, { kind: 'transaction', id: t.ref });
        closeSaleQuestionsHeld(ws, [t.ref], scratch.config.closedThrough);
        return { outcome: 'held', output: { why: 'asked' } };
      }
      return { outcome: 'undecided', output: { why: unasked.length ? 'noModel' : failed.length ? 'failed' : 'asked' } };
    },
  },

  'booking.rule-question': {
    outcomes: ['proposed', 'open', 'gone', 'noModel', 'booked', 'waits'],
    effects: [],
    ai: true,
    async run(input, _effects, { ws, ask, run }) {
      const b = books(input);
      const t = tx(input);
      if (periodLock(b).isClosed(t.date) || b.journalEntries.some((e) => e.transactionRef === t.ref)) return { outcome: 'gone' };
      const scratch = structuredClone(b);
      const before = scratch.journalEntries.length;
      const fx = loadFxResolver();
      const context = loadClassifyContext(ws);
      const { asked } = await classifyTransactions(scratch, [t], { ask, fx, context });
      const held = asked[0];
      if (!held) {
        // A company rule decides it (one kept since the question was asked, #396): it books it now, or, when the
        // payment needs its receipt first, the rule books it once the receipt is there; no task says no rule matched.
        // Not a payment a reconciliation holds (#254), nor one whose only receipt cannot be read: that waits for the person, never booked on a guessed rate (#57).
        const entries = scratch.journalEntries.slice(before);
        const wait = entries.length ? receiptWaitOf(b, t, context, receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), fx) : undefined;
        if (wait && !(wait.wait && wait.unread) && !reconciliationOf(b, t.ref) && entries.every((e) => !!e.rule)) {
          // No `rule` in the output: askedBy counts it as the question of an ask rule, and this rule asked nothing.
          if (wait.wait && !answerSettles(t, entries, context)) return { outcome: 'waits' };
          // Booked here by code, not by the workflow's book step: that step's effect is applied once per payment, so a payment
          // booked once, taken back and decided again would end «booked» with nothing written (#396). A dry run writes nothing.
          if (run?.mode !== 'live') return { outcome: 'booked', output: { entries } };
          const made = await bookByRules(ws, [t.ref]);
          return made.length ? { outcome: 'booked', output: { entries: made } } : { outcome: 'gone' };
        }
        // No rule holds it: without a model it waits for a booking by hand; with one, the next inbox run books it.
        return { outcome: ask ? 'gone' : 'noModel' };
      }
      return held.entries.length
        ? { outcome: 'proposed', output: { question: held.question, rule: held.rule, entries: held.entries } }
        : { outcome: 'open', output: { question: held.question, rule: held.rule } };
    },
  },

  'ledger.book': {
    outcomes: ['booked'],
    effects: ['ledger.book'],
    run(input, effects, { ws, run }) {
      const entries = input.entries as JournalEntry[];
      effects['ledger.book']!(entries);
      // A sale without an invoice booked here is the owner's to confirm, as after the intake's booking step: its reason says the question waits (r9n-23).
      if (run?.mode === 'live') { const books = loadBooks(ws); askSalesWithoutVat(ws, books, undefined, ordersPaidElsewhere(ws, books)); }
      // What it made, for the run view and the digest («Buchen: fertig, 1 Buchung gebucht», r7f-34).
      return { outcome: 'booked', output: { made: entries.map(madeEntry) } };
    },
  },

  ...FILING_ACTIONS,
  ...YEAR_END_ACTIONS,
  ...COLLECT_ACTIONS,
  // The inbox, one run per arrival (src/intake/): every step takes up only what is still to do.
  'intake.read': { outcomes: ['ok'], effects: ['books.write'], run: batch(readStep, inboxFiles) },
  'intake.extract-vat': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(vatStep(), (b) => { const todo = new Set(vatCandidates(b, false, true)); return receiptsWhere((r) => todo.has(r))(b); }) },
  'intake.match': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: learning(batch(matchStep, receiptsWhere((r) => r.location === 'staged'))) },
  'intake.book': { outcomes: ['ok'], effects: ['books.write', 'runs.close'], ai: true, run: batch(classifyStep(), unbooked) },
  'parsers.statement': declared(['ok']),
  'books.merge-statement': declared(['ok'], { effects: ['books.transactions'] }),
  'books.statement-balance': declared(['matches', 'differs']),
  'evidence.match-rules': declared(['unique', 'open']),
  'evidence.match-ai': declared(['sure', 'unsure', 'none'], { ai: true }),
  'books.map': declared(['ok'], { effects: ['books.mappings'] }),
  'knowledge.add-precedent': declared(['ok'], { effects: ['knowledge.write'] }),
  'knowledge.check': declared(['valid', 'invalid']),
  'accounting.tax.vat-correction': declared(['ok']),
};
