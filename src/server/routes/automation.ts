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
import { summaryOf, taskOf, textIn, type AutomationCommand, type AutomationView, type RunDetail, type Task } from '../../workflows/model.js';

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
    e = openEngine(ws, {
      appRoot: APP_ROOT, ask: askIfReady, lock: () => lockIntake(ws),
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
  const tasks = runs.map((r) => (byId.has(r.workflow) ? taskOf(byId.get(r.workflow)!, r) : undefined)).filter((t): t is Task => !!t);
  const summaries = runs.map(summaryOf).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const rev = createHash('sha256').update(JSON.stringify([loaded.workflows.map((w) => w.version), loaded.problems, e.counter, e.paused])).digest('hex').slice(0, 16);
  return { rev, ...loaded, runs: summaries, tasks, paused: e.paused, limits: e.limits };
}

router.get('/api/automation', (req, res) => {
  const view = automationView();
  res.json(req.query.since === view.rev ? { unchanged: true } : view);
});

router.get('/api/automation/runs/:id', (req, res) => {
  const run = engine().run(req.params.id);
  if (!run) throw new RequestError(404, `Lauf ${req.params.id} gibt es nicht.`);
  const detail: RunDetail = { ...summaryOf(run), steps: run.steps };
  res.json(detail);
});

const KINDS = new Set(['start', 'answer', 'resume', 'replay', 'discard', 'pause']);

router.post('/api/automation', async (req, res) => {
  const cmd = req.body as AutomationCommand;
  if (!cmd || typeof cmd !== 'object' || !KINDS.has(cmd.kind)) throw new RequestError(400, 'Unbekannter Befehl.');
  if (cmd.kind === 'start' && (typeof cmd.workflow !== 'string' || typeof cmd.item?.id !== 'string' || typeof cmd.item?.kind !== 'string')) throw new RequestError(400, 'start braucht workflow und item.');
  res.json(await engine().command(cmd));
});
