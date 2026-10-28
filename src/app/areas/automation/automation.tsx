/**
 * Automatisierung (docs/0.4.0/ui/design.md): every workflow by phase with its graph, triggers,
 * runs and files; the process map; the queue and the tasks. Everything comes from the declarations
 * and the stored runs (GET /api/automation); nothing here is a list of its own.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { aiIsOff } from '../../ai/ai-off.js';
import { api, errorText } from '../../lib/api.js';
import './automation.css';
import { AskAi } from '../../assistant/AskAi.js';
import { AUTOMATION_TABS, type Route, type RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { isKey, language, t, tData } from '../../i18n/index.js';
import { Go } from '../vat/links.js';
import { automationCommand, automationNow, setSchedule, useAutomation, useRun } from '../../automation/store.js';
import { fillTask, hasAi, openCount, PHASES, processMap, stepOf, textIn, type AutomationCommand, type AutomationView, type CaseCheck, type RunDetail, type RunSummary, type StepDecl, type StepRecord, type Task, type Text, type Trigger, type WorkflowDecl } from '../../../workflows/model.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import { BotIcon, Graph } from './Graph.js';
import { RunsHome } from './Runs.js';
import { HomePage, whenText } from './Home.js';
import { workflowState } from '../../automation/home.js';
import { QueuePage } from './Queue.js';
import type { Index, JournalEntry } from '../../../types/index.js';
import type { IntakeNote } from '../../../intake/pipeline.js';
import type { Made as MadeThing, Took } from '../../../workflows/summary.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { sources } from '../../lib/api.js';
import { Paper } from '../receipts/Paper.js';
import { PaymentBooking } from '../journal/PaymentBooking.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { Parts } from '../bank/Parts.js';
import { approvalWithheld, fileName, returnSummary } from './filing-summary.js';
import { outcomeText, periodText, readsInWords } from './words.js';
import type { PeriodReturn, PreparedXml, SealOutput } from '../../../workflows/filing.js';
import type { ClearingCheck } from '../../../booking/providers.js';
import { commandRefusalText, refusalPayment, refusalText } from '../../automation/refusal.js';
import type { Refusal } from '../../../types/refusal.js';
import { RunFromLog } from '../../history/RunHistory.js';
import { baseCurrency, chargesVat, filing, vat } from '../../../engines/index.js';
import { QuestionTasks } from '../../questions/Questions.js';
import { useQuestions } from '../../questions/store.js';
import { forMe } from '../../../questions/model.js';
import { payText, signed, unbookedPayments } from '../bank/model.js';
import { at } from '../receipts/view.js';
import { AssessmentTasks, assessmentsMissing, EvidenceTasks, FiledEvidence, PeriodIssues, ReceiptDueTasks, ThresholdTasks, thresholdPassed, TwinTasks } from './Issues.js';
import { openTwins } from '../receipts/model.js';
import { ledgerFor } from '../receipts/view.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { journalOf, unsettledAtFiling } from '../journal/model.js';
import { addDays, localToday, parsePeriod } from '../../../accounting/periods.js';
import { waitingForReceipt } from '../../../accounting/receipt-due.js';
import { periodName } from '../../lib/period-label.js';
import { codeLabel } from '../codes/names.js';
import { reconciliationOf } from '../../../books/reconcile.js';

type Props = AreaProps<RouteOf<'automation'>>;
type R = RouteOf<'automation'>;
type WorkflowRoute = Extract<R, { view: 'workflow' }>;

const tx = (v: Text) => textIn(v, language());
const label = (w: WorkflowDecl) => tx(w.label);
const stepLabel = (w: WorkflowDecl, id: string) => { const s = stepOf(w, id); return s ? tx(s.label) : id; };
const forLabel = (kind: string) => t(`automation.for.${kind}` as 'automation.for.transaction');
const status = (s: RunSummary['status']) => t(`automation.status.${s}` as 'automation.status.done');
const phaseLabel = (p: string) => t(`automation.phase.${p}` as 'automation.phase.book');
/** 15.10.2026 11:30, in the viewer's time zone (runs store UTC). */
const when = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** The small icon before a trigger chip (the mockup's list): a clock, a tray, a bolt, a hand. */
const TRIGGER_ICON: Record<Trigger['kind'], ReactNode> = {
  schedule: <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>,
  outside: <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10M8 10l4 4 4-4" /><path d="M5 16v3h14v-3" /></svg>,
  event: <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 13h6l-1 8 8-10h-6z" /></svg>,
  manual: <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v6M15 10V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L9 12" /></svg>,
};

/** The rows of the list, in order: what J and K move through. */
function rowsOf(view: AutomationView | undefined): R[] {
  const groups = groupsOf(view);
  return [
    { area: 'automation', view: 'home' },
    { area: 'automation', view: 'runs' },
    { area: 'automation', view: 'map', map: 'phases' },
    { area: 'automation', view: 'queue' },
    { area: 'automation', view: 'tasks' },
    ...groups.flatMap((g) => g.workflows.map((w): R => ({ area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph' }))),
  ];
}

/** The list's workflow groups: one per phase of those that can run, then «Einrichten» for those that cannot yet. */
function groupsOf(view: AutomationView | undefined): Array<{ key: string; label: string; workflows: WorkflowDecl[] }> {
  const ws = view?.workflows.filter(forThisFirm) ?? [];
  return [
    ...PHASES.map((p) => ({ key: p, label: phaseLabel(p), workflows: ws.filter((w) => w.phase === p && w.runnable.ok) })),
    { key: 'setup', label: t('automation.home.setup'), workflows: ws.filter((w) => !w.runnable.ok) },
  ].filter((g) => g.workflows.length);
}

const sameRow = (a: R, b: R) => a.view === b.view && (a.view !== 'workflow' || (b.view === 'workflow' && a.workflow === b.workflow));

/** The way to where a refusal is answered, when it names a payment (refusalPayment). */
function WhyGo({ why, nav }: { why?: Refusal; nav: Nav }) {
  const to = refusalPayment(why);
  return to ? <>{' '}<button type="button" className="golink" data-testid="why-go" onClick={() => nav.go(at({ area: 'bank', payment: to.payment }, to.date))}>{t('automation.answerAtPayment')}</button></> : null;
}

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
  const now = new Date();
  const waiting = view?.tasks ?? [];
  const q = useQuestions();
  const asked = forMe(q.questions, q.me).length;
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
        {row({ area: 'automation', view: 'home' }, <><span className="t">{t('automation.home.title')}</span>{view && openCount(view) + asked ? <span className="a"><span className="wfpill warn">{t('automation.home.waitCount', { n: openCount(view) + asked })}</span></span> : null}</>)}
        {row({ area: 'automation', view: 'runs' }, <span className="t">{t('automation.home.runs')}</span>)}
        {row({ area: 'automation', view: 'map', map: 'phases' }, <span className="t">{t('automation.map')}</span>)}
        {row({ area: 'automation', view: 'queue' }, <span className="t">{t('automation.queue')}</span>)}
        {row({ area: 'automation', view: 'tasks' }, <><span className="t">{t('automation.tasks')}</span>{waiting.length + asked ? <span className="a"><span className="wfpill warn">{waiting.length + asked}</span></span> : null}</>)}
        <div className="row" role="option" aria-selected={false} tabIndex={-1} data-to="rules" onClick={() => nav.go({ route: { area: 'company', section: 'rules' }, query: {} })}><span className="t">{t('automation.toRules')}</span><span className="a">→</span></div>
        {groupsOf(view).map((g) => {
          return (
            <Fragment key={g.key}>
              <div className="group"><span>{g.label}</span>{g.key === 'setup' ? <span className="m">{t('automation.home.setupCount', { n: g.workflows.length })}</span> : null}</div>
              {g.workflows.map((w) => {
                const st = workflowState(w, view!, now);
                const on = w.triggers.filter((tr) => !tr.off);
                return row({ area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph' }, (
                  <>
                    <span className="t"><span className={`ahdot ${st.dot}`} data-tip={t(`automation.home.dot.${st.dot}` as 'automation.home.dot.ok')} />{label(w)}{hasAi(w, view!.workflows) ? <span data-tip={t('automation.ai')}><BotIcon /></span> : null}</span>
                    <span className="a">
                      {st.dot === 'off' ? <span className="wfpill muted">{t('automation.home.missing', { n: st.missing })}</span>
                        : st.dot === 'run' ? <span className="wfpill st-running">{st.at ? t('automation.home.runningAt', { step: stepLabel(w, st.at) }) : t('automation.status.running')}</span>
                        : st.open ? <span className="wfpill warn">{t('automation.openCount', { n: st.open })}</span>
                        : st.next ? <span className="wfnext mono">{whenText(st.next, now)}</span> : null}
                    </span>
                    {on.length ? <span className="wftrig">{on.map((tr, i) => <span key={i} className="trig">{TRIGGER_ICON[tr.kind]}{tr.kind === 'manual' ? tx(tr.label) : t(`automation.trig.${tr.kind}` as 'automation.trig.schedule')}</span>)}</span> : null}
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

function Detail({ route, nav, books, canEdit, query }: Props) {
  const { view } = useAutomation();
  if (!view) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  switch (route.view) {
    case 'runs': return null;
    case 'home': return <HomePage view={view} books={books} nav={nav} query={query} canEdit={canEdit} />;
    case 'workflow': {
      if (!route.workflow) return <div className="detail-empty"><div>{t('automation.pick')}</div></div>;
      const w = view.workflows.find((x) => x.id === route.workflow);
      // «/automation/rules» is where a person looks for the rules: they live under Firma › Regeln.
      if (!w && route.workflow === 'rules') return <div className="detail-empty"><div><button type="button" className="golink" onClick={() => nav.go({ route: { area: 'company', section: 'rules' }, query: {} })}>{t('automation.toRules')}</button></div></div>;
      return w ? <WorkflowPage w={w} view={view} route={route} nav={nav} /> : <div className="detail-empty"><div>{t('automation.unknown', { id: route.workflow })}</div></div>;
    }
    case 'run': return <RunPage id={route.run} view={view} nav={nav} books={books} />;
    case 'map': return <MapPage view={view} map={route.map} nav={nav} />;
    case 'queue': return <QueuePage view={view} nav={nav} />;
    case 'tasks': return <TasksPage view={view} nav={nav} run={route.run} books={books} canEdit={canEdit} />;
  }
}

function WorkflowPage({ w, view, route, nav }: { w: WorkflowDecl; view: AutomationView; route: WorkflowRoute; nav: Nav }) {
  const go = (r: Partial<WorkflowRoute>) => nav.select({ area: 'automation', view: 'workflow', workflow: w.id, tab: route.tab, ...r });
  const step = route.step ? stepOf(w, route.step) : undefined;
  return (
    <div className="detail-in wfpage" key={w.id}>
      <div className="head">
        <h2 className="who">{hasAi(w, view.workflows) ? <span data-tip={t('automation.ai')}><BotIcon /></span> : null}{label(w)}<small>{phaseLabel(w.phase)} · {tx(w.cadence)} · {forLabel(w.for)}</small></h2>
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
          <Graph workflow={w} selected={route.step} onSelect={(s) => go({ tab: 'graph', step: s })} />
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
      {line(t('automation.step.outcomes'), Object.entries(step.outcomes).map(([o, to]) => `${outcomeText(o)} → ${target(to)}`).join(' · '))}
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
      nav.toast(r.ok ? done ?? t('automation.done') : commandRefusalText(r));
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
function Took({ s, nav }: { s: StepRecord; nav: Nav }) {
  const took = (s.output?.took as Took[] | undefined) ?? [];
  const input = Object.entries(s.input).filter(([, v]) => v);
  if (!took.length && !input.length) return <p className="m">—</p>;
  return (
    <>
      {took.map((x, i) => (
        x.kind === 'files' ? <div key={i}>{t('automation.took.files', { n: x.names.length })}<ul>{x.names.map((n) => <li key={n} className="mono">{n}</li>)}</ul></div>
          : x.kind === 'receipts' ? <div key={i}>{t('automation.took.receipts', { n: x.ids.length })}<ul>{x.files.slice(0, 8).map((n) => <li key={n} className="mono">{n}</li>)}</ul></div>
          : x.kind === 'held' ? <div key={i}><Go to={at({ area: 'bank', payment: x.payment }, x.date)} nav={nav} className="golink">{t('reconcile.heldRun', { n: x.n, account: x.account })}</Go></div>
          : <div key={i}>{t('automation.took.transactions', { n: x.n })}</div>
      ))}
      {input.map(([k, v]) => <div key={k} className="mono">{k}: {k === 'period' ? periodText(v) : v}</div>)}
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
                <small>{[formatDate(x.date), fmt(x.amount), x.vatCode && codeLabel(x.vatCode), x.description].filter(Boolean).join(' · ')}</small>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }
  const rest = Object.entries(s.output ?? {}).filter(([k]) => k !== 'notes');
  if (!rest.length) return <p className="m">{s.outcome ? t('automation.made.outcome', { outcome: outcomeText(s.outcome) }) : '—'}</p>;
  return <>{rest.map(([k, v]) => <RunValue key={k} name={k} value={v} />)}</>;
}

/** A value a step hands on, in words where it has some (the return, its XML), else as data. */
function RunValue({ name, value }: { name: string; value: unknown }) {
  if (name === 'return') return <ReturnFacts ret={value as PeriodReturn} />;
  if (name === 'entries' && Array.isArray(value)) return <Proposal entries={value as JournalEntry[]} />;
  if (name === 'xml') return <XmlFile x={value as PreparedXml} />;
  if (name === 'seal') return <SealLine seal={value as SealOutput} />;
  return <div className="mono">{name}: {short(value)}</div>;
}

/** The bookings a run would make, as a person reads a booking: Soll, Haben, amount, VAT code, text. */
function Proposal({ entries }: { entries: JournalEntry[] }) {
  return (
    <div className="wfproposal" data-testid="proposal">
      {entries.map((e) => (
        <b key={e.id}>{t('automation.proposal', { booking: [`${e.accountDebit || '–'} / ${e.accountCredit || '–'}`, `${e.exchangeCurrency ?? baseCurrency()} ${fmt(e.amount)}`, e.vatCode && codeLabel(e.vatCode), e.description].filter(Boolean).join(' · ') })}</b>
      ))}
    </div>
  );
}

/** A workflow for a filing period belongs to a firm that files returns; a firm without any has no such period (r5f-12). */
const forThisFirm = (w: WorkflowDecl): boolean => w.for !== 'period' || chargesVat();

/** A box's name: a rate row by its rate (a net tax rate by its own name, never «Bezugsteuer», r6f-25), else the dictionary's name of the box, else the module's. */
function boxLabel(box: string): string {
  const row = vat().rateRows.find((r) => r.ziffer === box);
  if (row?.kind === 'net-rate') return row.name ?? t('vat.nNetRate', { name: '', rate: row.rate }).trim();
  if (row) return t(row.kind === 'supply' ? 'vat.nSupply' : 'vat.nAcquisition', { rate: row.rate });
  const key = `vat.n${box}`;
  if (isKey(key)) return tData(key);
  const f = vat().form;
  return f.deductions[box]?.label ?? f.inputTax[box]?.label ?? f.derived[box]?.label ?? (box === f.turnoverBox ? f.turnoverLabel : box);
}

function ReturnFacts({ ret }: { ret: PeriodReturn }) {
  const r = returnSummary(ret);
  const amount = `${baseCurrency()} ${fmt(r.due.amount)}`;
  return (
    <div className="wfreturn" data-testid="return-facts">
      <b>{r.due.kind === 'pay' ? t('automation.return.pay', { period: r.period, amount }) : r.due.kind === 'credit' ? t('automation.return.credit', { period: r.period, amount }) : t('automation.return.nothing', { period: r.period })}</b>
      <dl>{r.boxes.map((b) => <Fragment key={b.box}><dt><span className="mono">{b.box}</span> {boxLabel(b.box)}</dt><dd className="mono">{fmt(b.amount)}</dd></Fragment>)}</dl>
    </div>
  );
}

/**
 * Each payment provider's clearing account at the period's end (#203): its balance, its month ends
 * before, and what the provider paid out after the end within its payout days, which is what it held
 * then; the difference is found per order. A fact, never a reminder.
 */
function ClearingFacts({ checks }: { checks: ClearingCheck[] }) {
  const cur = baseCurrency();
  return (
    <>
      {checks.map((c) => {
        const until = addDays(c.through, c.payoutDays);
        // What was paid out after the end holds sales made after it too: it is the most the balance may be.
        const diff = c.paidAfter === undefined ? undefined : Math.round((c.balance - c.paidAfter) * 100) / 100;
        const key = diff === undefined ? undefined : diff > 0 ? 'automation.clearing.above' : diff === 0 ? 'automation.clearing.even' : 'automation.clearing.within';
        return (
          <div key={c.provider} className="wfreturn" data-testid="clearing-check">
            <b>{t('automation.clearing.title', { provider: c.name, account: c.account, date: formatDate(c.through), amount: `${cur} ${fmt(c.balance)}` })}</b>
            <dl>
              {c.months.map((m) => <Fragment key={m.date}><dt>{formatDate(m.date)}</dt><dd className="mono">{fmt(m.balance)}</dd></Fragment>)}
            </dl>
            <span className="m">{c.paidAfter === undefined || !key
              ? t('automation.clearing.unknown', { until: formatDate(until), known: c.known ? formatDate(c.known) : '–' })
              : t(key, { until: formatDate(until), date: formatDate(c.through), paid: `${cur} ${fmt(c.paidAfter)}`, diff: `${cur} ${fmt(Math.abs(diff ?? 0))}` })}</span>
            {c.below ? <span className="m">{t('automation.clearing.below')}</span> : null}
            {c.currency ? <span className="m">{t('automation.clearing.currency', { currency: c.currency })}</span> : null}
          </div>
        );
      })}
    </>
  );
}

/** What the seal step did: the seal's file, or that the year close seals the year's last period. */
function SealLine({ seal }: { seal: SealOutput }) {
  return <p className="m">{'yearClose' in seal ? t('automation.seal.yearClose') : t('automation.seal.written', { file: fileName(seal.file) })}</p>;
}

function XmlFile({ x }: { x: PreparedXml }) {
  const file = fileName(x.path);
  return (
    <div className="wfreturn" data-testid="xml-file">
      <span>{t('automation.xml.where', { file })}</span>
      <span className="wfactions"><a className="btn" href={api.filingXmlUrl(x.period)} download={file}>{t('automation.xml.download', { file })}</a></span>
      <span className="m">{t('automation.xml.next')}</span>
      {x.warnings.map((w) => <span key={w} className="warnline">{w}</span>)}
    </div>
  );
}

/** A note of an inbox step (src/intake/pipeline.ts IntakeNote): why it did less than it had to do. */
function noteText(n: IntakeNote): string {
  switch (n.code) {
    case 'noModel': return t(aiIsOff() ? 'automation.note.aiOff' : 'automation.note.noModel', { n: n.waiting });
    case 'failed': return t('automation.note.failed', { n: n.count, detail: n.detail });
    case 'unmatched': return t('automation.note.unmatched', { n: n.files.length, files: n.files.join(', ') });
    case 'filedKept': return t('automation.note.filedKept', { n: n.count });
    case 'poorScan': return t('automation.note.poorScan', { n: n.files.length, files: n.files.join(', ') });
    case 'sameBytes': return t('automation.note.sameBytes', { n: n.files.length, files: n.files.map((f) => `${f.file} = ${f.of}`).join(', ') });
    case 'asked': return t('automation.note.asked', { n: n.count });
    case 'saleAsked': return t('automation.note.saleAsked', { n: n.count });
    case 'waitingReceipt': return t('automation.note.waitingReceipt', { n: n.count });
    case 'receiptUnread': return t('automation.note.receiptUnread', { n: n.count });
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
  // «Verwerfen» asks first: the run ends with no further step, and after «Eingereicht» that is a decision (r8f-44).
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => setDiscarding(false), [id]);
  if (error) return <RunFromLog id={id} error={error} books={books} nav={nav} />;
  if (!data) return <div className="detail-empty"><div>{t('automation.empty')}</div></div>;
  const w = view.workflows.find((x) => x.id === data.workflow);
  const act = (cmd: AutomationCommand) => () => { void automationCommand(cmd).then((r) => { if (!r.ok) nav.toast(commandRefusalText(r)); else if (cmd.kind === 'replay' && r.run) nav.go({ route: { area: 'automation', view: 'run', run: r.run }, query: {} }); }); };
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
        {data.mode !== 'live' ? ` · ${t(data.mode === 'dry' ? 'automation.mode.dry' : 'automation.mode.replay')}` : ''}{data.reason ? ` · ${t(`automation.queuedBecause.${data.reason}` as 'automation.queuedBecause.slot')}` : ''}
      </p>
      <p className="m mono runid">{id}</p>
      {data.error ? <p className="warnline" data-testid="run-why">{refusalText(data.error, data.why)}<WhyGo why={data.why} nav={nav} /></p> : null}
      <div className="wfactions">
        {data.status === 'waiting' ? <button type="button" className="btn" onClick={() => nav.select({ area: 'automation', view: 'tasks', run: id })}>{t('automation.openTask')}</button> : null}
        {data.status === 'stuck' || data.status === 'parked' ? <button type="button" className="btn" onClick={act({ kind: 'resume', run: id })}>{t('automation.resume')}</button> : null}
        {data.status === 'done' || data.status === 'stuck' ? <button type="button" className="btn ghost" onClick={act({ kind: 'replay', run: id })}>{t('automation.replay')}</button> : null}
        <AskAi context={{ kind: 'run', id, label: t('automation.run', { id }) }} />
        {data.status !== 'done' && data.status !== 'discarded' && !discarding ? <button type="button" className="btn ghost" onClick={() => setDiscarding(true)}>{t('automation.discard')}</button> : null}
      </div>
      {discarding && data.status !== 'discarded' ? (
        <div className="ruledraft" data-testid="discard-ask">
          <span>{t('automation.discardAsk')}</span>
          <span className="ruleacts">
            <button type="button" className="btn primary" onClick={() => { setDiscarding(false); act({ kind: 'discard', run: id, reason: t('automation.discardedByPerson') })(); }}>{t('automation.discardYes')}</button>
            <button type="button" className="btn ghost" onClick={() => setDiscarding(false)}>{t('common.cancel')}</button>
          </span>
        </div>
      ) : null}
      {runDocuments(data, books).slice(0, 3).map((r) => <RunDocument key={r.id} r={r} nav={nav} />)}
      {w ? <Graph workflow={w} path={data.path} at={data.at} onSelect={(s) => nav.go({ route: { area: 'automation', view: 'workflow', workflow: w.id, tab: 'graph', step: s }, query: {} })} /> : null}
      <ol className="wfsteps">
        {data.steps.map((s, i) => {
          const decl = w ? stepOf(w, s.step) : undefined;
          return (
            <li key={`${s.step}-${i}`} className={s.error ? 'err' : s.outcome ? 'ok' : 'on'}>
              <div className="sh">
                <b>{decl ? tx(decl.label) : s.step}</b>
                {decl ? null : <span className="mono m">{s.step}</span>}
                {s.outcome ? <span className="m">→ {outcomeText(s.outcome)}</span> : null}
              </div>
              <div className="io">
                <div className="box"><small>{t('automation.io.took')}</small><Took s={s} nav={nav} /></div>
                <div className="box"><small>{t('automation.io.made')}</small><Made s={s} nav={nav} /></div>
              </div>
              {s.error ? <div className="warnline">{refusalText(s.error, s.why)}<WhyGo why={s.why} nav={nav} /></div> : null}
              {((s.output?.notes as IntakeNote[] | undefined) ?? []).map((n, j) => <div key={`n${j}`} className="warnline">{noteText(n)}</div>)}
              {s.effects.filter((e) => e.refused || (!e.applied && e.would !== undefined)).map((e, j) => (
                <div key={j} className={e.refused ? 'warnline' : 'm'}>{e.refused ? t('automation.refused', { reason: e.refused }) : Array.isArray(e.would) ? t('automation.wouldBook', { n: e.would.length }) : t('automation.skippedEffect')}</div>
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
  const m = processMap(view.workflows.filter(forThisFirm));
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
        <>
          <p className="lead">{t('automation.mapLead')}</p>
          <div className="wfmap">
            {m.phases.map((p, pi) => {
              const runs = view.runs.filter((r) => r.mode === 'live' && p.workflows.includes(r.workflow));
              const stuck = runs.filter((r) => r.status === 'stuck').length, running = runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
              const now = stuck ? t('automation.phaseStuck', { n: stuck }) : running ? t('automation.status.running') : '';
              return (
                <section key={p.phase} className="col">
                  <header className="ph"><span className="pn">{pi + 1}</span><div><b>{phaseLabel(p.phase)}</b><span className="cad">{t(`automation.phaseCad.${p.phase}` as 'automation.phaseCad.collect')}</span></div></header>
                  <p className="when">{t(`automation.phaseWhen.${p.phase}` as 'automation.phaseWhen.collect')}</p>
                  {now ? <span className="now">{now}</span> : null}
                  {p.workflows.map((id) => {
                    const w = byId(id);
                    const st = runs.filter((r) => r.workflow === id && r.status === 'stuck').length;
                    const starts = w.triggers.filter((tr) => !tr.off).map((tr) => (tr.kind === 'event' ? tr.name : tr.kind === 'manual' ? t('automation.byButton', { label: tx(tr.label) }) : tr.kind === 'schedule' ? tr.cron : t('automation.byFile')));
                    return (
                      <button key={id} type="button" className={`wfcard${w.runnable.ok ? '' : ' dim'}${st ? ' stuck' : ''}`} onClick={() => open(id)}>
                        <b>{label(w)}{hasAi(w, view.workflows) ? <BotIcon /> : null}</b>
                        <span className="cc">{tx(w.cadence)}</span>
                        {starts.length ? <span className="cl"><span>{t('automation.startsOn')}</span> {starts.join(', ')}</span> : null}
                        {w.emits.length ? <span className="cl"><span>{t('automation.reports')}</span> {w.emits.join(', ')}</span> : null}
                        {st ? <span className="wfpill warn">{t('automation.phaseStuck', { n: st })}</span> : !w.runnable.ok ? <span className="wfpill muted">{t('automation.notRunnable')}</span> : null}
                      </button>
                    );
                  })}
                  {p.phase === 'year' ? <span className="loop">{t('automation.yearLoop')}</span> : null}
                </section>
              );
            })}
          </div>
        </>
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

/** Under the return to review: what is still open in its period, each a link; it does not block (r4c-38). */
function ReturnIssues({ ret, books, nav, canEdit }: { ret: PeriodReturn; books: Index; nav: Nav; canEdit: boolean }) {
  const p = parsePeriod(ret.period, localToday());
  return (
    <>
      {ret.reviewedBefore ? <p className="warnline" data-testid="reviewed-before">{t('automation.reviewedBefore', { was: money(ret.reviewedBefore.payable, baseCurrency()), now: money(ret.payable, baseCurrency()) })}</p> : null}
      {ret.clearing?.length ? <ClearingFacts checks={ret.clearing} /> : null}
      {p ? <PeriodIssues books={books} nav={nav} from={p.from} to={p.to} period={periodName(p)} canEdit={canEdit} /> : null}
    </>
  );
}

function TasksPage({ view, nav, run, books, canEdit }: { view: AutomationView; nav: Nav; run?: string; books: Index; canEdit: boolean }) {
  const q = useQuestions();
  const asked = forMe(q.questions, q.me).length;
  const send = (task: Task, outcome: string) => { void automationCommand({ kind: 'answer', run: task.run, outcome }).then((r) => { if (!r.ok) nav.toast(commandRefusalText(r)); }); };
  const forms = useRef(new Map<string, HTMLFormElement | null>());
  const accounts = useWorkspace()?.bankAccounts ?? [];
  const booked = bookedStates(books, accounts);
  /** A payment not booked (no entry, or lines short of the payment, r9k-2): the task carries its booking form, and «Gebucht» leads there instead of claiming it. */
  const unbooked = (task: Task) => (task.item.kind === 'transaction' && books.transactions.some((x) => x.ref === task.item.id) && booked(task.item.id) !== 'booked' ? task.item.id : undefined);
  // «Eingereicht» seals the period for good: it asks once before it acts (r9n-36).
  const [confirming, setConfirming] = useState<string | undefined>();
  const answer = (task: Task, outcome: string) => () => {
    if (outcome === 'filed' && confirming !== task.run) { setConfirming(task.run); return; }
    setConfirming(undefined);
    const form = outcome === 'booked' && unbooked(task) ? forms.current.get(task.run) : undefined;
    if (!form) { send(task, outcome); return; }
    nav.toast(t('automation.bookFirst'));
    form.scrollIntoView({ block: 'nearest' });
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input')];
    (inputs.find((i) => !i.value) ?? inputs[0])?.focus();
  };
  // A payment booked elsewhere meanwhile (on its receipt, in Buchungen) settles the task that waited for its booking (r4c-30).
  const bookedMeanwhile = (task: Task) => task.item.kind === 'transaction' && task.outcomes.includes('booked') && booked(task.item.id) === 'booked';
  const settled = useRef(new Set<string>());
  useEffect(() => {
    if (!canEdit) return;
    for (const task of view.tasks) {
      if (!bookedMeanwhile(task) || settled.current.has(task.run)) continue;
      settled.current.add(task.run);
      send(task, 'booked');
    }
  });
  const tasks = view.tasks.filter((task) => !bookedMeanwhile(task));
  // A payment nobody booked waits for the person even when no run asked about it (corner-9).
  const inTasks = new Set(tasks.map(unbooked).filter(Boolean));
  // A payment that waits for its receipt is the app's work until its return comes near, then a task of its own (issue #29).
  const forReceipt = waitingForReceipt(books, (ref) => booked(ref) === 'booked', localToday());
  const receiptDue = forReceipt.filter((w) => w.kind !== 'waits');
  const held = new Set(forReceipt.map((w) => w.tx.ref));
  const waiting = unbookedPayments(books, accounts).filter((p) => !inTasks.has(p.ref) && !held.has(p.ref));
  const evidence = journalOf(books).views.some((v) => v.evidence) || !!unsettledAtFiling(journalOf(books), filing().length)?.items.length || openTwins(ledgerFor(books)).length > 0 || assessmentsMissing(books).length > 0;
  // A firm not registered whose turnover passed the threshold has a task without any run (r5f-9).
  const threshold = thresholdPassed(books, useWorkspace()?.company.vat.registered);
  return (
    <div className="detail-in wfpage">
      <div className="head"><h2 className="who">{t('automation.tasks')}</h2></div>
      <ThresholdTasks nav={nav} passed={threshold} />
      <ReceiptDueTasks items={receiptDue} nav={nav} canEdit={canEdit} books={books} />
      {tasks.length ? (
        <div className="wftasks">
          {tasks.map((task) => {
            const w = view.workflows.find((x) => x.id === task.workflow);
            const pay = canEdit ? unbooked(task) : undefined;
            const withheld = approvalWithheld(task, q.questions, books);
            return (
              <div key={task.run} className={`wftask${task.run === run ? ' sel' : ''}`}>
                <b>{fillTask(tx(task.title), task.item, readsInWords(task.reads))}{task.overdue ? <span className="wfpill st-stuck">{t('automation.overdue')}</span> : null}</b>
                <span className="m">{w ? label(w) : task.workflow} · {t('automation.since', { date: when(task.since) })}</span>
                {task.why ? <p>{fillTask(tx(task.why), task.item, readsInWords(task.reads))}</p> : null}
                {task.item.kind === 'transaction' ? (() => { const p = books.transactions.find((x) => x.ref === task.item.id); return p ? <Parts tx={p} /> : null; })() : null}
                {Object.entries(task.reads ?? {}).filter(([k]) => !tx(task.title).includes(`{${k}}`)).map(([k, v]) => <RunValue key={k} name={k} value={v} />)}
                {task.reads?.return ? <ReturnIssues ret={task.reads.return as PeriodReturn} books={books} nav={nav} canEdit={canEdit} /> : null}
                {withheld?.rates.length ? (
                  <p className="warnline" data-testid="approval-withheld">
                    {t('automation.activityIdMissing', { rates: withheld.rates.join(', ') })}{' '}
                    <button type="button" className="golink" onClick={() => nav.go({ route: { area: 'company', section: 'vat' }, query: {} })}>{t('area.company')} › {t('company.vat')}</button>
                  </p>
                ) : null}
                {withheld?.questions ? <p className="warnline" data-testid="approval-withheld-questions">{t('automation.questionsOpen', { n: withheld.questions })}</p> : null}
                {pay ? <PaymentBooking key={pay} books={books} nav={nav} payment={pay} onForm={(el) => forms.current.set(task.run, el)} onBooked={() => { if (task.outcomes.includes('booked')) send(task, 'booked'); }} /> : null}
                {pay ? (
                  <p className="m" data-testid="task-make-rule">
                    {t('rules.hand.fromTask')}{' '}
                    <Go to={{ route: { area: 'company', section: 'rules' }, query: { payment: pay } }} nav={nav} className="golink">{t('area.company')} › {t('company.rules')}</Go>
                  </p>
                ) : null}
                {confirming === task.run ? (
                  <p className="warnline" data-testid="confirm-filed">
                    {t('automation.confirmFiled', { period: String((task.reads?.return as PeriodReturn | undefined)?.period ?? task.item.id) })}{' '}
                    <button type="button" className="btn" onClick={answer(task, 'filed')}>{t('automation.confirmFiledYes')}</button>{' '}
                    <button type="button" className="btn ghost" onClick={() => setConfirming(undefined)}>{t('common.cancel')}</button>
                  </p>
                ) : null}
                <span className="wfactions">
                  {task.do === 'open-login' && task.item.kind === 'source' ? <button type="button" className="btn ghost" data-testid="task-sign-in" onClick={() => { api.signInSource(task.item.id).then(() => nav.toast(t('sources.signInOpened')), (e: unknown) => nav.toast(errorText(e))); }}>{t('sources.signIn')}</button> : null}
                  {task.do === 'open-item' && itemRoute(task.item) ? <button type="button" className="btn ghost" onClick={() => nav.go({ route: itemRoute(task.item)!, query: {} })}>{t('automation.openItem')}</button> : null}
                  {task.outcomes.filter((o) => o !== withheld?.outcome && !(o === 'filed' && confirming === task.run)).map((o) => <button key={o} type="button" className="btn" onClick={answer(task, o)}>{tData(`automation.outcome.${o}`)}</button>)}
                  <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: task.run }, query: {} })}>{t('automation.run', { id: task.run })}</button>
                </span>
              </div>
            );
          })}
        </div>
      ) : asked || waiting.length || evidence || threshold.length || receiptDue.length ? null : <p className="lead">{t('automation.tasksEmpty')}</p>}
      <EvidenceTasks books={books} nav={nav} canEdit={canEdit} />
      <FiledEvidence books={books} nav={nav} />
      <TwinTasks books={books} nav={nav} canEdit={canEdit} />
      <AssessmentTasks books={books} nav={nav} />
      {waiting.length > 0 && (
        <section className="wfunbooked" data-testid="unbooked-payments">
          <h3>{t('automation.unbookedTitle', { n: waiting.length })}</h3>
          <p className="m">{t('automation.unbookedLead')}</p>
          <ul>
            {waiting.map((p) => (
              <li key={p.ref}>
                <button type="button" className="linkbtn" data-pay={p.ref} onClick={() => nav.go(at({ area: 'bank', payment: p.ref }, p.date))}>
                  <span className="mono">{formatDate(p.date)}</span> {payText(p).name} <span className="mono">{p.currency} {fmt(signed(p))}</span>
                </button>
                {p.waitsForPerson && <span className="m"> · {t('automation.unbookedWaits')}</span>}
                {reconciliationOf(books, p.ref) ? <> · <Go to={at({ area: 'bank', payment: p.ref }, p.date)} nav={nav} className="golink">{t('reconcile.held')}</Go></> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      <QuestionTasks nav={nav} canEdit={canEdit} books={books} />
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
  // What waits for the person is the dock widget's count (src/app/automation/widget.ts), not a badge.
  dock: { key: 'w', icon: ICONS.automation, tip: () => t('area.automation.tip') },
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
