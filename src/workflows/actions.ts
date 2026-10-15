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
import { vatCandidates, vatStep } from '../intake/vat.js';
import { matchStep } from '../intake/match.js';
import { classifyStep } from '../intake/classify.js';
import { FILING_ACTIONS } from './filing.js';
import { YEAR_END_ACTIONS } from './year-end.js';
import { COLLECT_ACTIONS } from './collect.js';
import { madeBetween, type Took } from './summary.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
function batch(step: StepRun, took: (books: Books, ws: Workspace) => Took[]): NonNullable<Action['run']> {
  return async (_input, effects, { ws, ask }) => {
    const port = effects['books.write']!;
    const before = structuredClone(port.read());
    const todo = took(before, ws);
    const r = await step({ ws, books: port, ask, progress: () => {}, log: () => {} });
    if (r.stop) throw new Error(noteLines(r.notes).join('; '));
    // What it read and what it made, for the run view (src/workflows/summary.ts).
    return { outcome: 'ok', output: { took: todo, made: madeBetween(before, port.read()), notes: r.notes } };
  };
}

/** The documents lying in the inbox (PDFs and photos): what reading has in front of it. */
const inboxFiles = (_b: Books, ws: Workspace): Took[] => {
  const dir = ws.paths.inbox;
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.') && /\.(pdf|png|jpe?g|heic|heif|webp|tiff?)$/i.test(f) && statSync(join(dir, f)).isFile()).sort() : [];
  return names.length ? [{ kind: 'files', names }] : [];
};
const receiptsWhere = (keep: (r: Books['receipts'][number]) => boolean) => (b: Books): Took[] => {
  const rs = b.receipts.filter(keep);
  return rs.length ? [{ kind: 'receipts', ids: rs.map((r) => r.id), files: rs.map((r) => r.filename) }] : [];
};
const unbooked = (b: Books): Took[] => {
  const booked = new Set(b.journalEntries.map((e) => e.transactionRef));
  const n = b.transactions.filter((t) => !booked.has(t.ref) && !periodLock(b).isClosed(t.date)).length;
  return n ? [{ kind: 'transactions', n }] : [];
};

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
  'intake.read': { outcomes: ['ok'], effects: ['books.write'], run: batch(readStep, inboxFiles) },
  'intake.extract-vat': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(vatStep(), (b) => { const todo = new Set(vatCandidates(b)); return receiptsWhere((r) => todo.has(r))(b); }) },
  'intake.match': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(matchStep, receiptsWhere((r) => r.location === 'staged')) },
  'intake.book': { outcomes: ['ok'], effects: ['books.write'], ai: true, run: batch(classifyStep(), unbooked) },
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
