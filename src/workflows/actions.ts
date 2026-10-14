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

export interface ActionContext {
  ws: Workspace;
  /** The model, recorded by the runner; a replay answers from the recording. */
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
}

export interface Effects {
  'ledger.book'?: (entries: JournalEntry[]) => void;
}

export interface ActionResult {
  outcome: string;
  output?: Record<string, unknown>;
}

export interface Action {
  outcomes: string[];
  /** The effects the action cannot run without. */
  effects: (keyof Effects)[];
  run(input: Record<string, unknown>, effects: Effects, ctx: ActionContext): Promise<ActionResult> | ActionResult;
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
};
