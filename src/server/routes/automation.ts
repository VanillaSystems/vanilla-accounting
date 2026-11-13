/**
 * Automatisierung over HTTP (docs/0.4.0/ui/design.md): one engine per workspace in this process,
 * the only writer of runs while the server is up (the CLI sends its commands here).
 *
 *   GET  /api/automation?since=<rev>   the view, or { unchanged: true } when nothing moved
 *   GET  /api/automation/runs/:id      one run with its step records
 *   GET  /api/automation/runs/:id/log  one run's run-log lines (its details may be gone from the run store)
 *   GET  /api/history/:kind/:id?all=1  the runs that worked on a receipt, payment or entry (#215)
 *   POST /api/automation               an AutomationCommand → CommandResult
 */
import { progressOf } from '../../workflows/step-progress.js';
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { readBooks, RequestError, WS } from '../books.js';
import { APP_ROOT, type Workspace } from '../../workspace/workspace.js';
import { askIfReady } from '../../intake/run.js';
import { lockIntake } from '../../intake/pipeline.js';
import { openEngine, type Engine } from '../../workflows/engine.js';
import { loadWorkflows } from '../../workflows/load.js';
import { summaryOf, taskOf, textIn, type AutomationCommand, type AutomationView, type PendingVersion, type Run, type RunDetail, type Task, type TaskPayment, type WorkflowDecl } from '../../workflows/model.js';
import { baseline, caseCheck, openSwitch } from '../../workflows/switch-on.js';
import { bookWhatWaited } from '../provider-payouts.js';
import { setSchedule } from '../../workflows/direct.js';
import { cronValid } from '../../workflows/cron.js';
import { loadBooks } from '../../books/store.js';
import { filingXml, holdsFiledPeriod, releaseApproval } from '../../workflows/filing.js';
import { ASK_WORKFLOW, CLOSED_REASON, closeAsksWithoutRule } from '../../workflows/held.js';
import { isFilingKey } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';
import { basename } from 'node:path';
import { inboxFiles } from './scan.js';
import type { JournalEntry } from '../../types/index.js';
import type { RunWrote } from '../../saving/model.js';
import { readLog } from '../../workflows/runlog.js';
import { HISTORY_KINDS, HISTORY_LIMIT, historyOf, linesOfRun, type HistoryTarget } from '../../workflows/history.js';

export const router = Router();

const engines = new Map<string, Engine>();
/** Each workspace as last opened: Firma reopens it after every change to its manifest, and another one may be open by now. */
const latest = new Map<string, Workspace>();
const openedAt = (root: string): Workspace => {
  if (WS.paths.root === root) latest.set(root, WS);
  return latest.get(root)!;
};
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
    const root = ws.paths.root;
    const now = () => openedAt(root);
    e = openEngine(now, {
      appRoot: APP_ROOT, ask: askIfReady, lock: () => lockIntake(now()),
      isApproved: sw.isApproved, approve: sw.approve,
      keeps: (run) => holdsFiledPeriod(now(), run),
      onRest: (run) => releaseApproval(now(), run),
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

/** The payments tasks were about, by workspace and ref: a bank's movement never changes, so the books are read only for a ref not seen yet. A ref not found is not kept: the next poll reads again (a statement imported meanwhile). */
const payments = new Map<string, Map<string, TaskPayment>>();

/** Each task about a payment with that payment's facts (#365): the corner, Aufgaben and Übersicht name it without books of their own. */
function withPayments(tasks: Task[]): Task[] {
  const refs = tasks.flatMap((t) => (t.item.kind === 'transaction' ? [t.item.id] : []));
  if (!refs.length) return tasks;
  const known = payments.get(WS.paths.root) ?? payments.set(WS.paths.root, new Map()).get(WS.paths.root)!;
  if (refs.some((ref) => !known.has(ref))) {
    try {
      const byRef = new Map(readBooks().transactions.map((t) => [t.ref, t]));
      for (const ref of refs) {
        const t = byRef.get(ref);
        if (t) known.set(ref, { ...(t.counterparty ? { counterparty: t.counterparty } : {}), description: t.description, amount: t.amount, currency: t.currency, date: t.date, direction: t.direction });
      }
    } catch { /* books that do not load: the tasks keep their titles */ }
  }
  return tasks.map((t) => { const p = t.item.kind === 'transaction' ? known.get(t.item.id) : undefined; return p ? { ...t, payment: p } : t; });
}

export function automationView(): AutomationView {
  const e = engine();
  const loaded = loadWorkflows(APP_ROOT, WS.paths.root);
  const runs = e.runs();
  const byId = new Map(loaded.workflows.map((w) => [w.id, w]));
  const tasks = withPayments(runs.map((r) => (byId.has(r.workflow) ? taskOf(byId.get(r.workflow)!, r) : undefined)).filter((t): t is Task => !!t)
    .sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || a.since.localeCompare(b.since)));
  // A running step's own count of what it finished (step-progress.ts): part of the revision, so a poll sees it move.
  const summaries = runs.map((r) => summaryOf(r, byId.get(r.workflow))).map((s) => { const p = s.status === 'running' ? progressOf(s.id) : undefined; return p ? { ...s, progress: p } : s; }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const pending = pendingVersions(loaded.workflows, runs);
  const rev = createHash('sha256').update(JSON.stringify([loaded.workflows.map((w) => w.version), loaded.problems, e.counter, e.paused, pending, summaries.flatMap((s) => (s.progress ? [s.id, s.progress.done, s.progress.total] : []))])).digest('hex').slice(0, 16);
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

router.get('/api/automation/runs/:id/log', (req, res) => {
  res.json({ lines: linesOfRun(readLog(WS), req.params.id), stored: !!engine().run(req.params.id) });
});

/** Read only: the run log and the books' facts that say what concerns the object (#233). */
router.get('/api/history/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  if (!(HISTORY_KINDS as readonly string[]).includes(kind)) throw new RequestError(400, `${kind}: receipt, payment oder entry.`);
  const books = readBooks();
  const entriesOf = (refs: Set<string>) => books.journalEntries.filter((e) => e.transactionRef && refs.has(e.transactionRef)).map((e) => e.id);
  const target: HistoryTarget = kind === 'payment'
    ? { kind, id, entries: entriesOf(new Set([id])), receipts: books.mappings.filter((m) => m.transactionRef === id).map((m) => m.receiptId) }
    : kind === 'receipt'
      ? { kind, id, entries: entriesOf(new Set(books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef))) }
      : { kind: 'entry', id, payment: books.journalEntries.find((e) => e.id === id)?.transactionRef };
  const e = engine();
  res.json(historyOf(readLog(WS), target, (run) => !!e.run(run), req.query.all ? Infinity : HISTORY_LIMIT));
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
  const out = await engine().command(cmd);
  // Switched on: what waited for it is booked now (#404).
  if (cmd.kind === 'approve' && out.ok) await bookWhatWaited(cmd.workflow);
  res.json(out);
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

/**
 * «KI ganz ausschalten» switched off again (issue #212): what waited for the model comes now. One
 * inbox run reads the receipts left unread and books the payments left for the model, and files
 * the inbox already tried are tried again.
 */
export async function resumeAfterAi(): Promise<void> {
  attempted.clear();
  const r = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'manual' }, 'live');
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
