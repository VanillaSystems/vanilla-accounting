/**
 * Changing a workflow directly, without AI (docs/0.4.0/workflows.md "Changing a workflow", way 2):
 * its schedule, written into the company's overlay of the workflow (workflows/<id>/workflow.yaml),
 * where any other change of the company stays as it is. A schedule applies at once; the file
 * shows in Änderungen as changed in the app, to be saved like any change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';
import type { Trigger, WorkflowDecl } from './model.js';
import { cronValid } from './cron.js';

/** The trigger as YAML writes it (workflow.yaml's own shape). */
function raw(t: Trigger): Record<string, unknown> {
  const off = t.off ? { off: true } : {};
  switch (t.kind) {
    case 'manual': return { manual: { for: t.for, label: t.label, ...(t.when ? { when: t.when } : {}), ...off } };
    case 'event': return { event: { name: t.name, ...off } };
    case 'schedule': return { schedule: { cron: t.cron, ...off } };
    case 'outside': return { outside: { accepts: t.accepts, ...off } };
  }
}

/** Sets the schedule (a cron of five fields), or switches it off with null. Throws on a schedule that is not one. */
export function setSchedule(ws: Pick<Workspace, 'paths'>, w: WorkflowDecl, cron: string | null): void {
  if (cron !== null && !cronValid(cron)) throw new Error(`"${cron}" is no schedule of five fields`);
  const rest = w.triggers.filter((t) => t.kind !== 'schedule');
  const had = w.triggers.find((t) => t.kind === 'schedule');
  const schedule: Trigger[] = cron !== null ? [{ kind: 'schedule', cron }] : had ? [{ ...had, off: true }] : [];
  const dir = join(ws.paths.root, 'workflows', w.id);
  const file = join(dir, 'workflow.yaml');
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '{}');
  doc.set('triggers', [...schedule, ...rest].map(raw));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, doc.toString());
}
