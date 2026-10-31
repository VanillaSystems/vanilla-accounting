/**
 * Automatisierung's home, the Leitstand (docs/0.4.0/mockups/automation-leitstand.html): what the
 * app did with the period's receipts, from collected to filed; what waits for the person, answered
 * here with the same commands as Aufgaben; what runs now and what starts next. The figures come
 * from src/app/automation/home.ts, never from this component.
 */
import type { ReactNode } from 'react';
import { language, t } from '../../i18n/index.js';
import { formatDate } from '../../lib/utils.js';
import { periodName, rangeText } from '../../lib/period-label.js';
import { automationCommand } from '../../automation/store.js';
import { commandRefusalText, refusalText } from '../../automation/refusal.js';
import { askedRuns, homeFigures, workflowState, type HomeFigures } from '../../automation/home.js';
import { useQuestions } from '../../questions/store.js';
import { QuestionCard } from '../../questions/Questions.js';
import { forMe } from '../../../questions/model.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { booksOpenPeriod, filingKeyOf, isFilingKey, localToday, parsePeriod, type Period } from '../../../accounting/periods.js';
import { chargesVat, filing } from '../../../engines/index.js';
import { fillTask, stepOf, textIn, type AutomationView, type Task, type Text } from '../../../workflows/model.js';
import type { Index } from '../../../types/index.js';
import type { Location, Query } from '../../shell/route.js';
import type { Nav } from '../index.js';
import { Go } from '../vat/links.js';
import { approvalWithheld } from './filing-summary.js';
import { readsInWords } from './words.js';

const tx = (v: Text) => textIn(v, language());
const pad = (n: number) => String(n).padStart(2, '0');

/** «heute 06:00», «morgen 06:00», else «24.10. 06:00». */
export function whenText(d: Date, now: Date): string {
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return t('automation.home.today', { time });
  if (d.toDateString() === tomorrow.toDateString()) return t('automation.home.tomorrow', { time });
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${time}`;
}

/** The filing period the link names, else the one the work is on. */
function shownPeriod(query: Query, books: Index, today: string): Period {
  const length = filing().length;
  const named = query.period && isFilingKey(query.period.token, length) ? query.period : undefined;
  return named ?? booksOpenPeriod(books, today, length);
}

/** The filing periods of the shown year and the year before that have begun. */
function periodsAround(p: Period, today: string): Period[] {
  const length = filing().length;
  const year = Number(p.from.slice(0, 4));
  const keys = [year - 1, year].flatMap((y) => Array.from({ length: 12 }, (_, m) => filingKeyOf(`${y}-${pad(m + 1)}-01`, length)));
  return [...new Set(keys)].map((k) => parsePeriod(k, today)!).filter((x) => x.from <= today);
}

/** The outcomes a click may send from here: the filing (which asks first), a booking still to make and a withheld approval wait in Aufgaben. */
function quickOutcomes(task: Task, books: Index, booked: (ref: string) => string, withheld?: string): string[] {
  const unbooked = task.item.kind === 'transaction' && books.transactions.some((x) => x.ref === task.item.id) && booked(task.item.id) !== 'booked';
  return task.outcomes.filter((o) => o !== 'filed' && o !== withheld && !(o === 'booked' && unbooked));
}

export function HomePage({ view, books, nav, query, canEdit }: { view: AutomationView; books: Index; nav: Nav; query: Query; canEdit: boolean }) {
  const q = useQuestions();
  const ws = useWorkspace();
  const today = localToday();
  const now = new Date();
  const period = shownPeriod(query, books, today);
  const vatRegistered = chargesVat();
  const f = homeFigures(books, { key: period.token, from: period.from, to: period.to }, { today, vatRegistered, dueDays: filing().dueDays }, askedRuns(view));
  const asked = forMe(q.questions, q.me);
  const stuck = view.runs.filter((r) => r.status === 'stuck');
  const waiting = view.tasks.length + stuck.length + asked.length;
  const running = view.runs.filter((r) => r.mode === 'live' && (r.status === 'running' || r.status === 'queued' || r.status === 'parked'));
  const next = view.workflows.flatMap((w) => { const s = workflowState(w, view, now); return s.next ? [{ w, at: s.next }] : []; }).sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, 4);
  const booked = bookedStates(books, ws?.bankAccounts ?? []);
  const label = (id: string) => { const w = view.workflows.find((x) => x.id === id); return w ? tx(w.label) : id; };
  const at = (to: Location['route'], extra: Partial<Query> = {}): Location => ({ route: to, query: { period, ...extra } });
  const send = (task: Task, outcome: string) => () => { void automationCommand({ kind: 'answer', run: task.run, outcome }).then((r) => { if (!r.ok) nav.toast(commandRefusalText(r)); }); };
  const fresh = f.collected === 0 && !view.runs.some((r) => r.mode === 'live');

  return (
    <div className="detail-in ahome" data-testid="automation-home">
      <div className="kicker">
        <select aria-label={t('automation.home.period')} value={period.token} onChange={(e) => nav.setQuery({ ...query, period: parsePeriod(e.target.value, today) ?? undefined })}>
          {periodsAround(period, today).map((p) => <option key={p.token} value={p.token}>{periodName(p)}</option>)}
        </select>
        <span>{rangeText(period.from, period.to)}</span>
      </div>
      <Hero f={f} period={period} waiting={waiting} />
      {fresh ? (
        <p className="lead" data-testid="home-empty">
          {t('automation.home.emptyLead')}{' '}
          <Go to={at({ area: 'receipts' })} nav={nav} className="golink">{t('area.receipts')}</Go>{' · '}
          <Go to={{ route: { area: 'company', section: 'sources' }, query: {} }} nav={nav} className="golink">{t('area.company')} › {t('company.sources')}</Go>
        </p>
      ) : null}
      <Stages f={f} nav={nav} at={at} vatRegistered={vatRegistered} />
      <div className="cols">
        <section>
          <h3 className="h3">{t('automation.home.waiting')} <small>{t('automation.home.waitingLead')}</small></h3>
          {view.tasks.map((task) => {
            const withheld = approvalWithheld(task, q.questions, books)?.outcome;
            const quick = canEdit ? quickOutcomes(task, books, booked, withheld) : [];
            return (
              <div key={task.run} className="task hot" data-testid="home-task">
                <b>{fillTask(tx(task.title), task.item, readsInWords(task.reads))}</b>
                <span className="acts">
                  {quick.map((o) => <button key={o} type="button" className={o === 'accept' ? 'btn primary' : 'btn'} onClick={send(task, o)}>{t(`automation.outcome.${o}` as 'automation.outcome.accept')}</button>)}
                  <Go to={{ route: { area: 'automation', view: 'tasks', run: task.run }, query: {} }} nav={nav} className="btn ghost">{t('automation.home.open')}</Go>
                </span>
                <span className="d">{label(task.workflow)} · {t('automation.since', { date: formatDate(task.since.slice(0, 10)) })}</span>
              </div>
            );
          })}
          {stuck.map((r) => (
            <div key={r.id} className="task hot" data-testid="home-stuck">
              <b>{t('automation.home.stuck', { workflow: label(r.workflow) })}</b>
              <span className="acts"><Go to={{ route: { area: 'automation', view: 'run', run: r.id }, query: {} }} nav={nav} className="btn ghost">{t('automation.home.open')}</Go></span>
              <span className="d">{refusalText(r.error, r.why)}</span>
            </div>
          ))}
          {asked.map((x) => <QuestionCard key={x.id} q={x} nav={nav} canEdit={canEdit} books={books} showItem />)}
          {waiting ? null : <p className="m">{t('automation.tasksEmpty')}</p>}
          <p><Go to={{ route: { area: 'automation', view: 'tasks' }, query: {} }} nav={nav} className="golink">{t('automation.home.allTasks')} →</Go></p>
        </section>
        <section>
          <h3 className="h3">{t('automation.home.running')}</h3>
          {running.length ? (
            <ul className="next">
              {running.map((r) => {
                const w = view.workflows.find((x) => x.id === r.workflow);
                const step = w && r.at ? stepOf(w, r.at) : undefined;
                return (
                  <li key={r.id}>
                    <span className="when"><span className="ahdot run" />{r.status === 'running' ? t('automation.status.running') : t('automation.status.queued')}</span>
                    <Go to={{ route: { area: 'automation', view: 'run', run: r.id }, query: {} }} nav={nav} className="golink">{label(r.workflow)}{step ? ` · ${tx(step.label)}` : ''}</Go>
                  </li>
                );
              })}
            </ul>
          ) : <p className="m">{t('automation.home.nothingRuns')}</p>}
          <h3 className="h3">{t('automation.home.next')}</h3>
          {view.paused ? <p className="m">{t('automation.home.paused')}</p> : next.length ? (
            <ul className="next">
              {next.map(({ w, at: when }) => (
                <li key={w.id}>
                  <span className="when">{whenText(when, now)}</span>
                  <Go to={{ route: { area: 'automation', view: 'workflow', workflow: w.id, tab: 'triggers' }, query: {} }} nav={nav} className="golink">{tx(w.label)}</Go>
                </li>
              ))}
            </ul>
          ) : <p className="m">{t('automation.home.noSchedule')}</p>}
        </section>
      </div>
    </div>
  );
}

function Hero({ f, period, waiting }: { f: HomeFigures; period: Period; waiting: number }) {
  const known = f.booked - f.authors.unknown;
  return (
    <>
      <p className="hero" data-testid="home-hero">
        {f.collected === 0 ? t('automation.home.hero.empty', { period: periodName(period) }) : (
          <>
            {t('automation.home.hero.collected', { n: f.collected })}, {t('automation.home.hero.booked', { n: f.booked })}
            {f.withoutYou !== undefined ? <>, {t('automation.home.hero.share', { pct: f.withoutYou })}</> : null}.
          </>
        )}
        {' '}{waiting ? <span className="w">{t('automation.home.hero.waiting', { n: waiting })}</span> : t('automation.tasksEmpty')}
      </p>
      {f.booked > 0 && f.authors.unknown > 0 ? (
        <p className="m footnote" data-testid="home-unknown">{known > 0 ? t('automation.home.unknown', { n: f.authors.unknown }) : t('automation.home.unknownAll')}</p>
      ) : null}
    </>
  );
}

function Stages({ f, nav, at, vatRegistered }: { f: HomeFigures; nav: Nav; at: (r: Location['route'], extra?: Partial<Query>) => Location; vatRegistered: boolean }) {
  const unread = f.collected - f.read;
  const unmatched = f.payable - f.matched;
  const unbooked = f.matched - f.booked;
  const known = f.booked - f.authors.unknown;
  const filing = f.filing;
  const stage = (key: string, count: number | undefined, sub: ReactNode, to: Location, hit = false) => (
    <Go key={key} to={to} nav={nav} className={`stage${hit ? ' hit' : ''}`}>
      <span className="k">{t(`automation.home.stage.${key}` as 'automation.home.stage.collected')}</span>
      <b className={count === undefined ? 'none' : ''}>{count ?? '–'}</b>
      <span className={`s${hit ? ' stuck' : ''}`}>{sub}</span>
    </Go>
  );
  return (
    <div className="line" data-testid="home-stages">
      {stage('collected', f.collected, t('automation.home.s.byDate'), at({ area: 'receipts' }))}
      {stage('read', f.read, unread ? t('automation.home.s.unread', { n: unread }) : vatRegistered && f.read ? t('automation.home.s.vat', { n: f.withVat }) : f.read ? t('automation.home.s.allRead') : '', at({ area: 'receipts' }, unread ? { chips: [{ field: 'state', value: 'noDate' }] } : {}), unread > 0)}
      {stage('matched', f.matched, unmatched ? t('automation.home.s.unmatched', { n: unmatched }) : f.payable ? t('automation.home.s.allMatched') : '', at({ area: 'receipts' }, { chips: [{ field: 'state', value: unmatched ? 'open' : 'linked' }] }), unmatched > 0)}
      {stage('booked', f.booked, [unbooked ? t('automation.home.s.unbooked', { n: unbooked }) : known > 0 ? t('automation.home.s.withoutYou', { n: f.authors.app }) : '', f.waitingReceipt ? t('automation.home.s.waitingReceipt', { n: f.waitingReceipt }) : ''].filter(Boolean).join(' · '), at({ area: 'journal' }), unbooked > 0)}
      {stage(vatRegistered ? 'filed' : 'closed', filing.kind === 'filed' ? f.booked : undefined,
        filing.kind === 'filed' ? t(vatRegistered ? 'automation.home.s.filed' : 'automation.home.s.sealed')
          : filing.kind === 'running' ? t('automation.home.s.runsUntil', { date: formatDate(filing.ends) })
          : filing.due ? t(filing.overdue ? 'automation.home.s.overdue' : 'automation.home.s.due', { date: formatDate(filing.due) })
          : t('automation.home.s.notSealed'),
        vatRegistered ? at({ area: 'vat' }) : { route: { area: 'close' }, query: {} }, filing.kind === 'due' && filing.overdue)}
    </div>
  );
}
