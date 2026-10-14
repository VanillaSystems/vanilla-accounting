/**
 * Automatisierung (docs/0.4.0/ui/design.md): every workflow by phase with its graph, triggers,
 * runs and files; the process map; the queue and the tasks. Everything comes from the declarations
 * and the stored runs (GET /api/automation); nothing here is a list of its own.
 */
import { Fragment, type ReactNode } from 'react';
import './automation.css';
import { AUTOMATION_TABS, type RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { language, t } from '../../i18n/index.js';
import { automationNow, useAutomation, useRun } from '../../automation/store.js';
import { hasAi, PHASES, processMap, stepOf, textIn, type AutomationView, type RunSummary, type StepDecl, type Text, type Trigger, type WorkflowDecl } from '../../../workflows/model.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import { BotIcon, Graph } from './Graph.js';

type Props = AreaProps<RouteOf<'automation'>>;
type R = RouteOf<'automation'>;
type WorkflowRoute = Extract<R, { view: 'workflow' }>;

const tx = (v: Text) => textIn(v, language());
const label = (w: WorkflowDecl) => tx(w.label);
const forLabel = (kind: string) => t(`automation.for.${kind}` as 'automation.for.transaction');
const status = (s: RunSummary['status']) => t(`automation.status.${s}` as 'automation.status.done');
const phaseLabel = (p: string) => t(`automation.phase.${p}` as 'automation.phase.book');
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** The rows of the list, in order: what J and K move through. */
function rowsOf(view: AutomationView | undefined): R[] {
  const ws = view?.workflows ?? [];
  return [
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

function List({ route, nav }: Props) {
  const { view, error } = useAutomation();
  const sel = selectedRow(route, view);
  const waiting = view?.runs.filter((r) => r.status === 'waiting') ?? [];
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

function Detail({ route, nav }: Props) {
  const { view } = useAutomation();
  if (!view) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  switch (route.view) {
    case 'workflow': {
      if (!route.workflow) return <div className="detail-empty"><div>{t('automation.pick')}</div></div>;
      const w = view.workflows.find((x) => x.id === route.workflow);
      return w ? <WorkflowPage w={w} view={view} route={route} nav={nav} /> : <div className="detail-empty"><div>{t('automation.unknown', { id: route.workflow })}</div></div>;
    }
    case 'run': return <RunPage id={route.run} view={view} nav={nav} />;
    case 'map': return <MapPage view={view} map={route.map} nav={nav} />;
    case 'queue': return <div className="detail-in wfpage"><div className="head"><h2 className="who">{t('automation.queue')}</h2></div><p className="lead">{t('automation.queueEmpty')}</p></div>;
    case 'tasks': return <TasksPage view={view} nav={nav} />;
  }
}

function WorkflowPage({ w, view, route, nav }: { w: WorkflowDecl; view: AutomationView; route: WorkflowRoute; nav: Nav }) {
  const go = (r: Partial<WorkflowRoute>) => nav.select({ area: 'automation', view: 'workflow', workflow: w.id, tab: route.tab, ...r });
  const step = route.step ? stepOf(w, route.step) : undefined;
  return (
    <div className="detail-in wfpage" key={w.id}>
      <div className="head">
        <h2 className="who">{hasAi(w, view.workflows) ? <span title={t('automation.ai')}><BotIcon /></span> : null}{label(w)}<small>{phaseLabel(w.phase)} · {tx(w.cadence)} · {forLabel(w.for)}</small></h2>
      </div>
      <p className="lead">{tx(w.desc)}</p>
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
        <Triggers w={w} />
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

function Triggers({ w }: { w: WorkflowDecl }) {
  if (!w.triggers.length) return <p className="m">{t('automation.noTriggers')}</p>;
  return (
    <ul className="wftriggers">
      {w.triggers.map((tr, i) => <li key={i} className={tr.off ? 'off' : ''}>{triggerText(tr)}{tr.off ? <span className="wfpill muted">{t('automation.trigger.off')}</span> : null}</li>)}
    </ul>
  );
}

function RunList({ runs, nav }: { runs: RunSummary[]; nav: Nav }) {
  if (!runs.length) return <p className="m">{t('automation.noRuns')}</p>;
  return (
    <div className="wfruns">
      {runs.map((r) => (
        <button key={r.id} type="button" className="wfrun" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: r.id }, query: {} })}>
          <span className={`wfpill st-${r.status}`}>{status(r.status)}</span>
          <span className="mono">{r.item.id}</span>
          <span className="m">{r.path.join(' → ')}</span>
          <span className="m date">{when(r.startedAt)}</span>
        </button>
      ))}
    </div>
  );
}

function RunPage({ id, view, nav }: { id: string; view: AutomationView; nav: Nav }) {
  const { data, error } = useRun(id, view.rev);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  const w = view.workflows.find((x) => x.id === data.workflow);
  return (
    <div className="detail-in wfpage" key={id}>
      <div className="head">
        <h2 className="who">{t('automation.run', { id })}<small>{w ? label(w) : data.workflow} · {forLabel(data.item.kind)} <span className="mono">{data.item.id}</span></small></h2>
      </div>
      <p className="lead"><span className={`wfpill st-${data.status}`}>{status(data.status)}</span> {when(data.startedAt)}{data.of ? ` · ${t('automation.replayOf', { id: data.of })}` : ''}</p>
      {data.error ? <p className="warnline">{data.error}</p> : null}
      {w ? <div className="wfscroll"><Graph workflow={w} path={data.path} at={data.at} onSelect={(s) => nav.go({ route: { area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph', step: s }, query: {} })} /></div> : null}
      <ol className="wftimeline">
        {data.steps.map((s, i) => (
          <li key={`${s.step}-${i}`}>
            <b>{w ? tx(stepOf(w, s.step)?.label ?? { en: s.step }) : s.step}</b>
            {s.outcome ? <span className="mono"> → {s.outcome}</span> : null}
            {s.error ? <div className="warnline">{s.error}</div> : null}
            {s.llm ? <div className="m">{t('automation.llm', { n: s.llm })}</div> : null}
            {s.effects.map((e, j) => <div key={j} className="m">{e.applied ? t('automation.effect.applied', { effect: e.effect }) : t('automation.effect.muted', { effect: e.effect })}</div>)}
          </li>
        ))}
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

function TasksPage({ view, nav }: { view: AutomationView; nav: Nav }) {
  const waiting = view.runs.filter((r) => r.status === 'waiting');
  return (
    <div className="detail-in wfpage">
      <div className="head"><h2 className="who">{t('automation.tasks')}</h2></div>
      {waiting.length ? <RunList runs={waiting} nav={nav} /> : <p className="lead">{t('automation.tasksEmpty')}</p>}
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('automation.workflows'), t('automation.pick')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const automation: Area<RouteOf<'automation'>> = {
  id: 'automation',
  label: () => t('area.automation'),
  dock: { key: 'w', icon: ICONS.automation, tip: () => t('area.automation.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r) => (r.view === 'workflow' ? r.workflow : r.view === 'run' ? r.run : undefined),
  keys(e, { route, nav }) {
    const d = moveKey(e);
    if (!d) return false;
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
