/**
 * Wissen (docs/0.4.0/knowledge.md): how the company works, one prose page per topic (Arbeitsweise),
 * beside Lücken, where the app could not go on alone in the open year, and Von der App, what the app
 * knows for every company, read only. A topic page has a partner page's shape without its links:
 * the notes, the company rules of the steps it names, and the details folded away.
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { formatDate } from '../../lib/utils.js';
import { moveKey } from '../../shell/keyboard.js';
import { ListHead } from '../../shell/ListHead.js';
import type { Location, Route, RouteOf } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { TopicRow } from '../../../knowledge/notes.js';
import { DECIDERS, type AppLayerView, type GapsView } from '../../../knowledge/wissen.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import { at } from '../receipts/view.js';
import { once, refreshKnowledge, useFetched } from '../partners/data.js';
import { topicRules } from '../partners/model.js';
import { CHEV, DetailGroup, DetailsBlock, Go, linesOf, NotesBlock, SelfBlock } from '../partners/page.js';
import { readRules } from '../partners/partners.js';
import './knowledge.css';

type Props = AreaProps<RouteOf<'knowledge'>>;

const readTopics = once('topics', api.topics);
const readGaps = once('gaps', api.knowledgeGaps);

/** The pages as last listed, in ↑↓ order, for the keys, ⌘K and the tab title. */
const listed = { routes: [] as Route[], topics: [] as TopicRow[] };
const keyOf = (r: RouteOf<'knowledge'>) => ('topic' in r ? `t:${r.topic}` : r.page ?? '');

const uiListeners = new Set<() => void>();
let adding = false;
const setAdding = (v: boolean) => { adding = v; uiListeners.forEach((l) => l()); };
const useAdding = () => useSyncExternalStore((fn) => { uiListeners.add(fn); return () => { uiListeners.delete(fn); }; }, () => adding);

function List({ route, period, books, nav, canEdit }: Props) {
  const ws = useWorkspace();
  const topics = useFetched('topics', readTopics);
  const gaps = useFetched('gaps', readGaps);
  const ts = topics.state === 'ready' ? topics.data : [];
  listed.topics = ts;
  listed.routes = [{ area: 'knowledge', page: 'gaps' }, { area: 'knowledge', page: 'app' }, ...ts.map((x): Route => ({ area: 'knowledge', topic: x.slug }))];
  const sel = keyOf(route);
  useEffect(() => { if (!sel) nav.select({ area: 'knowledge', page: 'gaps' }); }, [sel]);
  const open = gaps.state === 'ready' ? gaps.data.open.reduce((n, x) => n + x.count, 0) + gaps.data.asked : 0;
  const row = (k: string, r: Route, label: string, side: string, cls = '') => (
    <div key={k} className={`row fset ${cls}${sel === k ? ' sel' : ''}`} role="option" aria-selected={sel === k} tabIndex={sel === k ? 0 : -1} data-page={k} onClick={() => nav.select(r)}>
      <span className="t">{label}</span><span className="a mono">{side}</span>
    </div>
  );
  return (
    <div className="page kw">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts"><span>{ws ? t('knowledge.howWeWork', { company: ws.company.name }) : ''}</span></div>
      </ListHead>
      <div className="rows" role="listbox" aria-label={t('area.knowledge')}>
        {row('gaps', { area: 'knowledge', page: 'gaps' }, t('knowledge.gaps'), open ? t('knowledge.openN', { n: open }) : '', open ? 'kwwarn' : '')}
        {row('app', { area: 'knowledge', page: 'app' }, t('knowledge.app'), t('knowledge.readOnly'))}
        <div className="group"><span>{t('knowledge.topics')}</span><span className="mono">{ts.length || ''}</span></div>
        {topics.state === 'failed' ? <p className="warnline">{topics.error}</p> : null}
        {ts.map((x) => row(`t:${x.slug}`, { area: 'knowledge', topic: x.slug }, x.title, ''))}
        {topics.state === 'ready' && !ts.length ? <p className="m kwnone">{t('knowledge.noTopics')}</p> : null}
        {canEdit ? <NewPage nav={nav} /> : null}
      </div>
    </div>
  );
}

/** «Neue Seite»: a title, and the page is there to write. */
function NewPage({ nav }: { nav: Nav }) {
  const open = useAdding();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <p className="kwnew"><button type="button" className="btn ghost" data-act="new-page" onClick={() => setAdding(true)}>{ICONS.plus}{t('knowledge.newPage')}</button></p>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { nav.toast(t('knowledge.newPage.needsTitle')); return; }
    setBusy(true);
    try {
      const r = await api.saveNote({ kind: 'save', ref: { kind: 'topic' }, text: '', basis: 'none', title: title.trim() });
      setAdding(false);
      setTitle('');
      refreshKnowledge();
      if (r.ref.kind === 'topic') nav.select({ area: 'knowledge', topic: r.ref.slug });
      nav.toast(t('knowledge.newPage.created'));
    } catch (err) {
      nav.toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="kwnewform" onSubmit={(e) => void submit(e)}>
      <label><span className="m">{t('knowledge.newPage.title')}</span>
        <input type="text" value={title} autoFocus placeholder={t('knowledge.newPage.placeholder')} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }} />
      </label>
      <span className="kwnacts">
        <button type="submit" className="btn primary" disabled={busy}>{t('knowledge.newPage.create')}</button>
        <button type="button" className="btn ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
      </span>
    </form>
  );
}

function Detail(props: Props) {
  const { route } = props;
  if ('topic' in route) return <TopicPage {...props} slug={route.topic} />;
  if (route.page === 'app') return <AppPage {...props} />;
  if (route.page === 'gaps') return <GapsPage {...props} />;
  return <div className="detail-empty"><div>{t('knowledge.select')}</div></div>;
}

function Page({ title, small, children }: { title: string; small: string; children: ReactNode }) {
  return (
    <div className="detail-in kw">
      <div className="head"><h2 className="who">{title}<small>{small}</small></h2></div>
      <div className="docbody">{children}</div>
    </div>
  );
}

function TopicPage({ slug, nav, canEdit }: Props & { slug: string }) {
  const load = useFetched(`topic:${slug}`, () => api.topic(slug));
  const rules = useFetched('rules', readRules);
  if (load.state === 'loading') return <div className="detail-empty"><div>{t('partners.loading')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{load.error}</div></div>;
  const n = load.data.note;
  const lines = rules.state === 'ready' ? topicRules(linesOf(rules.data), n.steps) : [];
  const steps = n.steps.join(', ');
  return (
    <Page title={n.title ?? slug} small={steps ? t('knowledge.topic.smallSteps', { steps }) : t('knowledge.topics')}>
      <NotesBlock key={`${slug}:${n.basis}`} note={n} target={{ kind: 'topic', slug }} title={n.title} canEdit={canEdit} nav={nav} empty={t('knowledge.topic.empty')} />
      <SelfBlock lines={lines} canEdit={canEdit} nav={nav} empty={steps ? t('knowledge.topic.noRules', { steps }) : t('knowledge.topic.noSteps')} />
      <DetailsBlock lead={t('knowledge.topic.detailsLead')}>
        <DetailGroup title={t('knowledge.topic.steps')} items={n.steps.map((s) => <span className="mono">{s}</span>)} />
        <DetailGroup title={t('partners.details.files')} items={[<span className="mono">{n.path}</span>]} />
        <DetailGroup title={t('partners.details.notes')} items={lines.filter((l) => !l.acts).map((l) => <>{l.line}</>)} />
      </DetailsBlock>
    </Page>
  );
}

const pct = (n: number, of: number) => (of ? Math.round((n * 100) / of) : 0);

function GapsPage(props: Props) {
  const { nav, period, canEdit } = props;
  const load = useFetched('gaps', readGaps);
  if (load.state === 'loading') return <div className="detail-empty"><div>{t('partners.loading')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{load.error}</div></div>;
  const g: GapsView = load.data;
  const booked = g.payments - g.unbooked;
  const open = g.open.reduce((n, x) => n + x.count, 0);
  const payAt = (ref: string, date: string): Location => at({ area: 'bank', payment: ref }, date, period);
  return (
    <Page title={t('knowledge.gaps')} small={t('knowledge.gaps.small', { year: g.year })}>
      <p className="lead">{t('knowledge.gaps.lead')}</p>
      <div className="kwstats">
        <div className="kwstat"><b>{booked} / {g.payments}</b><span>{t('knowledge.gaps.bookedOf')}</span></div>
        <div className="kwstat"><b>{g.decided.rule}</b><span>{t('knowledge.gaps.byRule')}</span></div>
        <div className="kwstat"><b>{g.unroutedTotal}</b><span>{t('knowledge.gaps.noPartnerN')}</span></div>
        <div className="kwstat"><b>{open}</b><span>{t('knowledge.gaps.openQuestions')}</span></div>
      </div>
      <section className="kwsec">
        <header><h3>{t('knowledge.gaps.decided', { year: g.year })}</h3><span className="m">{t('knowledge.gaps.decidedLead', { n: booked })}</span></header>
        <table className="kwtable"><tbody>
          {DECIDERS.map((d) => (
            <tr key={d} data-decider={d}><td>{t(`knowledge.decider.${d}`)}</td><td className="num">{g.decided[d]}</td><td className="num m">{pct(g.decided[d], booked)} %</td></tr>
          ))}
        </tbody></table>
      </section>
      <section className="kwsec">
        <header><h3>{t('knowledge.gaps.open')}</h3>
          <Go className="linkbtn" nav={nav} to={{ route: { area: 'automation', view: 'tasks' }, query: {} }}>{t('knowledge.gaps.toTasks')}</Go>
        </header>
        {g.asked ? <p className="m">{t('knowledge.gaps.asked', { n: g.asked })}</p> : null}
        {g.open.length ? (
          <ul className="kwgaplist">
            {g.open.map((o) => (
              <li key={o.partner ?? '-'}>
                {o.partner ? <Go nav={nav} to={{ route: { area: 'partners', id: o.partner }, query: {} }}>{o.name}</Go> : <span>{t('knowledge.gaps.noPartner')}</span>}
                <span className="mono">{t('knowledge.gaps.questionsN', { n: o.count })}</span>
              </li>
            ))}
          </ul>
        ) : !g.asked ? <p className="m">{t('knowledge.gaps.openNone')}</p> : null}
      </section>
      <section className="kwsec">
        <header><h3>{t('knowledge.gaps.unrouted')}</h3><span className="n">{g.unroutedTotal}</span></header>
        <p className="m">{t('knowledge.gaps.unroutedLead')}</p>
        {g.unrouted.length ? (
          <ul className="kwgaplist">
            {g.unrouted.map((x) => (
              <li key={x.merchant}>
                <span className="kwgt"><b>{x.merchant}</b><span className="m">{t('knowledge.gaps.times', { n: x.count })} · <Go className="linkbtn" nav={nav} to={payAt(x.example, x.date)}>{t('knowledge.gaps.example', { date: formatDate(x.date) })}</Go></span></span>
                {canEdit ? <Go className="btn ghost" nav={nav} to={{ route: { area: 'company', section: 'rules' }, query: { payment: x.example } }}>{t('knowledge.gaps.makeRule')}</Go> : null}
              </li>
            ))}
          </ul>
        ) : <p className="m">{t('knowledge.gaps.unroutedNone', { year: g.year })}</p>}
        {g.unroutedTotal > g.unrouted.reduce((n, x) => n + x.count, 0) ? <p className="m">{t('knowledge.gaps.moreTexts')}</p> : null}
      </section>
    </Page>
  );
}

function AppPage({ nav }: Props) {
  const load = useFetched('app', api.knowledgeApp);
  if (load.state === 'loading') return <div className="detail-empty"><div>{t('partners.loading')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{load.error}</div></div>;
  const v: AppLayerView = load.data;
  return (
    <Page title={t('knowledge.app')} small={t('knowledge.app.small')}>
      <p className="lead">{t('knowledge.app.lead')}</p>
      <section className="kwsec">
        <header><h3>{t('knowledge.app.partners')}</h3><span className="m">{t('knowledge.app.partnersLead')}</span></header>
        <div className="kwlist">
          {v.partners.map((p) => (
            <details key={p.id} className="kwapp">
              <summary>{CHEV}<b>{p.name}</b><span className="m">{t(`partners.role.${p.role}`)}{p.notes.length ? ` · ${t('knowledge.app.sentences', { n: p.notes.length })}` : ''}</span>
                {p.known ? <Go className="linkbtn" nav={nav} to={{ route: { area: 'partners', id: p.id }, query: {} }}>{t('knowledge.app.yours')}</Go> : null}
              </summary>
              <ul>
                {p.notes.map((n) => <li key={`${n.step}#${n.id}`}>{n.when ? `${n.when} → ` : ''}{n.then}</li>)}
                {p.facts.map((f) => <li key={f.id}>{f.fact}</li>)}
                {!p.notes.length && !p.facts.length ? <li className="m">{t('knowledge.app.onlyMatch')}</li> : null}
              </ul>
            </details>
          ))}
        </div>
      </section>
      <section className="kwsec">
        <header><h3>{t('knowledge.app.processes')}</h3><span className="m">{t('knowledge.app.processesLead')}</span></header>
        <div className="kwlist">
          {v.processes.map((p) => (
            <details key={p.file} className="kwapp">
              <summary>{CHEV}<b>{p.process}</b><span className="m">{t('knowledge.app.steps', { n: p.steps.length })}</span></summary>
              {p.steps.map((s) => (
                <div key={s.id} className="kwstep">
                  <h4>{s.id}</h4>
                  {s.goal ? <p>{s.goal}</p> : null}
                  <ul>{s.rules.map((r) => <li key={r.id}>{r.when ? `${r.when} → ` : ''}{r.then}</li>)}</ul>
                </div>
              ))}
            </details>
          ))}
        </div>
      </section>
    </Page>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('keys.selectTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

const titleOf = (r: RouteOf<'knowledge'>): string | undefined =>
  ('topic' in r ? listed.topics.find((x) => x.slug === r.topic)?.title ?? r.topic : r.page === 'gaps' ? t('knowledge.gaps') : r.page === 'app' ? t('knowledge.app') : undefined);

export const knowledge: Area<RouteOf<'knowledge'>> = {
  id: 'knowledge',
  label: () => t('area.knowledge'),
  dock: { key: 'e', icon: ICONS.knowledge, tip: () => t('area.knowledge.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: titleOf,
  palette: ({ nav }) => listed.routes.map((r) => ({ label: titleOf(r as RouteOf<'knowledge'>) ?? '', side: t('area.knowledge'), run: () => nav.go({ route: r, query: {} }) })),
  keys(e, p) {
    const d = moveKey(e);
    if (!d) return false;
    const keys = listed.routes.map((r) => keyOf(r as RouteOf<'knowledge'>));
    const i = keys.indexOf(keyOf(p.route));
    const next = listed.routes[Math.min(keys.length - 1, Math.max(0, i + d))];
    if (next) p.nav.select(next);
    return true;
  },
};
