/**
 * Warteschlange (the mockup's screen 9), across all workflows, as on a build server: what runs,
 * each with its step and a bar; what waits in the queue, in order, with why, and × to take it out;
 * what is parked (waiting for a person or an event, not in the queue); what finished lately.
 */
import { language, t } from '../../i18n/index.js';
import { automationCommand } from '../../automation/store.js';
import { hasAi, textIn, type AutomationView, type RunSummary, type WorkflowDecl } from '../../../workflows/model.js';
import type { Nav } from '../index.js';
import { BotIcon } from './Graph.js';

const pad = (n: number) => String(n).padStart(2, '0');
/** «11:48» today, «07.10.» before. */
function at(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
}
/** «4 s», «2 min». */
function took(r: RunSummary): string {
  if (!r.finishedAt) return '—';
  const s = Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 120 ? t('automation.duration', { n: s }) : t('automation.durationMin', { n: Math.round(s / 60) });
}

/** What a run is for, as the queue names it: the file it came with, the payment, else the workflow. */
function itemOf(r: RunSummary, w: WorkflowDecl | undefined): string {
  if (r.arrived?.length) return r.arrived.length > 1 ? t('automation.files', { first: r.arrived[0].file.split('/').pop()!, n: r.arrived.length - 1 }) : r.arrived[0].file.split('/').pop()!;
  if (r.startedBy.kind === 'outside') return r.startedBy.file;
  if (r.item.kind !== 'company') return r.item.id;
  return w ? textIn(w.label, language()) : r.workflow;
}

/** What a finished run left to say: why it stopped, else what it made. */
function noteOf(r: RunSummary): string {
  if (r.error) return r.error;
  const d = r.digest;
  return [d.receipts ? t('runs.out.read', { n: d.receipts }) : '', d.links ? t('runs.out.linked', { n: d.links }) : '', d.entries ? t('runs.out.booked', { n: d.entries }) : ''].filter(Boolean).join(', ');
}

const ICON: Partial<Record<RunSummary['status'], string>> = { done: '✓', waiting: '!', stuck: '!', discarded: '×' };

export function QueuePage({ view, nav }: { view: AutomationView; nav: Nav }) {
  const wf = (id: string) => view.workflows.find((w) => w.id === id);
  const chip = (r: RunSummary) => {
    const w = wf(r.workflow);
    return <button type="button" className="wfchip" onClick={() => nav.go({ route: { area: 'automation', view: 'workflow', workflow: r.workflow, tab: 'graph' }, query: {} })}>{w ? textIn(w.label, language()) : r.workflow}{w && hasAi(w, view.workflows) ? <BotIcon /> : null}</button>;
  };
  const open = (r: RunSummary) => () => nav.go({ route: { area: 'automation', view: 'run', run: r.id }, query: {} });
  const live = view.runs.filter((r) => r.mode === 'live');
  const running = live.filter((r) => r.status === 'running');
  const queued = live.filter((r) => r.status === 'queued').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const waiting = live.filter((r) => r.status === 'waiting');
  const parked = live.filter((r) => r.status === 'parked');
  const done = live.filter((r) => r.status === 'done' || r.status === 'stuck' || r.status === 'discarded' || r.status === 'waiting').slice(0, 12);
  return (
    <div className="detail-in wfpage qpage">
      <div className="head">
        <h2 className="who">{t('automation.queue')}<small>{t('automation.queueLead', { ai: view.limits.ai, other: view.limits.other })}</small></h2>
        <button type="button" className="btn ghost" onClick={() => void automationCommand({ kind: 'pause', on: !view.paused })}>{view.paused ? t('automation.unpause') : `❚❚ ${t('automation.pause')}`}</button>
      </div>
      {view.paused ? <div className="chbanner"><b>{t('automation.pausedTitle')}</b><span>{t('automation.pausedLead')}</span></div> : null}

      <section className="qsec">
        <div className="qh"><b>{t('automation.queueRunning')}</b><span className="m mono">{running.length}</span></div>
        {running.length ? running.map((r) => {
          const w = wf(r.workflow);
          const i = w && r.at ? w.steps.findIndex((s) => s.id === r.at) : -1;
          const n = w?.steps.length ?? 0;
          const step = i >= 0 ? textIn(w!.steps[i].label, language()) : '';
          return (
            <div key={r.id} className="qrow" onClick={open(r)}>
              <i className="spin" aria-hidden="true" />
              <span className="qi"><span className="mono">{itemOf(r, w)}</span>{chip(r)}</span>
              <span className="qp"><span className="bar"><i style={{ width: `${n ? Math.round(((i + 1) / n) * 100) : 0}%` }} /></span><span className="m">{i >= 0 ? `${i + 1}/${n} · ${step}` : ''}</span></span>
            </div>
          );
        }) : <p className="m">{t('automation.queueNone')}</p>}
      </section>

      <section className="qsec">
        <div className="qh"><b>{t('automation.queueQueued')}</b><span className="m mono">{queued.length}</span><span className="m">{t('automation.queueInOrder')}</span></div>
        {queued.length ? queued.map((r, i) => (
          <div key={r.id} className="qrow" onClick={open(r)}>
            <span className="pos mono">{i + 1}</span>
            <span className="qi"><span className="mono">{itemOf(r, wf(r.workflow))}</span>{chip(r)}</span>
            <span className="m qwhy">{r.reason ? t(`automation.queuedBecause.${r.reason}` as 'automation.queuedBecause.slot') : t('automation.queuedNext')}</span>
            <button type="button" className="x" aria-label={t('automation.queueRemove')} onClick={(e) => { e.stopPropagation(); void automationCommand({ kind: 'discard', run: r.id, reason: t('automation.queueRemoved') }); }}>×</button>
          </div>
        )) : <p className="m">{t('automation.queueNone')}</p>}
      </section>

      <section className="qsec">
        <div className="qh"><b>{t('automation.queueParked')}</b><span className="m">{t('automation.queueParkedLead')}</span></div>
        {waiting.length ? (
          <div className="qrow" onClick={() => nav.select({ area: 'automation', view: 'tasks' })}>
            <span className="rpill you">{waiting.length}</span><span className="qi">{t('automation.parkedYou', { n: waiting.length })}</span>
            <span className="m qwhy">{waiting.slice(0, 3).map((r) => itemOf(r, wf(r.workflow))).join(' · ')}</span><button type="button" className="linkbtn">{t('automation.tasks')}</button>
          </div>
        ) : null}
        {parked.length ? (
          <div className="qrow">
            <span className="rpill">{parked.length}</span><span className="qi">{t('automation.parkedEvent', { n: parked.length })}</span>
            <span className="m qwhy">{parked.slice(0, 3).map((r) => itemOf(r, wf(r.workflow))).join(' · ')}</span>
          </div>
        ) : null}
        {!waiting.length && !parked.length ? <p className="m">{t('automation.queueNone')}</p> : null}
      </section>

      <section className="qsec">
        <div className="qh"><b>{t('automation.queueDone')}</b><span className="m">{t('automation.queueDoneLead')}</span></div>
        {done.length ? done.map((r) => (
          <div key={r.id} className="qrow" onClick={open(r)}>
            <span className={`ri st-${r.status}`} aria-label={t(`automation.status.${r.status}` as 'automation.status.done')}>{ICON[r.status] ?? '✓'}</span>
            <span className="qi"><span className="mono">{itemOf(r, wf(r.workflow))}</span>{chip(r)}</span>
            <span className="m qwhy">{noteOf(r)}</span>
            <span className="m mono qt">{at(r.startedAt)} · {took(r)}</span>
          </div>
        )) : <p className="m">{t('automation.queueNone')}</p>}
      </section>
    </div>
  );
}
