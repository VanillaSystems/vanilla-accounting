/**
 * Automatisierung over HTTP (docs/0.4.0/ui/design.md): one engine per workspace in this process,
 * the only writer of runs while the server is up (the CLI sends its commands here).
 *
 *   GET  /api/automation?since=<rev>   the view, or { unchanged: true } when nothing moved
 *   GET  /api/automation/runs/:id      one run with its step records
 *   POST /api/automation               an AutomationCommand → CommandResult
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { RequestError, WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { askIfReady } from '../../intake/run.js';
import { lockIntake } from '../../intake/pipeline.js';
import { openEngine, type Engine } from '../../workflows/engine.js';
import { loadWorkflows } from '../../workflows/load.js';
import { summaryOf, taskOf, textIn, type AutomationCommand, type AutomationView, type PendingVersion, type Run, type RunDetail, type Task, type WorkflowDecl } from '../../workflows/model.js';
import { baseline, caseCheck, openSwitch } from '../../workflows/switch-on.js';
import { setSchedule } from '../../workflows/direct.js';
import { cronValid } from '../../workflows/cron.js';
import { loadBooks } from '../../books/store.js';
import { filingXml, releaseApproval } from '../../workflows/filing.js';
import { ASK_WORKFLOW, CLOSED_REASON, closeAsksWithoutRule } from '../../workflows/held.js';
import { isFilingKey } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';
import { basename } from 'node:path';
import { inboxFiles } from './scan.js';
import type { JournalEntry } from '../../types/index.js';
import type { RunWrote } from '../../saving/model.js';

export const router = Router();

const engines = new Map<string, Engine>();
let commits: Promise<unknown> = Promise.resolve();

/** Commits run one after another: isomorphic-git takes the index for each. A failed commit is logged, never thrown at a run. */
export function queueCommit(f: () => Promise<boolean>): Promise<unknown> {
  commits = commits.then(f).catch((e) => console.error(`commit failed: ${(e as Error).message}`));
  return commits;
}

/** The engine of the open workspace; a workspace opened later gets its own. What its runs write waits in Änderungen to be saved. */
export function engine(): Engine {
  const ws = WS;
  let e = engines.get(ws.paths.root);
  if (!e) {
    const sw = openSwitch(ws);
    baseline(ws, loadWorkflows(APP_ROOT, ws.paths.root).workflows);
    e = openEngine(ws, {
      appRoot: APP_ROOT, ask: askIfReady, lock: () => lockIntake(ws),
      isApproved: sw.isApproved, approve: sw.approve,
      onRest: (run) => releaseApproval(ws, run),
    });
    engines.set(ws.paths.root, e);
  }
  return e;
}

/** The live runs that wrote into the books and came to rest after `since` (the last save), newest first: Änderungen's «Bücher · aus Läufen». */
export function runsWroteSince(since: string | undefined): RunWrote[] {
  const workflows = loadWorkflows(APP_ROOT, WS.paths.root).workflows;
  return engine().runs().flatMap((r): RunWrote[] => {
    if (r.mode !== 'live') return [];
    const at = r.state.status === 'done' ? r.state.finishedAt : r.steps.at(-1)?.finishedAt;
    if (!at || (since && at <= since)) return [];
    const wrote = r.steps.flatMap((s) => s.effects.filter((x) => x.applied).map((x) => x.wrote));
    const n = (k: 'entries' | 'mappings' | 'receipts') => wrote.reduce((sum, w) => sum + (w[k]?.length ?? 0), 0);
    if (!n('entries') && !n('mappings') && !n('receipts')) return [];
    const w = workflows.find((x) => x.id === r.workflow);
    return [{ run: r.id, workflow: r.workflow, label: w ? textIn(w.label, 'de') : r.workflow, at, entries: n('entries'), links: n('mappings'), receipts: n('receipts') }];
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export function automationView(): AutomationView {
  const e = engine();
  const loaded = loadWorkflows(APP_ROOT, WS.paths.root);
  const runs = e.runs();
  const byId = new Map(loaded.workflows.map((w) => [w.id, w]));
  const tasks = runs.map((r) => (byId.has(r.workflow) ? taskOf(byId.get(r.workflow)!, r) : undefined)).filter((t): t is Task => !!t)
    .sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || a.since.localeCompare(b.since));
  const summaries = runs.map((r) => summaryOf(r, byId.get(r.workflow))).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const pending = pendingVersions(loaded.workflows, runs);
  const rev = createHash('sha256').update(JSON.stringify([loaded.workflows.map((w) => w.version), loaded.problems, e.counter, e.paused, pending])).digest('hex').slice(0, 16);
  return { rev, ...loaded, runs: summaries, tasks, paused: e.paused, limits: e.limits, pending };
}

/** Each workflow waiting to be switched on, with its cases checked against the version as it is now. */
function pendingVersions(workflows: WorkflowDecl[], runs: Run[]): PendingVersion[] {
  const sw = openSwitch(WS);
  const byId = new Map(runs.map((r) => [r.id, r]));
  let entries: JournalEntry[] | undefined;
  return workflows.flatMap((w): PendingVersion[] => {
    const part = sw.pending(w);
    if (!part) return [];
    const checks = runs.filter((r) => r.workflow === w.id && r.version === w.version && r.startedBy.kind === 'check' && byId.has(r.startedBy.of))
      .map((r) => caseCheck(byId.get((r.startedBy as { of: string }).of)!, r, (entries ??= loadBooks(WS).journalEntries)));
    return [{ workflow: w.id, files: part.files, checks }];
  });
}

router.get('/api/automation', (req, res) => {
  const view = automationView();
  res.json(req.query.since === view.rev ? { unchanged: true } : view);
});

router.get('/api/automation/runs/:id', (req, res) => {
  const run = engine().run(req.params.id);
  if (!run) throw new RequestError(404, `Lauf ${req.params.id} gibt es nicht.`);
  const detail: RunDetail = { ...summaryOf(run, loadWorkflows(APP_ROOT, WS.paths.root).workflows.find((w) => w.id === run.workflow)), steps: run.steps, startedBy: run.startedBy };
  res.json(detail);
});

/** A period's XML for the tax authority's import, as the filing workflow wrote it: to download and upload there. */
router.get('/api/filing/:period', (req, res) => {
  const key = req.params.period;
  if (!isFilingKey(key, filing().length)) throw new RequestError(400, `${key} ist keine Abrechnungsperiode.`);
  const path = filingXml(WS, key);
  if (!path) throw new RequestError(404, `Für ${key} ist noch keine Datei erstellt.`);
  res.download(path, basename(path));
});

const KINDS = new Set(['start', 'answer', 'resume', 'replay', 'discard', 'pause', 'check', 'approve', 'review']);

router.post('/api/automation', async (req, res) => {
  const cmd = req.body as AutomationCommand;
  if (!cmd || typeof cmd !== 'object' || !KINDS.has(cmd.kind)) throw new RequestError(400, 'Unbekannter Befehl.');
  if (cmd.kind === 'start' && (typeof cmd.workflow !== 'string' || typeof cmd.item?.id !== 'string' || typeof cmd.item?.kind !== 'string')) throw new RequestError(400, 'start braucht workflow und item.');
  if (cmd.kind === 'review' && (typeof cmd.run !== 'string' || typeof cmd.on !== 'boolean')) throw new RequestError(400, 'review braucht run und on.');
  // An answer to a question whose reason is gone meanwhile (the report came, the rule went) closes it instead of booking a stale proposal (r7h-21).
  if (cmd.kind === 'answer' && engine().run(cmd.run)?.workflow === ASK_WORKFLOW && (await closeAsksWithoutRule(engine(), WS)).includes(cmd.run)) {
    res.json({ ok: false, refusal: 'not-waiting', detail: CLOSED_REASON });
    return;
  }
  res.json(await engine().command(cmd));
});

/** The direct way, without AI: a workflow's schedule, or null to switch it off. It applies at once and waits in Änderungen to be saved. */
router.patch('/api/automation/workflows/:id', (req, res) => {
  const w = loadWorkflows(APP_ROOT, WS.paths.root).workflows.find((x) => x.id === req.params.id);
  if (!w) throw new RequestError(404, `Den Ablauf ${req.params.id} gibt es nicht.`);
  const cron = (req.body as { schedule?: unknown })?.schedule;
  if (cron !== null && (typeof cron !== 'string' || !cronValid(cron))) throw new RequestError(400, 'schedule: fünf Felder wie "0 7 * * *", oder null zum Abschalten.');
  setSchedule(WS, w, cron);
  res.json({ ok: true });
});

export const INTAKE = 'receipt-intake';

/**
 * The inbox's run for payments a receipt left (deleted, taken back, restored): its book step books
 * them again. It joins a run that has not started yet, else waits behind the one under way.
 */
export async function bookAgain(file: string): Promise<void> {
  const r = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file }, 'live');
  if (!r.ok && r.refusal !== 'not-runnable') console.error(`${INTAKE}: ${r.refusal} ${r.detail ?? ''}`);
}

export const BOOKING = 'booking';

/**
 * The booking run of one payment a person's undo left without a booking (r8k-6): what
 * «Automatisch buchen» starts. Without a model it holds at the hand step, so the task the person
 * had answered by booking is back under Aufgaben; with one it books the payment as any other.
 */
export async function bookPaymentAgain(ref: string): Promise<void> {
  const r = await engine().start(BOOKING, { kind: 'transaction', id: ref }, { kind: 'manual' }, 'live');
  if (!r.ok && r.refusal !== 'not-runnable') console.error(`${BOOKING}: ${r.refusal} ${r.detail ?? ''}`);
}

/**
 * Inbox files a run was started for: a file no step can read starts no second run on its own.
 * One that left the inbox is forgotten, so the same bytes arriving again (a phone's retry) start
 * a run, whose read step removes them.
 */
const attempted = new Set<string>();
/** Files the drop dialog put into the inbox and handed to a run itself. */
export const handedOver = (ids: string[]) => { for (const id of ids) attempted.add(id); };

/**
 * The outside trigger (docs/0.4.0/workflows.md): files that arrived in the inbox (a drop, the
 * Finder, the phone app) start a run of each workflow that takes them; one run for the inbox,
 * and another once it rests if more files came meanwhile.
 */
export async function outsideArrivals(): Promise<void> {
  const present = inboxFiles({ photos: true });
  for (const id of attempted) if (!present.some((f) => f.id === id)) attempted.delete(id);
  const files = present.filter((f) => !attempted.has(f.id));
  if (!files.length) return;
  const e = engine();
  for (const w of e.declarations().workflows) {
    if (!w.triggers.some((t) => t.kind === 'outside' && !t.off && t.accepts.includes('receipt'))) continue;
    const r = await e.start(w.id, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: files[0].filename });
    if (!r.ok && r.refusal !== 'not-runnable') console.error(`${w.id}: ${r.refusal} ${r.detail ?? ''}`);
  }
  for (const f of files) attempted.add(f.id);
}
