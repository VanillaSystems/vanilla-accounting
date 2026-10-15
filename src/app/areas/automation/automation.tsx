/**
 * Automatisierung (docs/0.4.0/ui/design.md): every workflow by phase with its graph, triggers,
 * runs and files; the process map; the queue and the tasks. Everything comes from the declarations
 * and the stored runs (GET /api/automation); nothing here is a list of its own.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { errorText } from '../../lib/api.js';
import './automation.css';
import { AskAi } from '../../assistant/AskAi.js';
import { AUTOMATION_TABS, type Route, type RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { language, t, tData } from '../../i18n/index.js';
import { automationCommand, automationNow, setSchedule, useAutomation, useRun } from '../../automation/store.js';
import { fillTask, hasAi, openCount, PHASES, processMap, stepOf, textIn, type AutomationCommand, type AutomationView, type CaseCheck, type RunDetail, type RunSummary, type StepDecl, type StepRecord, type Task, type Text, type Trigger, type WorkflowDecl } from '../../../workflows/model.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import { BotIcon, Graph } from './Graph.js';
import { RunsHome } from './Runs.js';
import { QueuePage } from './Queue.js';
import type { Index } from '../../../types/index.js';
import type { Made as MadeThing, Took } from '../../../workflows/summary.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { sources } from '../../lib/api.js';
import { Paper } from '../receipts/Paper.js';

type Props = AreaProps<RouteOf<'automation'>>;
type R = RouteOf<'automation'>;
type WorkflowRoute = Extract<R, { view: 'workflow' }>;

const tx = (v: Text) => textIn(v, language());
const label = (w: WorkflowDecl) => tx(w.label);
const forLabel = (kind: string) => t(`automation.for.${kind}` as 'automation.for.transaction');
const status = (s: RunSummary['status']) => t(`automation.status.${s}` as 'automation.status.done');
const phaseLabel = (p: string) => t(`automation.phase.${p}` as 'automation.phase.book');
/** 15.10.2026 11:30, in the viewer's time zone (runs store UTC). */
const when = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** The rows of the list, in order: what J and K move through. */
function rowsOf(view: AutomationView | undefined): R[] {
  const ws = view?.workflows ?? [];
  return [
    { area: 'automation', view: 'runs' },
    { area: 'automation', view: 'map', map: 'phases' },
    { area: 'automation', view: 'queue' },
    { area: 'automation', view: 'tasks' },
    ...PHASES.flatMap((p) => ws.filter((w) => w.phase === p).map((w): R => ({ area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph' }))),
  ];
}

const sameRow = (a: R, b: R) => a.view === b.view && (a.view !== 'workflow' || (b.view === 'workflow' && a.workflow === b.workflow));

/** The row a route marks: a run marks its workflow. */
function selectedRow(route: R, view: AutomationView | undefined): R | undefined {
  if (route.view !== 'run') return route;
  const w = view?.runs.find((r) => r.id === route.run)?.workflow;
  return w ? { area: 'automation', view: 'workflow', workflow: w, tab: 'runs' } : undefined;
}

function List({ route, nav, books }: Props) {
  const { view, error } = useAutomation();
  if (route.view === 'runs') return view ? <RunsHome view={view} books={books} nav={nav} /> : <><h1>{t('area.automation')}</h1>{error ? <p className="warnline">{error}</p> : <p className="m">{t('automation.empty')}</p>}</>;
  const sel = selectedRow(route, view);
  const waiting = view?.tasks ?? [];
  const row = (r: R, content: ReactNode) => {
    const on = !!sel && sameRow(r, sel);
    return (
      <div key={r.view === 'workflow' ? r.workflow : r.view} className={`row wfrow${on ? ' sel' : ''}`} role="option" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => nav.select(r)}>
        {content}
      </div>
    );
  };
  return (
    <>
      <h1>{t('area.automation')}</h1>
      {error ? <p className="warnline">{error}</p> : null}
      <div className="rows" role="listbox" aria-label={t('area.automation')}>
        <div className="group"><span>{t('automation.overview')}</span></div>
        {row({ area: 'automation', view: 'runs' }, <span className="t">{t('runs.latest')}</span>)}
        {row({ area: 'automation', view: 'map', map: 'phases' }, <span className="t">{t('automation.map')}</span>)}
        {row({ area: 'automation', view: 'queue' }, <span className="t">{t('automation.queue')}</span>)}
        {row({ area: 'automation', view: 'tasks' }, <><span className="t">{t('automation.tasks')}</span>{waiting.length ? <span className="a"><span className="wfpill warn">{waiting.length}</span></span> : null}</>)}
        {PHASES.map((p) => {
          const ws = view?.workflows.filter((w) => w.phase === p) ?? [];
          if (!ws.length) return null;
          return (
            <Fragment key={p}>
              <div className="group"><span>{phaseLabel(p)}</span></div>
              {ws.map((w) => {
                const runs = view!.runs.filter((r) => r.workflow === w.id).length;
                return row({ area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph' }, (
                  <>
                    <span className="t">{hasAi(w, view!.workflows) ? <span title={t('automation.ai')}><BotIcon /></span> : null}{label(w)}</span>
                    <span className="a">
                      {w.runnable.ok ? <span className="m">{runs ? t('automation.runCount', { n: runs }) : tx(w.cadence)}</span> : <span className="wfpill muted">{t('automation.notRunnable')}</span>}
                    </span>
                  </>
                ));
              })}
            </Fragment>
          );
        })}
      </div>
      {view?.problems.length ? (
        <div className="wfproblems"><p>{t('automation.problems')}</p><ul>{view.problems.map((p) => <li key={p.workflow + p.message}><b>{p.workflow}</b> {p.message}</li>)}</ul></div>
      ) : null}
    </>
  );
}

function Detail({ route, nav, books }: Props) {
  const { view } = useAutomation();
  if (!view) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  switch (route.view) {
    case 'runs': return null;
    case 'workflow': {
      if (!route.workflow) return <div className="detail-empty"><div>{t('automation.pick')}</div></div>;
      const w = view.workflows.find((x) => x.id === route.workflow);
      return w ? <WorkflowPage w={w} view={view} route={route} nav={nav} /> : <div className="detail-empty"><div>{t('automation.unknown', { id: route.workflow })}</div></div>;
    }
    case 'run': return <RunPage id={route.run} view={view} nav={nav} books={books} />;
    case 'map': return <MapPage view={view} map={route.map} nav={nav} />;
    case 'queue': return <QueuePage view={view} nav={nav} />;
    case 'tasks': return <TasksPage view={view} nav={nav} run={route.run} />;
  }
}

function WorkflowPage({ w, view, route, nav }: { w: WorkflowDecl; view: AutomationView; route: WorkflowRoute; nav: Nav }) {
  const go = (r: Partial<WorkflowRoute>) => nav.select({ area: 'automation', view: 'workflow', workflow: w.id, tab: route.tab, ...r });
  const step = route.step ? stepOf(w, route.step) : undefined;
  return (
    <div className="detail-in wfpage" key={w.id}>
      <div className="head">
        <h2 className="who">{hasAi(w, view.workflows) ? <span title={t('automation.ai')}><BotIcon /></span> : null}{label(w)}<small>{phaseLabel(w.phase)} · {tx(w.cadence)} · {forLabel(w.for)}</small></h2>
        <AskAi context={{ kind: 'workflow', id: w.id, label: label(w) }} />
      </div>
      <p className="lead">{tx(w.desc)}</p>
      <Pending w={w} view={view} nav={nav} />
      {!w.runnable.ok ? <p className="warnline">{t('automation.missing', { steps: w.runnable.missing.map((m) => `${tx(stepOf(w, m.step)?.label ?? { en: m.step })} (${m.action})`).join(', ') })}</p> : null}
      <div className="wftabs" role="tablist">
        {AUTOMATION_TABS.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={route.tab === tab} className={route.tab === tab ? 'on' : ''} onClick={() => go({ tab, step: undefined })}>{t(`automation.tab.${tab}` as 'automation.tab.graph')}</button>
        ))}
      </div>
      {route.tab === 'graph' ? (
        <>
          <div className="wfscroll"><Graph workflow={w} selected={route.step} onSelect={(s) => go({ tab: 'graph', step: s })} /></div>
          {step ? <StepPanel w={w} step={step} view={view} nav={nav} /> : null}
        </>
      ) : route.tab === 'triggers' ? (
        <Triggers w={w} nav={nav} />
      ) : route.tab === 'runs' ? (
        <RunList runs={view.runs.filter((r) => r.workflow === w.id)} nav={nav} />
      ) : (
        <ul className="wffiles">
          <li className="m">{t(`automation.origin.${w.origin}` as 'automation.origin.app')}</li>
          {filesOf(w).map((f) => <li key={f} className="mono">{f}</li>)}
        </ul>
      )}
    </div>
  );
}

/** The declaration files of a workflow, as paths under the app's or the company's folder. */
const filesOf = (w: WorkflowDecl): string[] => [`workflows/${w.id}/workflow.yaml`, ...w.steps.map((s) => `workflows/${w.id}/${s.id}/step.yaml`)];

function StepPanel({ w, step, view, nav }: { w: WorkflowDecl; step: StepDecl; view: AutomationView; nav: Nav }) {
  const body = step.body;
  const notBuilt = !w.runnable.ok && w.runnable.missing.some((m) => m.step === step.id);
  const line = (k: string, v: ReactNode) => (v ? <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div> : null);
  const target = (to: StepDecl['outcomes'][string]) => (to.to === 'end' ? t('automation.end') : tx(stepOf(w, to.step)?.label ?? { en: to.step }));
  return (
    <div className="wfstep">
      <h3>{step.kind === 'agent' ? <BotIcon /> : null}{tx(step.label)} <small>{t(`automation.kind.${step.kind}` as 'automation.kind.step')}</small></h3>
      {body.kind === 'action' ? line(t('automation.step.uses'), <><span className="mono">{body.uses}</span>{notBuilt ? <span className="wfpill muted">{t('automation.step.notBuilt')}</span> : null}</>) : null}
      {body.kind === 'call' ? line(t('automation.step.calls'), <button type="button" className="linkbtn" onClick={() => nav.select({ area: 'automation', view: 'workflow', workflow: body.workflow, tab: 'graph' })}>{label(view.workflows.find((x) => x.id === body.workflow) ?? w)}</button>) : null}
      {body.kind === 'person' ? line(t('automation.step.person'), tx(body.task.title)) : null}
      {body.kind === 'wait' ? line(t('automation.step.waitsFor'), <span className="mono">{body.for}</span>) : null}
      {step.forEach ? line(t('automation.step.forEach'), <span className="mono">{step.forEach}</span>) : null}
      {line(t('automation.step.reads'), step.reads.join(', '))}
      {line(t('automation.step.emits'), step.emits.join(', '))}
      {line(t('automation.step.effects'), step.effects.join(', '))}
      {line(t('automation.step.outcomes'), Object.entries(step.outcomes).map(([o, to]) => `${o} → ${target(to)}`).join(' · '))}
      {step.guide ? line(t('automation.step.guide'), <span className="mono">{step.guide}</span>) : null}
    </div>
  );
}

function triggerText(tr: Trigger): string {
  switch (tr.kind) {
    case 'manual': return t('automation.trigger.manual', { label: tx(tr.label), kind: forLabel(tr.for) });
    case 'event': return t('automation.trigger.event', { name: tr.name });
    case 'schedule': return t('automation.trigger.schedule', { cron: tr.cron });
    case 'outside': return t('automation.trigger.outside', { accepts: tr.accepts.map(forLabel).join(', ') });
  }
}

function Triggers({ w, nav }: { w: WorkflowDecl; nav: Nav }) {
  const schedule = w.triggers.find((tr): tr is Extract<Trigger, { kind: 'schedule' }> => tr.kind === 'schedule');
  const [cron, setCron] = useState(schedule?.cron ?? '');
  const save = (value: string | null) => setSchedule(w.id, value).then(() => nav.toast(t('automation.scheduleSaved')), (e) => nav.toast(errorText(e)));
  return (
    <>
      {w.triggers.length ? (
        <ul className="wftriggers">
          {w.triggers.map((tr, i) => <li key={i} className={tr.off ? 'off' : ''}>{triggerText(tr)}{tr.off ? <span className="wfpill muted">{t('automation.trigger.off')}</span> : null}</li>)}
        </ul>
      ) : <p className="m">{t('automation.noTriggers')}</p>}
      {schedule ? (
        <form className="wfsched" onSubmit={(e) => { e.preventDefault(); void save(cron.trim()); }}>
          <label>{t('automation.schedule')}<input className="mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 7 * * *" aria-describedby={`sched-${w.id}`} /></label>
          <button type="submit" className="btn" disabled={!cron.trim() || (cron.trim() === schedule.cron && !schedule.off)}>{t('automation.scheduleSave')}</button>
          {!schedule.off ? <button type="button" className="btn ghost" onClick={() => void save(null)}>{t('automation.scheduleOff')}</button> : null}
          <span id={`sched-${w.id}`} className="m">{t('automation.scheduleTip')}</span>
        </form>
      ) : null}
    </>
  );
}

/**
 * A version waiting to be switched on (screen 6): what changed, the cases checked against it, and
 * the two decisions apart from saving: check the cases, then switch it on.
 */
function Pending({ w, view, nav }: { w: WorkflowDecl; view: AutomationView; nav: Nav }) {
  const p = view.pending.find((x) => x.workflow === w.id);
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const act = (cmd: AutomationCommand, done?: string) => async () => {
    setBusy(true);
    try {
      const r = await automationCommand(cmd);
      nav.toast(r.ok ? done ?? t('automation.done') : t(`automation.refusal.${r.refusal}` as 'automation.refusal.not-found', { detail: r.detail ?? '' }));
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const count = (s: CaseCheck['status']) => p.checks.filter((c) => c.status === s).length;
  const open = (run: string) => nav.go({ route: { area: 'automation', view: 'run', run }, query: {} });
  return (
    <div className="wfpending">
      <b>{t('automation.pending.title')}</b>
      <span className="m">{t('automation.pending.files', { files: p.files.slice(0, 4).join(', ') + (p.files.length > 4 ? ` +${p.files.length - 4}` : '') })}</span>
      {p.checks.length ? (
        <>
          <span>{t('automation.pending.checked', { same: count('same'), different: count('different'), stuck: count('stuck'), running: count('running') })}</span>
          <ul className="wfcases">
            {p.checks.filter((c) => c.status !== 'same').map((c) => (
              <li key={c.run}>
                <span className={`wfpill ${c.status === 'running' ? 'st-running' : c.status === 'stuck' ? 'st-stuck' : 'warn'}`}>{t(`automation.case.${c.status}` as 'automation.case.same')}</span>
                <span className="mono">{c.item.id}</span>
                {c.detail ? <span className="m mono">{c.detail}</span> : null}
                <button type="button" className="linkbtn" onClick={() => open(c.of)}>{t('automation.case.before')}</button>
                <button type="button" className="linkbtn" onClick={() => open(c.run)}>{t('automation.case.after')}</button>
              </li>
            ))}
          </ul>
        </>
      ) : <span className="m">{t('automation.pending.unchecked')}</span>}
      <span className="wfactions">
        <button type="button" className="btn" disabled={busy} onClick={act({ kind: 'check', workflow: w.id }, t('automation.pending.checking'))}><BotIcon />{t('automation.pending.check')}</button>
        <button type="button" className="btn primary" disabled={busy || count('running') > 0} onClick={act({ kind: 'approve', workflow: w.id }, t('automation.pending.on'))}>{t('automation.pending.approve')}</button>
      </span>
      <span className="m">{t('automation.pending.why')}</span>
    </div>
  );
}

function RunList({ runs, nav }: { runs: RunSummary[]; nav: Nav }) {
  if (!runs.length) return <p className="m">{t('automation.noRuns')}</p>;
  return (
    <div className="wfruns">
      {runs.map((r) => (
        <button key={r.id} type="button" className="wfrun" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: r.id }, query: {} })}>
          <span className={`wfpill st-${r.status}`}>{status(r.status)}{r.overdue ? ` · ${t('automation.overdue')}` : ''}</span>
          <span className="mono">{r.item.id}</span>
          <span className="m">{r.path.join(' → ')}</span>
          <span className="m date">{when(r.startedAt)}</span>
        </button>
      ))}
    </div>
  );
}

/** What started a run, in words. */
function startedText(by: RunDetail['startedBy']): string {
  switch (by.kind) {
    case 'manual': return t('automation.by.manual');
    case 'event': return t('automation.by.event', { name: by.name });
    case 'schedule': return t('automation.by.schedule');
    case 'outside': return t('automation.by.outside', { file: by.file });
    case 'parent': return t('automation.by.parent', { run: by.run });
    case 'replay': return t('automation.by.replay', { run: by.of });
    case 'check': return t('automation.by.check', { run: by.of });
  }
}

/** What the run was for, as a person names it: the file, the transaction, the period. */
function runTitle(data: RunDetail, books: Index, w?: WorkflowDecl): string {
  if (data.startedBy.kind === 'outside') return data.startedBy.file;
  if (data.item.kind === 'transaction') {
    const tr = books.transactions.find((x) => x.ref === data.item.id);
    if (tr) return `${tr.description} ${tr.currency} ${fmt(tr.direction === 'DBIT' ? -tr.amount : tr.amount)}`;
  }
  return data.item.kind === 'company' && w ? label(w) : data.item.id;
}

const money = (amount?: number, currency?: string) => (amount === undefined ? '' : `${currency ?? ''} ${fmt(amount)}`.trim());

/** LIEST: what the step had in front of it. */
function Took({ s }: { s: StepRecord }) {
  const took = (s.output?.took as Took[] | undefined) ?? [];
  const input = Object.entries(s.input).filter(([, v]) => v);
  if (!took.length && !input.length) return <p className="m">—</p>;
  return (
    <>
      {took.map((x, i) => (
        x.kind === 'files' ? <div key={i}>{t('automation.took.files', { n: x.names.length })}<ul>{x.names.map((n) => <li key={n} className="mono">{n}</li>)}</ul></div>
          : x.kind === 'receipts' ? <div key={i}>{t('automation.took.receipts', { n: x.ids.length })}<ul>{x.files.slice(0, 8).map((n) => <li key={n} className="mono">{n}</li>)}</ul></div>
          : <div key={i}>{t('automation.took.transactions', { n: x.n })}</div>
      ))}
      {input.map(([k, v]) => <div key={k} className="mono">{k}: {v}</div>)}
    </>
  );
}

/** ERGEBNIS: what the step made, each thing a link to where it now is. */
function Made({ s, nav }: { s: StepRecord; nav: Nav }) {
  const made = (s.output?.made as MadeThing[] | undefined);
  const go = (route: Route) => () => nav.go({ route, query: {} });
  if (made) {
    if (!made.length) return <p className="m">{t('automation.made.nothing')}</p>;
    return (
      <ul className="wfmade">
        {made.map((x, i) => (
          <li key={i}>
            {x.kind === 'receipt' ? (
              <>
                <button type="button" className="linkbtn" onClick={go({ area: 'receipts', id: x.id })}>{x.file}</button>
                <small>{[x.isNew ? t('automation.made.new') : t('automation.made.changed'), x.date && formatDate(x.date), money(x.amount, x.currency), x.swissVat === false ? t('automation.made.noSwissVat') : x.vatId].filter(Boolean).join(' · ')}</small>
              </>
            ) : x.kind === 'link' ? (
              <>
                <span>{t('automation.made.link')} </span>
                <button type="button" className="linkbtn" onClick={go({ area: 'bank', payment: x.transaction })}>{[x.counterparty, x.date && formatDate(x.date), money(x.amount, x.currency)].filter(Boolean).join(' · ') || x.transaction}</button>
                <small>{x.receiptFile}</small>
              </>
            ) : (
              <>
                <button type="button" className="linkbtn" onClick={go({ area: 'journal', id: x.id })}>{t('automation.made.entry', { debit: x.debit, credit: x.credit })}</button>
                <small>{[formatDate(x.date), fmt(x.amount), x.vatCode, x.description].filter(Boolean).join(' · ')}</small>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }
  const rest = Object.entries(s.output ?? {}).filter(([k]) => k !== 'notes');
  if (!rest.length) return <p className="m">{s.outcome ? t('automation.made.outcome', { outcome: s.outcome }) : '—'}</p>;
  return <>{rest.map(([k, v]) => <div key={k} className="mono">{k}: {short(v)}</div>)}</>;
}

/** A note of an inbox step (src/intake/pipeline.ts IntakeNote): why it did less than it had to do. */
type StepNote = { code: 'noModel'; waiting: number } | { code: 'failed'; count: number; detail: string } | { code: 'unmatched'; files: string[] } | { code: 'filedKept'; count: number } | { code: 'poorScan'; files: string[] } | { code: 'error'; detail: string };
function noteText(n: StepNote): string {
  switch (n.code) {
    case 'noModel': return t('automation.note.noModel', { n: n.waiting });
    case 'failed': return t('automation.note.failed', { n: n.count, detail: n.detail });
    case 'unmatched': return t('automation.note.unmatched', { n: n.files.length, files: n.files.join(', ') });
    case 'filedKept': return t('automation.note.filedKept', { n: n.count });
    case 'poorScan': return t('automation.note.poorScan', { n: n.files.length, files: n.files.join(', ') });
    case 'error': return n.detail;
  }
}

/** The documents a run worked on: the receipts it took up or changed, else the file that started it. */
function runDocuments(data: RunDetail, books: Index): Index['receipts'] {
  const ids = new Set(data.steps.flatMap((s) => ((s.output?.made as MadeThing[] | undefined) ?? []).flatMap((m) => (m.kind === 'receipt' ? [m.id] : m.kind === 'link' ? [m.receipt] : []))));
  const made = books.receipts.filter((r) => ids.has(r.id));
  if (made.length) return made;
  const file = data.startedBy.kind === 'outside' ? data.startedBy.file : undefined;
  return file ? books.receipts.filter((r) => r.originalFilename === file || r.filename === file) : [];
}

/** The document beside its facts, to check the run against it. */
function RunDocument({ r, nav }: { r: Index['receipts'][number]; nav: Nav }) {
  const src = sources.receipt(r.id);
  return (
    <div className="rundoc">
      <div className="paper real"><Paper key={src} src={src} maxWidth={420} /></div>
      <div className="rdfacts">
        <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'receipts', id: r.id }, query: {} })}><b>{r.filename}</b></button>
        {r.originalFilename && r.originalFilename !== r.filename ? <small className="mono">{r.originalFilename}</small> : null}
        <dl>
          {r.date ? <><dt>{t('automation.doc.date')}</dt><dd>{formatDate(r.date)}</dd></> : null}
          {r.amount !== undefined ? <><dt>{t('automation.doc.amount')}</dt><dd className="mono">{money(r.amount, r.currency)}</dd></> : null}
          <dt>{t('automation.doc.vat')}</dt><dd>{r.hasSwissVat ? (r.vatId ?? t('automation.doc.swissVat')) : r.hasSwissVat === false ? t('automation.made.noSwissVat') : '—'}</dd>
          {r.description ? <><dt>{t('automation.doc.what')}</dt><dd>{r.description}</dd></> : null}
          <dt>{t('automation.doc.state')}</dt><dd>{r.location === 'archived' ? t('automation.doc.archived') : t('automation.doc.staged')}</dd>
        </dl>
        <a className="linkbtn" href={src} download={r.filename}>{t('receipts.download')}</a>
      </div>
    </div>
  );
}

const short = (v: unknown): string => { const j = typeof v === 'string' ? v : JSON.stringify(v); return j.length > 240 ? `${j.slice(0, 240)} …` : j; };

function RunPage({ id, view, nav, books }: { id: string; view: AutomationView; nav: Nav; books: Index }) {
  const { data, error } = useRun(id, view.rev);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  const w = view.workflows.find((x) => x.id === data.workflow);
  const act = (cmd: AutomationCommand) => () => { void automationCommand(cmd).then((r) => { if (!r.ok) nav.toast(r.detail ?? r.refusal); else if (cmd.kind === 'replay' && r.run) nav.go({ route: { area: 'automation', view: 'run', run: r.run }, query: {} }); }); };
  const seconds = data.finishedAt ? Math.max(1, Math.round((Date.parse(data.finishedAt) - Date.parse(data.startedAt)) / 1000)) : undefined;
  return (
    <div className="detail-in wfpage" key={id}>
      <div className="head">
        <h2 className="who">{t('automation.runOf', { what: runTitle(data, books, w) })}<small>{w ? label(w) : data.workflow}</small></h2>
      </div>
      <p className="lead">
        <span className={`wfpill st-${data.status}`}>{status(data.status)}</span>{' '}
        {t('automation.startedAt', { when: when(data.startedAt), by: startedText(data.startedBy) })}
        {seconds ? ` · ${t('automation.duration', { n: seconds })}` : ''}
        {data.mode !== 'live' ? ` · ${data.mode}` : ''}{data.reason ? ` · ${t(`automation.queuedBecause.${data.reason}` as 'automation.queuedBecause.slot')}` : ''}
      </p>
      <p className="m mono runid">{id}</p>
      {data.error ? <p className="warnline">{data.error}</p> : null}
      <div className="wfactions">
        {data.status === 'waiting' ? <button type="button" className="btn" onClick={() => nav.select({ area: 'automation', view: 'tasks', run: id })}>{t('automation.openTask')}</button> : null}
        {data.status === 'stuck' || data.status === 'parked' ? <button type="button" className="btn" onClick={act({ kind: 'resume', run: id })}>{t('automation.resume')}</button> : null}
        {data.status === 'done' || data.status === 'stuck' ? <button type="button" className="btn ghost" onClick={act({ kind: 'replay', run: id })}>{t('automation.replay')}</button> : null}
        <AskAi context={{ kind: 'run', id, label: t('automation.run', { id }) }} mode={data.status === 'stuck' ? 'ask' : 'change'} />
        {data.status !== 'done' && data.status !== 'discarded' ? <button type="button" className="btn ghost" onClick={act({ kind: 'discard', run: id })}>{t('automation.discard')}</button> : null}
      </div>
      {runDocuments(data, books).slice(0, 3).map((r) => <RunDocument key={r.id} r={r} nav={nav} />)}
      {w ? <div className="wfscroll"><Graph workflow={w} path={data.path} at={data.at} onSelect={(s) => nav.go({ route: { area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph', step: s }, query: {} })} /></div> : null}
      <ol className="wfsteps">
        {data.steps.map((s, i) => {
          const decl = w ? stepOf(w, s.step) : undefined;
          return (
            <li key={`${s.step}-${i}`} className={s.error ? 'err' : s.outcome ? 'ok' : 'on'}>
              <div className="sh">
                <b>{decl ? tx(decl.label) : s.step}</b>
                <span className="mono m">{decl?.body.kind === 'action' ? decl.body.uses : s.step}</span>
                {s.outcome ? <span className="mono m">→ {s.outcome}</span> : null}
              </div>
              <div className="io">
                <div className="box"><small>{t('automation.io.took')}</small><Took s={s} /></div>
                <div className="box"><small>{t('automation.io.made')}</small><Made s={s} nav={nav} /></div>
              </div>
              {s.error ? <div className="warnline">{s.error}</div> : null}
              {((s.output?.notes as StepNote[] | undefined) ?? []).map((n, j) => <div key={`n${j}`} className="warnline">{noteText(n)}</div>)}
              {s.effects.filter((e) => e.refused || (!e.applied && Array.isArray(e.would))).map((e, j) => (
                <div key={j} className={e.refused ? 'warnline' : 'm'}>{e.refused ? t('automation.refused', { reason: e.refused }) : t('automation.wouldBook', { n: (e.would as unknown[]).length })}</div>
              ))}
              {s.llm.map((c, j) => (
                <details key={j} className="llm"><summary><BotIcon /> {t('automation.io.llm')}</summary><pre>{c.answer}</pre></details>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MapPage({ view, map, nav }: { view: AutomationView; map: 'phases' | 'events'; nav: Nav }) {
  const m = processMap(view.workflows);
  const byId = (id: string) => view.workflows.find((w) => w.id === id)!;
  const open = (id: string) => nav.go({ route: { area: 'automation', view: 'workflow', workflow: id, tab: 'graph' }, query: {} });
  return (
    <div className="detail-in wfpage">
      <div className="head"><h2 className="who">{t('automation.map')}</h2></div>
      <div className="wftabs" role="tablist">
        {(['phases', 'events'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={map === k} className={map === k ? 'on' : ''} onClick={() => nav.select({ area: 'automation', view: 'map', map: k })}>{t(k === 'phases' ? 'automation.mapPhases' : 'automation.mapEvents')}</button>
        ))}
      </div>
      {map === 'phases' ? (
        <div className="wfmap">
          {m.phases.map((p) => (
            <div key={p.phase} className="col">
              <h3>{phaseLabel(p.phase)}</h3>
              {p.workflows.map((id) => {
                const w = byId(id);
                return (
                  <button key={id} type="button" className={`wfcard${w.runnable.ok ? '' : ' dim'}`} onClick={() => open(id)}>
                    <b>{hasAi(w, view.workflows) ? <BotIcon /> : null}{label(w)}</b>
                    <span className="m">{tx(w.cadence)}</span>
                    {m.arrows.filter((a) => a.from === id).map((a) => <span key={a.to + a.via} className={`m next${a.off ? ' off' : ''}`}>→ {label(byId(a.to))}</span>)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <ul className="wfarrows">
          {m.arrows.map((a) => (
            <li key={a.from + a.to + a.via} className={a.off ? 'off' : ''}>
              <button type="button" className="linkbtn" onClick={() => open(a.from)}>{label(byId(a.from))}</button>
              <span className="mono"> {a.via === 'call' ? t('automation.via.call') : a.via} </span>→ <button type="button" className="linkbtn" onClick={() => open(a.to)}>{label(byId(a.to))}</button>
              {a.off ? <span className="wfpill muted">{t('automation.trigger.off')}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TasksPage({ view, nav, run }: { view: AutomationView; nav: Nav; run?: string }) {
  const answer = (task: Task, outcome: string) => () => { void automationCommand({ kind: 'answer', run: task.run, outcome }).then((r) => { if (!r.ok) nav.toast(r.detail ?? r.refusal); }); };
  return (
    <div className="detail-in wfpage">
      <div className="head"><h2 className="who">{t('automation.tasks')}</h2></div>
      {view.tasks.length ? (
        <div className="wftasks">
          {view.tasks.map((task) => {
            const w = view.workflows.find((x) => x.id === task.workflow);
            return (
              <div key={task.run} className={`wftask${task.run === run ? ' sel' : ''}`}>
                <b>{fillTask(tx(task.title), task.item)}{task.overdue ? <span className="wfpill st-stuck">{t('automation.overdue')}</span> : null}</b>
                <span className="m">{w ? label(w) : task.workflow} · {t('automation.since', { date: when(task.since) })}</span>
                {task.why ? <p>{fillTask(tx(task.why), task.item)}</p> : null}
                <span className="wfactions">
                  {task.do === 'open-item' && itemRoute(task.item) ? <button type="button" className="btn ghost" onClick={() => nav.go({ route: itemRoute(task.item)!, query: {} })}>{t('automation.openItem')}</button> : null}
                  {task.outcomes.map((o) => <button key={o} type="button" className="btn" onClick={answer(task, o)}>{tData(`automation.outcome.${o}`)}</button>)}
                  <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: task.run }, query: {} })}>{t('automation.run', { id: task.run })}</button>
                </span>
              </div>
            );
          })}
        </div>
      ) : <p className="lead">{t('automation.tasksEmpty')}</p>}
    </div>
  );
}

/** Where an item of a run is shown in the other areas. */
function itemRoute(item: Task['item']): Route | undefined {
  switch (item.kind) {
    case 'transaction': return { area: 'bank', payment: item.id };
    case 'entry': return { area: 'journal', id: item.id };
    case 'receipt': return { area: 'receipts', id: item.id };
    default: return undefined;
  }
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('automation.workflows'), t('automation.pick')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const automation: Area<RouteOf<'automation'>> = {
  id: 'automation',
  label: () => t('area.automation'),
  dock: { key: 'w', icon: ICONS.automation, tip: () => t('area.automation.tip'), badge: () => { const v = automationNow(); return v ? openCount(v) : 0; } },
  List,
  Detail,
  legend,
  periodless: true,
  fullPage: (r) => r.view === 'runs',
  title: (r) => (r.view === 'workflow' ? r.workflow : r.view === 'run' ? r.run : undefined),
  keys(e, { route, nav }) {
    const d = moveKey(e);
    if (!d || route.view === 'runs') return false;
    const view = automationNow();
    const rows = rowsOf(view);
    const sel = selectedRow(route, view);
    const i = sel ? rows.findIndex((r) => sameRow(r, sel)) : -1;
    nav.select(rows[Math.min(rows.length - 1, Math.max(0, i + d))]);
    return true;
  },
  palette: ({ nav }) => (automationNow()?.workflows ?? []).map((w) => ({
    label: label(w),
    side: t('area.automation'),
    run: () => nav.go({ route: { area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph' }, query: {} }),
  })),
};
