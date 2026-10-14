/**
 * The actions a step may `use`, by id. A step receives only the inputs it declares in `reads` and
 * the effect handles it declares in `effects`; the action returns one of its outcomes and only
 * the outputs the step `emits`.
 */
import { classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { periodLock, type Books } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AskOptions } from '../llm/ask.js';
import { noteLines, type BooksPort, type StepRun } from '../intake/pipeline.js';
import { readStep } from '../intake/read.js';
import { vatStep } from '../intake/vat.js';
import { matchStep } from '../intake/match.js';
import { classifyStep } from '../intake/classify.js';
import { FILING_ACTIONS } from './filing.js';
import { YEAR_END_ACTIONS } from './year-end.js';
import { COLLECT_ACTIONS } from './collect.js';

export interface ActionContext {
  ws: Workspace;
  /** The run the step belongs to: its id for what it writes, its mode (a dry run delivers nothing). */
  run?: { id: string; mode: 'live' | 'dry' | 'replay' };
  /** The model, recorded by the runner; a replay answers from the recording. */
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
}

export interface Effects {
  'ledger.book'?: (entries: JournalEntry[]) => void;
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
function batch(step: StepRun): NonNullable<Action['run']> {
  return async (_input, effects, { ws, ask }) => {
    const r = await step({ ws, books: effects['books.write']!, ask, progress: () => {}, log: () => {} });
    if (r.stop) throw new Error(noteLines(r.notes).join('; '));
    return { outcome: 'ok', output: { notes: r.notes } };
  };
}

const tx = (input: Record<string, unknown>) => input.transaction as BankTransaction;
const books = (input: Record<string, unknown>) => input.books as Books;

export const ACTIONS: Record<string, Action> = {
  'ledger.transaction-state': {
    outcomes: ['open', 'booked', 'closed'],
    effects: [],
    run(input) {
      const t = tx(input);
      if (periodLock(books(input)).isClosed(t.date)) return { outcome: 'closed' };
      return { outcome: books(input).journalEntries.some((e) => e.transactionRef === t.ref) ? 'booked' : 'open' };
    },
  },

  'accounting.expenses.classification': {
    outcomes: ['decided', 'undecided'],
    effects: [],
    ai: true,
    async run(input, _effects, { ws, ask }) {
      if (!ask) return { outcome: 'undecided' };
      const scratch = structuredClone(books(input));
      const before = scratch.journalEntries.length;
      const { failed } = await classifyTransactions(scratch, [tx(input)], { ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
      if (failed.length) return { outcome: 'undecided' };
      return { outcome: 'decided', output: { entries: scratch.journalEntries.slice(before) } };
    },
  },

  'ledger.book': {
    outcomes: ['booked'],
    effects: ['ledger.book'],
    run(input, effects) {
      effects['ledger.book']!(input.entries as JournalEntry[]);
      return { outcome: 'booked' };
    },
  },

  ...FILING_ACTIONS,
  ...YEAR_END_ACTIONS,
  ...COLLECT_ACTIONS,
  // The inbox, one run per arrival (src/intake/): every step takes up only what is still to do.
  'intake.read': { outcomes: ['ok'], effects: ['books.write'], run: batch(readStep) },
  'intake.extract-vat': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(vatStep()) },
  'intake.match': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(matchStep) },
  'intake.book': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(classifyStep()) },
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
