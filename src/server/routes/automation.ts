/**
 * Automatisierung over HTTP (docs/0.4.0/ui/design.md): the declarations and the stored runs, read
 * only until the engine runs in the server. GET /api/automation?since=<rev> answers
 * { unchanged: true } when nothing moved, so the browser's poll is cheap.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { RequestError, WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { loadWorkflows } from '../../workflows/load.js';
import type { AutomationView, RunDetail, RunSummary } from '../../workflows/model.js';
import type { Run } from '../../workflows/runner.js';
import { listRuns } from '../../workflows/store.js';

export const router = Router();

function summaryOf(r: Run): RunSummary {
  const last = r.steps.at(-1);
  return {
    id: r.id, workflow: r.workflow, item: { kind: r.item.kind, id: r.item.ref }, mode: r.mode,
    startedAt: r.startedAt, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), status: r.status,
    path: r.steps.map((s) => s.step), ...(last ? { at: last.step } : {}),
    ...(r.status === 'stuck' && last?.error ? { error: last.error } : {}),
  };
}

function detailOf(r: Run): RunDetail {
  return {
    ...summaryOf(r), ...(r.of ? { of: r.of } : {}),
    steps: r.steps.map((s) => ({
      step: s.step, ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.error ? { error: s.error } : {}), ...(s.output ? { output: s.output } : {}),
      llm: s.llm.length, effects: s.effects.map((e) => ({ effect: e.effect, applied: e.applied })),
    })),
  };
}

export function automationView(): AutomationView {
  const loaded = loadWorkflows(APP_ROOT, WS.paths.root);
  const runs = listRuns(WS).reverse().map(summaryOf);
  const rev = createHash('sha256').update(JSON.stringify([loaded.workflows.map((w) => w.version), loaded.problems, runs.map((r) => [r.id, r.status, r.path.length])])).digest('hex').slice(0, 16);
  return { rev, ...loaded, runs };
}

router.get('/api/automation', (req, res) => {
  const view = automationView();
  res.json(req.query.since === view.rev ? { unchanged: true } : view);
});

router.get('/api/automation/runs/:id', (req, res) => {
  const run = listRuns(WS).find((r) => r.id === req.params.id);
  if (!run) throw new RequestError(404, `Lauf ${req.params.id} gibt es nicht.`);
  res.json(detailOf(run));
});
