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
  effects: string[];
  /** A model decides in it: the step is an AI step, marked with the bot icon wherever it shows. */
  ai?: boolean;
  /** Absent: declared but not built yet. A workflow that uses it is drawn and explained, but cannot start. */
  run?(input: Record<string, unknown>, effects: Effects, ctx: ActionContext): Promise<ActionResult> | ActionResult;
}

/** An action declared for a workflow whose code does not exist yet (docs/0.4.0/ui/design.md, "runnable"). */
const declared = (outcomes: string[], o: { effects?: string[]; ai?: boolean } = {}): Action => ({ outcomes, effects: o.effects ?? [], ...(o.ai ? { ai: true } : {}) });

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

  'source.due': declared(['due', 'none']),
  'source.pull': declared(['ok', 'login-needed', 'missing-secret', 'changed', 'over-reach', 'rate-limited', 'person-needed'], { effects: ['inbox.add', 'records.import', 'collected.append'] }),
  'parsers.pdf-text': declared(['ok']),
  'intake.classify': declared(['receipt', 'statement', 'unclear'], { ai: true }),
  'intake.extract-vat': declared(['ok'], { ai: true }),
  'receipts.archive': declared(['ok'], { effects: ['files.write'] }),
  'parsers.statement': declared(['ok']),
  'books.merge-statement': declared(['ok'], { effects: ['books.transactions'] }),
  'books.statement-balance': declared(['matches', 'differs']),
  'evidence.match-rules': declared(['unique', 'open']),
  'evidence.match-ai': declared(['sure', 'unsure', 'none'], { ai: true }),
  'books.map': declared(['ok'], { effects: ['books.mappings'] }),
  'accounting.tax.vat-return': declared(['ok']),
  'providers.ech-0217': declared(['ok']),
  'books.seal': declared(['ok'], { effects: ['files.filings', 'books.seal'] }),
  'knowledge.add-precedent': declared(['ok'], { effects: ['knowledge.write'] }),
  'knowledge.check': declared(['valid', 'invalid']),
  'accounting.tax.vat-correction': declared(['ok']),
  'accounting.ledger.currencies': declared(['ok'], { effects: ['ledger.book'] }),
  'accounting.ledger.opening-balances': declared(['ok'], { effects: ['ledger.book'] }),
};
