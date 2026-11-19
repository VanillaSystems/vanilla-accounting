/**
 * The automatic reminders as a workflow step (workflows/dunning, spec docs/specs/invoicing.md
 * 4.4.7): each hour the step sends the Mahnungen whose level is automatic and whose day has come
 * (src/invoices/service.ts autoReminders), only on the device that holds the books. What cannot be
 * sent becomes the person's task, once per invoice and level: the step keeps what failed beside the
 * device's data (data/dunning-auto.json, never in git) and hands on only what failed anew. A dry run
 * or a replay sends nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoReminders, type AutoOutcome } from '../invoices/service.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Action } from './actions.js';

const failedFile = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, 'data', 'dunning-auto.json');

function readFailed(ws: Pick<Workspace, 'paths'>): string[] {
  try { return existsSync(failedFile(ws)) ? (JSON.parse(readFileSync(failedFile(ws), 'utf8')) as { failed: string[] }).failed : []; } catch { return []; }
}

/**
 * The step's outcome from a round of automatic reminders: `failed` with the invoices that failed
 * since the last round named it (so a failure is one task, not one per hour), else `sent` or `none`.
 */
export function remindOutcome(ws: Pick<Workspace, 'paths'>, r: AutoOutcome): { outcome: 'sent' | 'none' | 'failed'; output: Record<string, unknown> } {
  const key = (f: AutoOutcome['failed'][number]) => `${f.invoiceId}#${f.level}#${f.reason}`;
  const before = new Set(readFailed(ws));
  const now = r.failed.map(key);
  mkdirSync(dirname(failedFile(ws)), { recursive: true });
  writeFileSync(failedFile(ws), `${JSON.stringify({ failed: now }, null, 2)}\n`);
  const fresh = r.failed.filter((f) => !before.has(key(f)));
  if (!fresh.length) return { outcome: r.sent.length ? 'sent' : 'none', output: { invoices: r.sent.map((s) => s.number).join(', ') } };
  const list = (xs: typeof fresh) => (xs.length ? xs.map((f) => (f.detail ? `${f.number} (${f.detail})` : f.number)).join(', ') : '–');
  return {
    outcome: 'failed',
    output: { invoices: fresh.map((f) => f.number).join(', '), noaddress: list(fresh.filter((f) => f.reason !== 'refused')), refused: list(fresh.filter((f) => f.reason === 'refused')) },
  };
}

export const DUNNING_ACTIONS: Record<string, Action> = {
  'invoices.remind': {
    outcomes: ['sent', 'none', 'failed'],
    effects: [],
    emits: ['invoices', 'noaddress', 'refused'],
    async run(_input, _fx, { ws, run, now }) {
      if (run && run.mode !== 'live') return { outcome: 'none', output: {} };
      if (!ws.invoicing) return { outcome: 'none', output: {} };
      return remindOutcome(ws, await autoReminders(ws, { now: now() }));
    },
  },
};
