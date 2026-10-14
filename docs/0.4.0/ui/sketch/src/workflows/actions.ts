/**
 * The action table: every action id any declaration may `use`, with its contract. One list.
 * An action may be declared before it is implemented (`run` absent): the declarations that use it
 * load, draw and explain themselves, and are `runnable: { ok: false }` until it lands. This is how
 * the nine workflows appear on screens 1 and 2 at once while each becomes runnable in its own step
 * (rationale.md, delivery units 2 and 12).
 *
 * The existing batch code is wrapped per item, not re-written: intake's read/vat steps, the
 * statement import, the year close and the seal already exist; an action calls them for ONE item.
 */
import type { Books } from '../books/store.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AskOptions } from '../llm/ask.js';
import type { FileSource } from './load.js';
import type { ActionId, ItemRef } from './model.js';

/** The handles a step gets for the effects it declares (rule 4). Each writes through `update(books, run actor, …)`. */
export interface Effects {
  'ledger.book'?: (entries: unknown[]) => void;
  'books.mappings'?: (pairs: Array<{ receipt: string; transaction: string }>) => void;
  'books.transactions'?: (statement: string) => void;
  'files.write'?: (from: string, to: string) => void;
  'knowledge.write'?: (path: string, text: string) => void;
  'books.seal'?: (period: string) => void;
}
export type EffectId = keyof Effects;

export interface ActionContext {
  ws: Workspace;
  item: ItemRef;
  /** The books as of now, read fresh before the step; never written through this. */
  books(): Books;
  /** The guides and knowledge in the run's declaration source (saved for live runs, draft for dry runs). */
  files: FileSource;
  /** Absent in a replay without a recording left, or with no working claude CLI. */
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
  /** Progress inside a long step, for the bar ("18/41 · Bewegungen zugeordnet"). */
  progress(n: number, of: number, label?: string): void;
}

export interface ActionResult {
  outcome: string;
  output?: Record<string, unknown>;
}

/** A transient failure the step's `retry:` may cover; anything else thrown makes the run stuck. */
export class TransientError extends Error {
  constructor(readonly kind: 'network' | 'timeout' | 'unavailable', message: string) { super(message); }
}

export interface ActionSpec {
  outcomes: readonly string[];
  effects: readonly EffectId[];
  /** A model decides in this action: the step is an AI step (bot icon, --ai colour, AI slot). */
  ai: boolean;
  /** Returns an outcome only (no output, no effect): drawn as a decision. */
  pure?: boolean;
  /** Absent: declared, not yet implemented (the workflow is not runnable). */
  run?(input: Record<string, unknown>, effects: Effects, ctx: ActionContext): Promise<ActionResult> | ActionResult;
}

/**
 * The table. Ids are the command registry's (ADR 0005); an id here that the registry does not
 * know fails tests/actions.test.ts, so the CLI, MCP and workflows name the same things.
 */
export const ACTIONS: Record<string, ActionSpec> = {
  // implemented today (booking pilot), kept
  'ledger.transaction-state': { outcomes: ['open', 'booked', 'closed'], effects: [], ai: false, pure: true, run: () => { throw new Error('not implemented'); } },
  'accounting.expenses.classification': { outcomes: ['decided', 'no-rule', 'unsure'], effects: [], ai: true, run: () => { throw new Error('not implemented'); } },
  'ledger.book': { outcomes: ['booked'], effects: ['ledger.book'], ai: false, run: () => { throw new Error('not implemented'); } },
  // wrapped per item in unit 9 (they exist as batch code today); declared now
  'intake.read': { outcomes: ['receipt', 'statement', 'unclear'], effects: [], ai: true },
  'intake.extract-vat': { outcomes: ['ok', 'unreadable'], effects: [], ai: true },
  'receipts.archive': { outcomes: ['ok'], effects: ['files.write'], ai: false },
  'statements.import': { outcomes: ['ok'], effects: ['books.transactions'], ai: false },
  'statements.balance-check': { outcomes: ['matches', 'differs'], effects: [], ai: false, pure: true },
  'evidence.match-rules': { outcomes: ['unique', 'open'], effects: [], ai: false },
  'evidence.match-ai': { outcomes: ['sure', 'unsure', 'no-receipt'], effects: [], ai: true },
  'books.map': { outcomes: ['ok'], effects: ['books.mappings'], ai: false },
  'fx.fetch-daily-rates': { outcomes: ['ok'], effects: [], ai: false },
  'accounting.tax.vat-return': { outcomes: ['ok'], effects: [], ai: false },
  'providers.ech-0217': { outcomes: ['ok'], effects: [], ai: false },
  'books.seal': { outcomes: ['ok'], effects: ['books.seal'], ai: false },
  'knowledge.add-precedent': { outcomes: ['ok'], effects: ['knowledge.write'], ai: false },
  'collect.imap': { outcomes: ['ok'], effects: [], ai: false },
  'collect.portal': { outcomes: ['ok', 'login-needed'], effects: [], ai: true },
  'inbox.stage': { outcomes: ['ok'], effects: ['files.write'], ai: false },
  // … year-close, correction: declared with their workflows in unit 2
};

export const implemented = (id: ActionId): boolean => !!ACTIONS[id]?.run;
