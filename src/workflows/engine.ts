/**
 * The workflow engine (docs/0.4.0/ui/design.md, "The engine is one state machine"): the one place
 * a run moves. advance() executes one step and saves the run; pump() picks queued runs within the
 * slots (two AI steps, four others at a time) and lanes, and drives each to rest: done, waiting
 * for a person, parked for an event, or stuck. Every state change goes through transition(), every
 * write to the books through update() with the run as actor, so a crash or a rerun never books
 * twice. Events a finished run emits start the workflows that listen; schedules start theirs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { emptyBooks, hasBooks, loadBooks, periodLock, saveBooks, update, type Actor, type Books } from '../books/store.js';
import { stemOf, type BooksPort } from '../intake/pipeline.js';
import type { AskOptions } from '../llm/ask.js';
import { refusalOf, refuse, type Refused } from '../types/refusal.js';
import type { BankTransaction, JournalEntry, Mapping } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { ACTIONS, type Effects } from './actions.js';
import { cronMatches } from './cron.js';
import { loadWorkflows, type Loaded } from './load.js';
import {
  type Arrival, outputsOf, plusDuration, stepOf, transition,
  type AutomationCommand, type CommandResult, type EffectRecord, type ItemRef, type QueueReason, type Run, type RunState, type StartedBy, type StepRecord, type WorkflowDecl,
} from './model.js';
import { listRuns, saveRun } from './store.js';
import { appendLine, lineFor, type RunLogLine } from './runlog.js';

/** What a dry run or a replay records for an effect it cannot check on a copy (a seal, a filing): nothing was written. */
export const SKIPPED = 'skipped: a dry run or a replay writes no seal and no filing';
/** The outcome of such a step: not the action's `ok`, so a replay never reads like a filing. */
export const SKIPPED_OUTCOME = 'skipped';

export type Ask = (prompt: string, opts: AskOptions) => Promise<string>;

export interface EngineDeps {
  appRoot: string;
  /** The model, when one is ready; asked for each AI step, so a model set up later is used at once. */
  ask?: () => Promise<Ask | undefined>;
  now?: () => string;
  limits?: { ai: number; other: number };
  /** A company version of a workflow runs live only when approved; the app's are approved by definition. */
  isApproved?: (w: WorkflowDecl) => boolean;
  /** Switches a workflow's waiting version on (app-local, out of the workspace's reach). */
  approve?: (w: WorkflowDecl) => void;
  /** Called once a run came to rest and its run-log line (if any) is written: the records path commits here. */
  /** A run that must not be discarded (the hold of a period filed with the tax authority, src/workflows/filing.ts). */
  keeps?: (run: Run) => boolean;
  onRest?: (run: Run, line: RunLogLine | undefined) => void | Promise<void>;
  /** Where this engine runs, written on each run-log line. */
  host?: RunLogLine['host'];
  /** Takes the workspace's one-writer lock for a step that writes; throws when another process holds it. */
  lock?: () => () => void;
}

export interface Engine {
  declarations(): Loaded;
  runs(): Run[];
  run(id: string): Run | undefined;
  readonly paused: boolean;
  readonly limits: { ai: number; other: number };
  /** Bumped on every change of a run, so a poll can answer "unchanged". */
  readonly counter: number;
  command(cmd: AutomationCommand): Promise<CommandResult>;
  /** `arrived`: the files that came in with it; a start that finds the company's run under way adds them to it. */
  start(workflow: string, item: ItemRef, by: StartedBy, mode?: Run['mode'], arrived?: Arrival[]): Promise<CommandResult>;
  /** Takes a file back out of a run's arrivals (the drop dialog's «Rückgängig»). */
  withdraw(run: string, file: string): void;
  /** Starts the scheduled workflows whose cron matches this minute. */
  tick(at?: Date): Promise<void>;
  /** Resolves when no run is running or queued (for tests and the CLI). */
  idle(): Promise<void>;
}

const MAX_HOPS = 50;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const short = (v: unknown): string => {
  if (v === undefined) return '';
  if (typeof v !== 'object' || v === null) return String(v).slice(0, 80);
  if (Array.isArray(v)) return `${v.length} ×`;
  const o = v as Record<string, unknown>;
  return ['ref', 'id', 'date', 'amount', 'description'].filter((k) => o[k] !== undefined).map((k) => String(o[k])).join(', ').slice(0, 80) || `{${Object.keys(o).slice(0, 4).join(', ')}}`;
};

export function openEngine(ws: Workspace, deps: EngineDeps): Engine {
  const now = deps.now ?? (() => new Date().toISOString());
  const limits = deps.limits ?? { ai: 2, other: 4 };
  const isApproved = deps.isApproved ?? ((w: WorkflowDecl) => w.origin === 'app');
  const runs = new Map(listRuns(ws).map((r) => [r.id, r]));
  let declared = loadWorkflows(deps.appRoot, ws.paths.root);
  let paused = false;
  let counter = 0;
  const active = new Set<string>();
  /** A run that found the one-writer lock taken tries again after this time. */
  const retryAt = new Map<string, number>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let waiters: Array<() => void> = [];

  const workflow = (id: string) => declared.workflows.find((w) => w.id === id);
  /**
   * A step saves the run it started from; what a drop or a person added meanwhile (arrivals, the
   * «Geprüft» mark) stays: only annotate() writes those.
   */
  const save = (run: Run) => {
    const kept = runs.get(run.id);
    const next: Run = kept ? { ...run, arrived: kept.arrived, reviewed: kept.reviewed } : run;
    if (!next.arrived) delete next.arrived;
    if (!next.reviewed) delete next.reviewed;
    runs.set(run.id, next); saveRun(ws, next); counter++;
  };
  const annotate = (id: string, patch: Pick<Run, 'arrived' | 'reviewed'>) => {
    const next: Run = { ...runs.get(id)!, ...patch };
    if (!next.arrived?.length) delete next.arrived;
    if (!next.reviewed) delete next.reviewed;
    runs.set(id, next); saveRun(ws, next); counter++;
  };
  const move = (run: Run, next: RunState): Run => { const r = transition(run, next); save(r); return r; };

  // A run the process left running when it stopped goes back into the queue at its step.
  for (const r of runs.values()) if (r.state.status === 'running') move(r, { status: 'queued', at: r.state.at, since: now() });

  /** A run came to rest: its run-log line (rule 1 in runlog.ts decides whether there is one), then the commit hook. */
  const settle = (run: Run) => {
    if (!['done', 'waiting', 'parked', 'stuck', 'discarded'].includes(run.state.status)) return;
    const line = lineFor(run, run.logged ?? 0, deps.host);
    if (line) {
      appendLine(ws, line, loadBooks(ws).config.closedThrough);
      save({ ...run, logged: run.steps.length });
    }
    void deps.onRest?.(runs.get(run.id)!, line);
  };

  /** The slot a queued run needs: an AI slot when its next step is an AI step. */
  const slotOf = (run: Run): 'ai' | 'other' => {
    const w = workflow(run.workflow);
    const at = 'at' in run.state ? run.state.at : undefined;
    return w && at && stepOf(w, at)?.kind === 'agent' ? 'ai' : 'other';
  };
  const laneOf = (run: Run, books: Books): string | undefined => {
    // The company is one item: its live runs of one workflow go one after the other.
    if (run.item.kind === 'company' && run.mode === 'live') return `${run.workflow}:company:${run.item.id}`;
    const w = workflow(run.workflow);
    if (w?.lane !== 'account' || run.item.kind !== 'transaction') return undefined;
    return `${w.id}:${books.transactions.find((t) => t.ref === run.item.id)?.bank ?? '?'}`;
  };

  function pump(): void {
    if (paused) { notifyIdle(); return; }
    const books = loadBooks(ws);
    const busy = { ai: 0, other: 0 };
    const lanes = new Set<string>();
    for (const id of active) {
      const r = runs.get(id)!;
      busy[slotOf(r)]++;
      const lane = laneOf(r, books);
      if (lane) lanes.add(lane);
    }
    const queued = [...runs.values()].filter((r) => r.state.status === 'queued' && !active.has(r.id) && (retryAt.get(r.id) ?? 0) <= Date.now()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const later = [...retryAt.values()].filter((t) => t > Date.now());
    clearTimeout(retryTimer);
    if (later.length) retryTimer = setTimeout(pump, Math.min(...later) - Date.now());
    for (const r of queued) {
      const slot = slotOf(r);
      const lane = laneOf(r, books);
      const reason: QueueReason | undefined = busy[slot] >= limits[slot] ? (slot === 'ai' ? 'ai-slot' : 'slot') : lane && lanes.has(lane) ? 'lane' : undefined;
      if (reason) {
        if (r.state.status === 'queued' && r.state.reason !== reason) move(r, { ...r.state, reason });
        continue;
      }
      busy[slot]++;
      if (lane) lanes.add(lane);
      active.add(r.id);
      void drive(r.id).finally(() => { active.delete(r.id); pump(); });
    }
    notifyIdle();
  }

  function notifyIdle() {
    if (active.size || [...runs.values()].some((r) => r.state.status === 'queued' && !paused && r.state.reason !== 'busy')) return;
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  }

  /** Runs `id` step by step until it comes to rest. */
  async function drive(id: string): Promise<void> {
    let run = runs.get(id)!;
    if (run.state.status !== 'queued') return;
    retryAt.delete(id);
    run = move(run, { status: 'running', at: run.state.at, since: now() });
    for (let hops = 0; run.state.status === 'running'; hops++) {
      if (hops >= MAX_HOPS) { run = move(run, stuck(run.state.at, refuse('tooManySteps', { n: String(MAX_HOPS) }, `more than ${MAX_HOPS} steps in one go`))); break; }
      run = await advance(run);
    }
    settle(run);
    if (run.state.status === 'done' && run.mode === 'live') await emitFrom(run);
    if (run.state.status === 'done' || run.state.status === 'stuck' || run.state.status === 'discarded') await childRested(run);
  }

  /** One step of a running run, saved before it returns. */
  /** The stuck state of a refusal: the log's line and the words' code. */
  const stuck = (at: string, e: Refused): Extract<RunState, { status: 'stuck' }> => ({ status: 'stuck', at, since: now(), reason: e.message, why: e.why });
  /** A step that refused before it ran: its record carries the refusal too. */
  const refused = (run: Run, record: StepRecord, at: string, e: Refused): Run => move({ ...run, steps: [...run.steps, { ...record, error: e.message, why: e.why }] }, stuck(at, e));

  async function advance(run: Run): Promise<Run> {
    const state = run.state as Extract<RunState, { status: 'running' }>;
    const w = workflow(run.workflow);
    if (!w) return move(run, stuck(state.at, refuse('workflowGone', { workflow: run.workflow }, `the workflow ${run.workflow} no longer loads`)));
    const step = stepOf(w, state.at);
    if (!step) return move(run, stuck(state.at, refuse('stepGone', { workflow: w.id, step: state.at }, `${w.id} has no step ${state.at}`)));
    const body = step.body;
    const books = booksFor(run);
    const available: Record<string, unknown> = { ...outputsOf(run), books, item: run.item, [run.item.kind]: itemValue(run.item, books) };
    const input = Object.fromEntries(step.reads.map((k) => [k, short(available[k])]));
    const record: StepRecord = { step: step.id, startedAt: now(), input, llm: [], effects: [] };

    if (body.kind === 'person') return move({ ...run, steps: [...run.steps, record] }, { status: 'waiting', at: step.id, since: now() });
    if (body.kind === 'wait') {
      const until = body.timeout ? { time: plusDuration(now(), body.timeout.after) } : { event: body.for };
      return move({ ...run, steps: [...run.steps, record] }, { status: 'parked', at: step.id, since: now(), until });
    }
    if (body.kind === 'call') return call(run, w, step, record, available);
    if (body.kind === 'code') return refused(run, record, step.id, refuse('ownCodeStep', { step: step.id }, 'a step of its own code does not run yet'));

    const action = ACTIONS[body.uses];
    if (!action?.run) return refused(run, record, step.id, refuse('notBuilt', { action: body.uses }, `${body.uses} is not built yet`));
    if (run.item.kind === 'transaction' && step.reads.includes('transaction') && available.transaction === undefined) {
      return refused(run, record, step.id, refuse('transactionGone', { id: run.item.id }, `the transaction ${run.item.id} is gone`));
    }
    const inputs = Object.fromEntries(step.reads.map((k) => [k, available[k]]));
    const recorded = run.mode === 'replay' ? recordedAnswers(run) : undefined;
    const model = recorded ?? (deps.ask ? await deps.ask() : undefined);
    const ask = model && (async (prompt: string, opts: AskOptions) => {
      const answer = await model(prompt, opts);
      record.llm.push({ promptSha: sha(prompt), answer });
      return answer;
    });
    const effects = effectHandles(run, w, step.id, step.effects, record);
    let release: (() => void) | undefined;
    if (step.effects.length && run.mode === 'live' && deps.lock) {
      try {
        release = deps.lock();
      } catch {
        retryAt.set(run.id, Date.now() + 5000);
        return move(run, { status: 'queued', at: step.id, since: now(), reason: 'busy' });
      }
    }
    // An effect the engine holds no handle for (a seal, a filing) cannot be checked on a copy: a dry run or a replay skips the step, its outcome says `skipped`, never the action's ok (r5f-19), and the run goes on as if the first outcome had come.
    const unchecked = step.effects.filter((e) => e !== 'ledger.book' && e !== 'books.write' && e !== 'runs.start' && e !== 'runs.close');
    if (run.mode !== 'live' && unchecked.length) {
      record.effects.push(...unchecked.map((effect) => ({ effect, key: `${w.id}:${run.item.id}:${step.id}`, applied: false, wrote: {}, would: SKIPPED })));
      const done = { ...run, steps: [...run.steps, { ...record, outcome: SKIPPED_OUTCOME, finishedAt: now() }] };
      const target = step.outcomes[action.outcomes[0]];
      return move(done, !target || target.to === 'end' ? { status: 'done', finishedAt: now() } : { status: 'running', at: target.step, since: now() });
    }
    try {
      const result = await action.run(inputs, effects, { ws, ask, now, run: { id: run.id, mode: run.mode }, later: () => laterFiles(run), arrivals: (change) => annotate(run.id, { arrived: change(runs.get(run.id)?.arrived ?? []) }) });
      record.outcome = result.outcome;
      const output = result.output ?? {};
      const extra = Object.keys(output).filter((k) => !step.emits.includes(k));
      if (extra.length) throw refuse('emitsExtra', { step: step.id, keys: extra.join(', ') }, `returned ${extra.join(', ')}, which ${step.id}/step.yaml does not emit`);
      if (Object.keys(output).length) record.output = output;
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      const why = refusalOf(e);
      return move({ ...run, steps: [...run.steps, { ...record, error: message, ...(why ? { why } : {}), finishedAt: now() }] }, { status: 'stuck', at: step.id, since: now(), reason: message, ...(why ? { why } : {}) });
    } finally {
      release?.();
    }
    const done = { ...run, steps: [...run.steps, { ...record, finishedAt: now() }] };
    const target = step.outcomes[record.outcome!];
    if (!target) return move(done, stuck(step.id, refuse('leadsNowhere', { outcome: record.outcome!, step: step.id }, `outcome ${record.outcome} of ${step.id} leads nowhere`)));
    return move(done, target.to === 'end' ? { status: 'done', finishedAt: now() } : { status: 'running', at: target.step, since: now() });
  }

  /** The handles a step may write through. ledger.book books through the write door; a dry run or a replay checks the same booking on a copy and saves nothing. */
  function effectHandles(run: Run, w: WorkflowDecl, step: string, declared: string[], record: StepRecord): Effects {
    const effects: Effects = {};
    const actor: Actor = { kind: 'run', id: run.id, workflow: w.id };
    const key = `${w.id}:${run.item.id}:${step}`;
    if (declared.includes('books.write')) effects['books.write'] = booksPort(run, actor, key, record);
    if (declared.includes('runs.start')) {
      effects['runs.start'] = (id, item) => {
        const w = workflow(id);
        const open = [...runs.values()].some((r) => r.workflow === id && r.mode === 'live' && r.item.id === item.id && r.item.kind === item.kind && !['done', 'discarded'].includes(r.state.status));
        const rec: EffectRecord = { effect: 'runs.start', key: `${key}:${id}:${item.id}`, applied: false, wrote: {} };
        record.effects.push(rec);
        if (run.mode !== 'live') { rec.would = `${id} ${item.id}`; return; }
        // One open question per payment: a later inbox run that finds it still unbooked asks nothing new.
        if (!w?.runnable.ok || open) return;
        rec.applied = true;
        void create(w, item, { kind: 'event', name: 'rule.ask', run: run.id }, 'live');
      };
    }
    if (declared.includes('runs.close')) {
      effects['runs.close'] = (id, item, reason) => {
        const waiting = [...runs.values()].filter((r) => r.workflow === id && r.mode === 'live' && r.item.id === item.id && r.item.kind === item.kind && r.state.status === 'waiting');
        const rec: EffectRecord = { effect: 'runs.close', key: `${key}:${id}:${item.id}`, applied: false, wrote: {} };
        record.effects.push(rec);
        if (run.mode !== 'live') { rec.would = `${id} ${item.id}`; return; }
        if (!waiting.length) return;
        rec.applied = true;
        for (const r of waiting) settle(move(r, { status: 'discarded', at: now(), reason }));
      };
    }
    if (!declared.includes('ledger.book')) return effects;
    effects['ledger.book'] = (entries: JournalEntry[]) => {
      const stamped = entries.map((e) => ({ ...e, run: run.id }));
      const before = [...runs.values()].some((r) => r.mode === 'live' && r.steps.some((s) => s.effects.some((x) => x.key === key && x.applied)));
      if (run.mode !== 'live') {
        const copy = booksFor(run);
        let refused: string | undefined;
        try { update(copy, actor, (b) => { b.journalEntries.push(...stamped); }); } catch (e) { refused = (e as Error).message; }
        record.effects.push({ effect: 'ledger.book', key, applied: false, wrote: {}, would: stamped, ...(refused ? { refused } : {}) });
        return;
      }
      if (before) { record.effects.push({ effect: 'ledger.book', key, applied: false, wrote: {} }); return; }
      const books = loadBooks(ws);
      const ref = run.item.kind === 'transaction' ? run.item.id : undefined;
      // A person's answer books what they accepted: bookings the app guessed meanwhile (a later run, wishes3-7)
      // give way to it. A person's own booking never does, nor one of the person's rules: a rule that booked
      // the payment since the question was asked (its report came, r7h-21) answered it better than the proposal.
      const had = ref ? books.journalEntries.filter((e) => e.transactionRef === ref) : [];
      const replaced = had.length && had.every((e) => e.origin !== 'manual' && !e.rule && !periodLock(books).isClosed(e.date)) ? had.map((e) => e.id) : [];
      const applied = update(books, actor, (b) => {
        if (had.length && !replaced.length) return false;
        b.journalEntries = b.journalEntries.filter((e) => !replaced.includes(e.id));
        b.journalEntries.push(...stamped);
        return true;
      });
      if (applied) saveBooks(ws, books);
      const rec: EffectRecord = { effect: 'ledger.book', key, applied, wrote: applied ? { entries: stamped.map((e) => e.id) } : {}, ...(applied && replaced.length ? { replaced } : {}) };
      record.effects.push(rec);
    };
    return effects;
  }

  /**
   * The books for a step that changes them as a whole (the inbox processing): every change goes
   * through the write door as the run's actor and is saved at once; what it adds carries the run's
   * id. In a dry run or a replay it works on one copy that is never saved. The effect record names
   * what it wrote, by id.
   */
  function booksPort(run: Run, actor: Actor, key: string, record: StepRecord): BooksPort {
    const live = run.mode === 'live';
    const load = () => (run.startedBy.kind === 'check' ? booksFor(run) : hasBooks(ws) ? loadBooks(ws) : emptyBooks());
    let copy: Books | undefined;
    const wrote = { entries: [] as string[], mappings: [] as string[], receipts: [] as string[] };
    record.effects.push({ effect: 'books.write', key, applied: live, wrote });
    const link = (m: Mapping) => `${m.transactionRef}:${m.receiptId}`;
    return {
      read: () => (live ? load() : (copy ??= load())),
      update(fn) {
        const books = live ? load() : (copy ??= structuredClone(load()));
        const had = { entries: new Set(books.journalEntries.map((e) => e.id)), mappings: new Set(books.mappings.map(link)), receipts: new Set(books.receipts.map((r) => r.id)) };
        const out = update(books, actor, (b) => {
          const r = fn(b);
          for (const e of b.journalEntries) if (!had.entries.has(e.id)) { e.run = run.id; wrote.entries.push(e.id); }
          for (const m of b.mappings) if (!had.mappings.has(link(m))) { m.run = run.id; wrote.mappings.push(link(m)); }
          for (const x of b.receipts) if (!had.receipts.has(x.id)) { x.run = run.id; wrote.receipts.push(x.id); }
          return r;
        });
        if (live) saveBooks(ws, books);
        return out;
      },
    };
  }

  /** A call step: one child run per element of `forEach` (or one for the run's item); the parent parks until all children rest. */
  async function call(run: Run, w: WorkflowDecl, step: WorkflowDecl['steps'][number], record: StepRecord, available: Record<string, unknown>): Promise<Run> {
    const body = step.body as { kind: 'call'; workflow: string };
    const called = workflow(body.workflow);
    if (!called?.runnable.ok) return refused(run, record, step.id, refuse('cannotRunYet', { workflow: body.workflow }, `${body.workflow} cannot run yet`));
    const items = step.forEach ? (available[step.forEach] as ItemRef[] | undefined) ?? [] : [run.item];
    const parked = move({ ...run, steps: [...run.steps, record] }, { status: 'parked', at: step.id, since: now(), until: { event: `children:${run.id}` } });
    if (!items.length) return childRested(parked).then(() => runs.get(run.id)!);
    for (const item of items) await create(called, item, { kind: 'parent', run: run.id, step: step.id }, run.mode);
    return parked;
  }

  /** When the last child of a parked parent comes to rest, the parent goes on with outcome done. */
  async function childRested(child: Run): Promise<void> {
    const parentId = child.startedBy.kind === 'parent' ? child.startedBy.run : child.state.status === 'parked' && 'until' in child.state && 'event' in child.state.until && child.state.until.event === `children:${child.id}` ? child.id : undefined;
    if (!parentId) return;
    const parent = runs.get(parentId);
    if (!parent || parent.state.status !== 'parked') return;
    const children = [...runs.values()].filter((r) => r.startedBy.kind === 'parent' && r.startedBy.run === parentId);
    if (children.some((c) => !['done', 'stuck', 'discarded'].includes(c.state.status))) return;
    const w = workflow(parent.workflow)!;
    const step = stepOf(w, parent.state.at)!;
    const target = step.outcomes.done;
    const steps = parent.steps.map((s, i) => (i === parent.steps.length - 1 ? { ...s, outcome: 'done', finishedAt: now() } : s));
    if (!target) { settle(move({ ...parent, steps }, stuck(step.id, refuse('leadsNowhere', { outcome: 'done', step: step.id }, `outcome done of ${step.id} leads nowhere`)))); return; }
    if (target.to === 'end') { settle(move({ ...parent, steps }, { status: 'done', finishedAt: now() })); return; }
    move({ ...parent, steps }, { status: 'queued', at: target.step, since: now() });
    pump();
  }

  /** Every workflow listening to an event the finished run emits starts a run for the same item. */
  async function emitFrom(run: Run): Promise<void> {
    const w = workflow(run.workflow);
    for (const name of w?.emits ?? []) {
      for (const l of declared.workflows) {
        if (!l.runnable.ok || !isApproved(l)) continue;
        if (l.triggers.some((t) => t.kind === 'event' && t.name === name && !t.off)) await create(l, run.item, { kind: 'event', name, run: run.id }, 'live');
      }
      for (const p of [...runs.values()].filter((r) => r.state.status === 'parked' && 'until' in r.state && 'event' in r.state.until && r.state.until.event === name && r.item.id === run.item.id)) {
        const pw = workflow(p.workflow);
        const step = pw && stepOf(pw, (p.state as { at: string }).at);
        const target = step?.outcomes.arrived;
        if (target) move(p, target.to === 'end' ? { status: 'queued', at: step.id, since: now() } : { status: 'queued', at: target.step, since: now() });
      }
    }
    pump();
  }

  /** The inbox files that runs of the same workflow waiting behind `run` came in with (their stems). */
  function laterFiles(run: Run): Set<string> {
    const waiting = [...runs.values()].filter((r) => r.id !== run.id && r.workflow === run.workflow && r.mode === run.mode && r.state.status === 'queued' && r.steps.length === 0);
    return new Set(waiting.flatMap((r) => r.arrived ?? []).flatMap((a) => (a.kind === 'receipt' && a.inbox ? [stemOf(a.inbox)] : [])));
  }

  async function create(w: WorkflowDecl, item: ItemRef, by: StartedBy, mode: Run['mode'], arrived?: Arrival[]): Promise<Run> {
    const run: Run = {
      schema: 2, id: `${w.id}-${randomBytes(4).toString('hex')}`, workflow: w.id, version: w.version, item, mode, startedBy: by,
      startedAt: now(), state: { status: 'queued', at: w.start, since: now() }, steps: [], ...(arrived?.length ? { arrived } : {}),
    };
    save(run);
    pump();
    return run;
  }

  /** The model answers a replay gives: the recorded ones, in order. */
  function recordedAnswers(run: Run): Ask | undefined {
    if (run.startedBy.kind !== 'replay') return undefined;
    const of = runs.get(run.startedBy.of);
    const answers = (of?.steps ?? []).flatMap((s) => s.llm.map((c) => c.answer));
    const used = run.steps.reduce((n, s) => n + s.llm.length, 0);
    let i = used;
    return async () => {
      if (i >= answers.length) throw refuse('noMoreAnswers', { run: run.startedBy.kind === 'replay' ? run.startedBy.of : '' }, `run ${run.startedBy.kind === 'replay' ? run.startedBy.of : ''} recorded no further model answer`);
      return answers[i++];
    };
  }

  /**
   * The books a step sees. A check sees them as they were before its case: without what the
   * case's run booked and mapped, so the case can go its way again on the waiting version.
   */
  function booksFor(run: Run): Books {
    const books = loadBooks(ws);
    if (run.startedBy.kind !== 'check') return books;
    const of = run.startedBy.of;
    return { ...books, journalEntries: books.journalEntries.filter((e) => e.run !== of), mappings: books.mappings.filter((m) => m.run !== of) };
  }

  function itemValue(item: ItemRef, books: Books): unknown {
    if (item.kind === 'transaction') return books.transactions.find((t: BankTransaction) => t.ref === item.id);
    if (item.kind === 'entry') return books.journalEntries.find((e) => e.id === item.id);
    if (item.kind === 'receipt') return books.receipts.find((r) => r.id === item.id);
    return item.id;
  }

  async function start(id: string, item: ItemRef, by: StartedBy, mode: Run['mode'] = 'live', arrived?: Arrival[]): Promise<CommandResult> {
    declared = loadWorkflows(deps.appRoot, ws.paths.root);
    const w = workflow(id);
    if (!w) return { ok: false, refusal: 'not-found', detail: id };
    if (!w.runnable.ok) return { ok: false, refusal: 'not-runnable', detail: w.runnable.missing.map((m) => m.action).join(', ') };
    if (mode === 'live' && !isApproved(w)) return { ok: false, refusal: 'not-approved', detail: w.version };
    // The company is one item. What arrives joins its run that has not started yet; while one is
    // under way, it gets a run of its own that waits behind it (laneOf), so no file arrives after
    // the step that would have read it. A plain second start is the run under way.
    const live = item.kind === 'company' && mode === 'live'
      ? [...runs.values()].filter((r) => r.workflow === w.id && r.mode === 'live' && r.item.kind === 'company' && r.item.id === item.id)
      : [];
    const notStarted = live.find((r) => r.state.status === 'queued' && r.steps.length === 0);
    if (notStarted) {
      if (arrived?.length) annotate(notStarted.id, { arrived: [...(notStarted.arrived ?? []), ...arrived] });
      return { ok: true, run: notStarted.id };
    }
    const underWay = live.find((r) => r.state.status === 'queued' || r.state.status === 'running');
    if (underWay && !arrived?.length && by.kind !== 'outside') return { ok: true, run: underWay.id };
    const run = await create(w, item, by, mode, arrived);
    return { ok: true, run: run.id };
  }

  async function command(cmd: AutomationCommand): Promise<CommandResult> {
    switch (cmd.kind) {
      case 'start': return start(cmd.workflow, cmd.item, { kind: 'manual' }, cmd.mode ?? 'live');
      case 'pause': paused = cmd.on; counter++; pump(); return { ok: true };
      case 'discard': {
        const r = runs.get(cmd.run);
        if (!r) return { ok: false, refusal: 'not-found' };
        if (deps.keeps?.(r)) return { ok: false, refusal: 'period-filed' };
        try { settle(move(r, { status: 'discarded', at: now(), reason: cmd.reason ?? 'von einer Person verworfen' })); } catch { return { ok: false, refusal: 'illegal' }; }
        return { ok: true, run: r.id };
      }
      case 'resume': {
        const r = runs.get(cmd.run);
        if (!r) return { ok: false, refusal: 'not-found' };
        if (r.state.status !== 'stuck' && r.state.status !== 'parked') return { ok: false, refusal: 'illegal', detail: r.state.status };
        declared = loadWorkflows(deps.appRoot, ws.paths.root);
        move(r, { status: 'queued', at: r.state.at, since: now() });
        pump();
        return { ok: true, run: r.id };
      }
      case 'answer': {
        const r = runs.get(cmd.run);
        if (!r) return { ok: false, refusal: 'not-found' };
        if (r.state.status !== 'waiting') return { ok: false, refusal: 'not-waiting' };
        const w = workflow(r.workflow)!;
        const step = stepOf(w, r.state.at)!;
        const target = step.outcomes[cmd.outcome];
        if (!target) return { ok: false, refusal: 'unknown-outcome', detail: Object.keys(step.outcomes).join(', ') };
        const at = now();
        const steps = r.steps.map((s, i) => (i === r.steps.length - 1 ? { ...s, outcome: cmd.outcome, answer: { outcome: cmd.outcome, at }, finishedAt: at } : s));
        if (target.to === 'end') {
          const finished = move({ ...r, steps }, { status: 'done', finishedAt: at });
          settle(finished);
          if (finished.mode === 'live') await emitFrom(finished);
          await childRested(finished);
        } else {
          move({ ...r, steps }, { status: 'queued', at: target.step, since: at });
          pump();
        }
        return { ok: true, run: r.id };
      }
      case 'replay': {
        const r = runs.get(cmd.run);
        if (!r) return { ok: false, refusal: 'not-found' };
        return start(r.workflow, r.item, { kind: 'replay', of: r.id }, 'replay');
      }
      case 'check': {
        // The latest finished live case of each item, newest first.
        const seen = new Set<string>();
        const cases = [...runs.values()]
          .filter((r) => r.workflow === cmd.workflow && r.mode === 'live' && r.state.status === 'done' && r.item.kind !== 'company')
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .filter((r) => !seen.has(r.item.id) && !!seen.add(r.item.id))
          .slice(0, Math.min(cmd.limit ?? 10, 25));
        if (!cases.length) return { ok: false, refusal: 'no-cases' };
        const started: string[] = [];
        for (const c of cases) {
          const r = await start(c.workflow, c.item, { kind: 'check', of: c.id }, 'dry');
          if (!r.ok) return r;
          started.push(r.run!);
        }
        return { ok: true, runs: started };
      }
      case 'review': {
        const r = runs.get(cmd.run);
        if (!r) return { ok: false, refusal: 'not-found' };
        annotate(r.id, { reviewed: cmd.on ? now() : undefined });
        return { ok: true, run: r.id };
      }
      case 'approve': {
        declared = loadWorkflows(deps.appRoot, ws.paths.root);
        const w = workflow(cmd.workflow);
        if (!w) return { ok: false, refusal: 'not-found' };
        deps.approve?.(w);
        counter++;
        pump();
        return { ok: true };
      }
    }
  }

  async function tick(at = new Date()): Promise<void> {
    declared = loadWorkflows(deps.appRoot, ws.paths.root);
    for (const w of declared.workflows) {
      if (!w.runnable.ok || !isApproved(w)) continue;
      for (const t of w.triggers) if (t.kind === 'schedule' && !t.off && cronMatches(t.cron, at)) await create(w, { kind: 'company', id: 'company' }, { kind: 'schedule', cron: t.cron }, 'live');
    }
  }

  pump();
  return {
    declarations: () => declared,
    runs: () => [...runs.values()],
    run: (id) => runs.get(id),
    get paused() { return paused; },
    limits,
    get counter() { return counter; },
    command,
    start,
    withdraw: (id, file) => { const r = runs.get(id); if (r?.arrived?.some((a) => a.file === file)) annotate(id, { arrived: r.arrived.filter((a) => a.file !== file) }); },
    tick,
    idle: () => new Promise<void>((resolve) => { waiters.push(resolve); notifyIdle(); }),
  };
}
