/**
 * The inbox processing as the shell sees it (POST/GET /api/intake, src/intake/): started after
 * every intake, by Belege's button and by files that arrive in the inbox meanwhile (the phone
 * app); a quiet line at the bottom left while it runs; the books loaded again when it ends.
 */
import { useSyncExternalStore } from 'react';
import type { IntakeJob, IntakeNote, IntakeStatus } from '../../intake/pipeline.js';
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';

let status: IntakeStatus = { running: false, inbox: [] };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Inbox files a job was started for, so a file the job cannot read does not start one again and again. */
const started = new Set<string>();
/** The finished job last reported; undefined until the first answer, so a job of before this page is not. */
let reported: string | undefined | null = null;
let watcher: { canEdit: boolean; onFinished(job: IntakeJob): void } | undefined;

function set(next: IntakeStatus): void {
  status = next;
  listeners.forEach((l) => l());
}

export function useIntake(): IntakeStatus {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status);
}

async function poll(): Promise<void> {
  clearTimeout(timer);
  const next = await api.intake().catch(() => status);
  set(next);
  const finished = !next.running ? next.job?.finishedAt : undefined;
  if (reported === null) reported = finished;
  else if (finished && finished !== reported) {
    reported = finished;
    watcher?.onFinished(next.job!);
  }
  if (watcher?.canEdit && !next.running && next.inbox.some((id) => !started.has(id))) { void startIntake(); return; }
  if (watcher) timer = setTimeout(poll, next.running ? 1000 : 10_000);
}

/** Keeps the status fresh while the shell is open; `onFinished` runs once per job that ends. */
export function watchIntake(canEdit: boolean, onFinished: (job: IntakeJob) => void): () => void {
  watcher = { canEdit, onFinished };
  void poll();
  return () => { watcher = undefined; clearTimeout(timer); };
}

/** Starts the processing (one more run when one is running) and follows it. */
export async function startIntake(): Promise<void> {
  status.inbox.forEach((id) => started.add(id));
  try {
    const next = await api.startIntake();
    next.inbox.forEach((id) => started.add(id));
    set(next);
  } catch (e) {
    watcher?.onFinished({ id: '', startedAt: '', steps: [{ id: 'read', state: 'stopped', done: 0, total: 0, notes: [{ code: 'error', detail: errorText(e) }] }] });
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(poll, 700);
}

/** What the line at the bottom left says while the job runs. */
function runningText(s: IntakeStatus): string {
  if (s.busy) return t('intake.busy');
  const step = s.job && !s.job.finishedAt ? s.job.steps.find((x) => x.state === 'running') : undefined;
  if (!step || step.total === 0) return t('intake.working');
  return t(`intake.step.${step.id}`, { n: step.total - step.done });
}

export function IntakeLine({ onOpen }: { onOpen(): void }) {
  const s = useIntake();
  if (!s.running && !s.busy) return null;
  const step = s.job && !s.job.finishedAt ? s.job.steps.find((x) => x.state === 'running') : undefined;
  return (
    <button type="button" className="intake" role="status" data-testid="intake" title={t('intake.tip')} onClick={onOpen}>
      <span className="pulse" aria-hidden="true" />
      {runningText(s)}
      {step && step.total > 1 && <span className="mono">{step.done}/{step.total}</span>}
    </button>
  );
}

/** One line for the toast when a job ended: what it did, or what it could not do. */
export function finishedText(job: IntakeJob): string {
  const notes = job.steps.flatMap((s) => s.notes.map((n) => [s.id, n] as const));
  const problems = notes.map(([, n]) => noteText(n));
  if (problems.length) return [...new Set(problems)].join(' · ');
  const read = job.steps.find((s) => s.id === 'read')?.total ?? 0;
  const booked = job.steps.find((s) => s.id === 'classify')?.total ?? 0;
  return [t('intake.finished'), read > 0 && t('intake.finishedRead', { n: read }), booked > 0 && t('intake.finishedBooked', { n: booked })].filter(Boolean).join(' · ');
}

function noteText(n: IntakeNote): string {
  switch (n.code) {
    case 'noModel': return t('intake.note.noModel');
    case 'failed': return t('intake.note.failed', { n: n.count, detail: n.detail });
    case 'unmatched': return t('intake.note.unmatched', { files: n.files.join('; ') });
    case 'filedKept': return t('intake.note.filedKept', { n: n.count });
    case 'error': return t('intake.note.error', { detail: n.detail });
  }
}
