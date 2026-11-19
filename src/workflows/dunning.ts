/**
 * The automatic reminders as a workflow step (workflows/dunning, spec docs/specs/invoicing.md
 * 4.4.7): each hour the step sends the Mahnungen whose level is automatic and whose day has come
 * (src/invoices/service.ts autoReminders), only on the computer they were switched on. What cannot be
 * sent becomes the person's task. The step remembers what failed on that computer
 * (data/dunning-auto.json, never in git) to raise each failure once: a task stands while its failures
 * do, and closes when they are sent or no longer due (a new one names what still fails). A round that
 * ran nowhere (a copy, a read-only start, another computer) neither reads nor writes that memory. A
 * dry run or a replay sends nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoReminders, type AutoOutcome } from '../invoices/service.js';
import { MAX_RUN } from '../invoices/dunning.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Action } from './actions.js';

const DUNNING_WORKFLOW = 'dunning';
const failedFile = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, 'data', 'dunning-auto.json');

/** A failure remembered: the invoice, its level and why (the key), its number and the server's words for the task. */
interface Remembered { key: string; invoiceId: string; number: string; reason: string; detail?: string }

function readFailed(ws: Pick<Workspace, 'paths'>): Remembered[] {
  try {
    const raw = existsSync(failedFile(ws)) ? (JSON.parse(readFileSync(failedFile(ws), 'utf8')) as { failed?: unknown }).failed : [];
    return Array.isArray(raw) ? raw.filter((x): x is Remembered => !!x && typeof x === 'object' && typeof (x as Remembered).key === 'string') : [];
  } catch { return []; }
}

const keyOf = (f: AutoOutcome['failed'][number]) => `${f.invoiceId}#${f.level}#${f.reason}`;

export interface RemindResult {
  outcome: 'sent' | 'none' | 'failed';
  output: Record<string, unknown>;
  /** The failures changed: the task standing for the earlier ones closes (a new one names what still fails). */
  close: boolean;
}

/**
 * The step's outcome from a round. The memory changes by what this round saw: a failure of an
 * invoice it took up is kept or added; one it took up and sent, or no longer found due, goes; one of
 * an invoice it left for the next round stays. The change is merged into the file as it is when
 * written, never overwritten blind. When the failures changed, the earlier task closes and `failed`
 * names all that still fail; else the round's sends (`sent`, which keeps the run in the log).
 */
export function remindOutcome(ws: Pick<Workspace, 'paths'>, r: AutoOutcome): RemindResult {
  if (r.skipped) return { outcome: 'none', output: {}, close: false };
  const sent = r.sent.map((s) => s.number);
  const more = r.deferred.length ? { more: String(r.deferred.length), limit: String(MAX_RUN) } : {};
  const before = readFailed(ws);
  const now: Remembered[] = r.failed.map((f) => ({ key: keyOf(f), invoiceId: f.invoiceId, number: f.number, reason: f.reason, ...(f.detail ? { detail: f.detail } : {}) }));
  const nowKeys = new Set(now.map((f) => f.key));
  const deferred = new Set(r.deferred);
  const gone = new Set(before.filter((f) => !nowKeys.has(f.key) && !deferred.has(f.invoiceId)).map((f) => f.key));
  const added = now.filter((f) => !before.some((b) => b.key === f.key));
  const changed = gone.size > 0 || added.length > 0;
  if (changed) {
    const merged = [...readFailed(ws).filter((f) => !gone.has(f.key) && !nowKeys.has(f.key)), ...now];
    mkdirSync(dirname(failedFile(ws)), { recursive: true });
    writeFileSync(failedFile(ws), `${JSON.stringify({ failed: merged }, null, 2)}\n`);
  }
  const current = [...before.filter((f) => !gone.has(f.key) && !nowKeys.has(f.key)), ...now];
  if (!changed || !current.length) return { outcome: sent.length ? 'sent' : 'none', output: { sent, ...more }, close: changed };
  const list = (xs: Remembered[]) => (xs.length ? xs.map((f) => (f.detail ? `${f.number} (${f.detail})` : f.number)).join(', ') : '–');
  return {
    outcome: 'failed',
    output: {
      sent, ...more,
      invoices: [...new Set(current.map((f) => f.number))].join(', '),
      noaddress: list(current.filter((f) => f.reason === 'noAddress' || f.reason === 'noMail')),
      refused: list(current.filter((f) => f.reason === 'refused')),
      check: list(current.filter((f) => f.reason === 'unrecorded')),
    },
    close: true,
  };
}

export const DUNNING_ACTIONS: Record<string, Action> = {
  'invoices.remind': {
    outcomes: ['sent', 'none', 'failed'],
    effects: ['runs.close'],
    emits: ['sent', 'more', 'limit', 'invoices', 'noaddress', 'refused', 'check'],
    async run(_input, fx, { ws, run, now }) {
      if (run && run.mode !== 'live') return { outcome: 'none', output: {} };
      if (!ws.invoicing) return { outcome: 'none', output: {} };
      const r = remindOutcome(ws, await autoReminders(ws, { now: now() }));
      if (r.close) fx['runs.close']?.(DUNNING_WORKFLOW, { kind: 'company', id: 'company' }, 'gesendet oder nicht mehr fällig');
      return { outcome: r.outcome, output: r.output };
    },
  },
};
