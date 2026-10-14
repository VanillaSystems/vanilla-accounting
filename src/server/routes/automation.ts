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
import { openRecordsCommitter } from '../../saving/records.js';
import { summaryOf, taskOf, textIn, type AutomationCommand, type AutomationView, type PendingVersion, type Run, type RunDetail, type Task, type WorkflowDecl } from '../../workflows/model.js';
import { baseline, caseCheck, openSwitch } from '../../workflows/switch-on.js';
import { setSchedule } from '../../workflows/direct.js';
import { cronValid } from '../../workflows/cron.js';
import { loadBooks } from '../../books/store.js';
import type { JournalEntry } from '../../types/index.js';

export const router = Router();

const engines = new Map<string, Engine>();
let commits: Promise<unknown> = Promise.resolve();

/** Commits run one after another: isomorphic-git takes the index for each. A failed commit is logged, never thrown at a run. */
export function queueCommit(f: () => Promise<boolean>): Promise<unknown> {
  commits = commits.then(f).catch((e) => console.error(`commit failed: ${(e as Error).message}`));
  return commits;
}

/** The engine of the open workspace; a workspace opened later gets its own. Opening it commits what a crash left uncommitted. */
export function engine(): Engine {
  const ws = WS;
  let e = engines.get(ws.paths.root);
  if (!e) {
    const records = openRecordsCommitter(ws);
    void queueCommit(() => records.recover());
    const sw = openSwitch(ws);
    baseline(ws, loadWorkflows(APP_ROOT, ws.paths.root).workflows);
    e = openEngine(ws, {
      appRoot: APP_ROOT, ask: askIfReady, lock: () => lockIntake(ws),
      isApproved: sw.isApproved, approve: sw.approve,
      onRest: (run, line) => {
        if (!line) return;
        const w = loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((x) => x.id === run.workflow);
        void queueCommit(() => records.commitRun({ id: run.id, workflow: run.workflow, label: w ? textIn(w.label, 'de') : run.workflow, item: run.item.id }));
      },
    });
    engines.set(ws.paths.root, e);
  }
  return e;
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
  const detail: RunDetail = { ...summaryOf(run, loadWorkflows(APP_ROOT, WS.paths.root).workflows.find((w) => w.id === run.workflow)), steps: run.steps };
  res.json(detail);
});

const KINDS = new Set(['start', 'answer', 'resume', 'replay', 'discard', 'pause', 'check', 'approve']);

router.post('/api/automation', async (req, res) => {
  const cmd = req.body as AutomationCommand;
  if (!cmd || typeof cmd !== 'object' || !KINDS.has(cmd.kind)) throw new RequestError(400, 'Unbekannter Befehl.');
  if (cmd.kind === 'start' && (typeof cmd.workflow !== 'string' || typeof cmd.item?.id !== 'string' || typeof cmd.item?.kind !== 'string')) throw new RequestError(400, 'start braucht workflow und item.');
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
