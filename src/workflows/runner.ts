/**
 * Runs a workflow for one item (docs/0.4.0/workflows.md, "Runs"): from the start step along the
 * outcomes until `done`, `wait` (a person must act) or `stuck` (no outcome matched, or a step
 * threw). Every model answer and every effect is recorded, so a replay can run the recorded case
 * against a changed workflow with the effects muted and the model answering from the recording
 * (decisions.md, D9).
 */
import { createHash, randomBytes } from 'node:crypto';
import { loadBooks, saveBooks, update, type Actor, type Books } from '../books/store.js';
import type { AskOptions } from '../llm/ask.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { ACTIONS, type Effects } from './actions.js';
import { stepOf, type WorkflowDecl } from './model.js';

export interface LlmCall { promptSha: string; answer: string }

export interface EffectRecord {
  effect: keyof Effects;
  /** The idempotency key: an effect a run already had is skipped on any rerun. */
  key: string;
  applied: boolean;
  value: unknown;
}

export interface StepRecord {
  step: string;
  outcome?: string;
  output?: Record<string, unknown>;
  llm: LlmCall[];
  effects: EffectRecord[];
  error?: string;
}

export type RunStatus = 'done' | 'waiting' | 'stuck';

export interface Run {
  id: string;
  workflow: string;
  version: string;
  item: { kind: 'transaction'; ref: string };
  mode: 'live' | 'replay';
  /** For a replay, the run it replays. */
  of?: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  steps: StepRecord[];
}

export interface RunDeps {
  ws: Workspace;
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
  now?: () => string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** One live run: books what its steps decide, through the write door, with the run as actor. */
export function runWorkflow(w: WorkflowDecl, ref: string, deps: RunDeps): Promise<Run> {
  return execute(w, ref, deps, 'live');
}

/**
 * The recorded case of `recorded` on today's workflow: the model answers from the recording, in
 * order, and nothing is written. The would-be bookings are in the replay's effect records.
 */
export function replayRun(w: WorkflowDecl, recorded: Run, deps: RunDeps): Promise<Run> {
  const answers = recorded.steps.flatMap((s) => s.llm.map((c) => c.answer));
  const ask = async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error(`run ${recorded.id} recorded no further model answer`);
    return next;
  };
  return execute(w, recorded.item.ref, { ...deps, ask }, 'replay', recorded.id);
}

async function execute(w: WorkflowDecl, ref: string, deps: RunDeps, mode: Run['mode'], of?: string): Promise<Run> {
  const now = deps.now ?? (() => new Date().toISOString());
  const run: Run = {
    id: `${w.id}-${randomBytes(4).toString('hex')}`, workflow: w.id, version: w.version, item: { kind: 'transaction', ref },
    mode, ...(of ? { of } : {}), startedAt: now(), finishedAt: '', status: 'stuck', steps: [],
  };
  const actor: Actor = { kind: 'run', id: run.id, workflow: w.id };
  const state: Record<string, unknown> = {};
  const read = (): Books => loadBooks(deps.ws);
  const transaction = (b: Books): BankTransaction | undefined => b.transactions.find((t) => t.ref === ref);

  let at = w.start;
  for (let hops = 0; hops < 50; hops++) {
    const step = stepOf(w, at)!;
    const record: StepRecord = { step: at, llm: [], effects: [] };
    run.steps.push(record);
    if (step.body.kind === 'person') { run.status = 'waiting'; break; }
    const action = step.body.kind === 'action' ? ACTIONS[step.body.uses] : undefined;
    if (!action?.run) { record.error = `${at}: ${step.body.kind === 'action' ? `${step.body.uses} is not built yet` : `a ${step.body.kind} step does not run yet`}`; break; }
    const snapshot = read();
    const available: Record<string, unknown> = { ...state, books: snapshot, transaction: transaction(snapshot) };
    if (!available.transaction) { record.error = `no transaction ${ref}`; break; }
    const input = Object.fromEntries(step.reads.map((k) => [k, available[k]]));
    const ask = deps.ask && (async (prompt: string, opts: AskOptions) => {
      const answer = await deps.ask!(prompt, opts);
      record.llm.push({ promptSha: sha(prompt), answer });
      return answer;
    });
    const effects: Effects = {};
    if (step.effects.includes('ledger.book')) {
      effects['ledger.book'] = (entries: JournalEntry[]) => {
        const key = `${w.id}:${ref}:${at}`;
        if (mode === 'replay') { record.effects.push({ effect: 'ledger.book', key, applied: false, value: entries }); return; }
        const books = read();
        const applied = update(books, actor, (b) => {
          if (b.journalEntries.some((e) => e.transactionRef === ref)) return false;
          b.journalEntries.push(...entries);
          return true;
        });
        if (applied) saveBooks(deps.ws, books);
        record.effects.push({ effect: 'ledger.book', key, applied, value: entries.map((e) => e.id) });
      };
    }
    try {
      const result = await action.run(input, effects, { ws: deps.ws, ask });
      record.outcome = result.outcome;
      const output = result.output ?? {};
      const extra = Object.keys(output).filter((k) => !step.emits.includes(k));
      if (extra.length) throw new Error(`returned ${extra.join(', ')}, which ${at}/step.yaml does not emit`);
      if (Object.keys(output).length) record.output = output;
      Object.assign(state, output);
    } catch (e) {
      record.error = String(e instanceof Error ? e.message : e);
      break;
    }
    const target = step.outcomes[record.outcome];
    if (target === undefined) break;
    if (target.to === 'end') { run.status = 'done'; break; }
    at = target.step;
  }
  run.finishedAt = now();
  return run;
}
